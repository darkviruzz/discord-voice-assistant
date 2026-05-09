import { randomUUID } from 'crypto';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { sessions } from './state.js';
import { drainBuffer } from './uplink.js';
import { detectWakeWord } from './wakeword.js';
import { transcribe } from './stt.js';
import { chat } from './llm.js';
import { synthesizeStream } from './tts.js';
import { StreamingAudioPipeline } from './audio.js';
import { MAGIC_DNLK, buildFrame } from './protocol.js';
import { log, warn, debug } from './logger.js';
import { broadcastToAllBots } from './broadcast.js';
import opus from '@discordjs/opus';

const { OpusEncoder } = opus;

// ── Stop-command detection ───────────────────────────────────────────────────

// Matches German stop commands, with or without the wake word in front.
const STOP_RE = /\b(stopp?|aufhören|halt(e)?\s*(ein|an)?|abbrechen|beenden)\b/i;

function isStopCommand(text) {
  return STOP_RE.test(text);
}

// ── Audio helpers ────────────────────────────────────────────────────────────

function opusFramesToPcm(opusBuffers) {
  const dec = new OpusEncoder(48000, 1);
  return Buffer.concat(opusBuffers.map(b => dec.decode(b)));
}

// Build a minimal 44-byte WAV header around a PCM buffer.
function pcmToWav(pcm, sampleRate = 48000, channels = 1, bitDepth = 16) {
  const byteRate   = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);        hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write('WAVE', 8);        hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);   hdr.writeUInt16LE(1,          20); // PCM
  hdr.writeUInt16LE(channels, 22); hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(byteRate, 28); hdr.writeUInt16LE(blockAlign, 32);
  hdr.writeUInt16LE(bitDepth, 34);
  hdr.write('data', 36);       hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}

// ── Long-audio transcription helpers ────────────────────────────────────────

const FRAME           = 960;        // 20 ms @ 48 kHz
const SILENCE_FRAMES  = 15;         // 300 ms continuous silence → split candidate
const MIN_CHUNK       = 48000 * 10; // 10 s minimum speech before a natural split
const MAX_CHUNK       = 48000 * 30; // 30 s hard cap
const OVERLAP_SAMPLES = 48000 *  2; // 2 s overlap used only in the no-silence fallback

function frameRms(pcm, sampleOffset) {
  let sum = 0;
  for (let i = 0; i < FRAME; i++) {
    const s = pcm.readInt16LE((sampleOffset + i) * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / FRAME);
}

// Split PCM at natural pauses (≥ 300 ms RMS silence).
// Returns { pcm: Buffer, hasOverlap: boolean }[].
//   hasOverlap=false — clean silence split (silence discarded).
//   hasOverlap=true  — forced split with 2 s overlap; stitchOverlap() should merge with previous.
function splitAtSilence(pcm) {
  const totalSamples = pcm.length / 2;
  if (totalSamples <= MAX_CHUNK) return [{ pcm, hasOverlap: false }];

  const thresh = Number(process.env.STT_SILENCE_THRESH ?? 300);
  const chunks = [];
  let chunkStart    = 0;
  let silenceStart  = -1;
  let silenceFrames = 0;
  // Best (longest) silence region seen in the current chunk window.
  let bestSilStart  = -1;
  let bestSilEnd    = -1;
  let bestSilDur    = 0;
  let nextHasOverlap = false;

  for (let off = 0; off + FRAME <= totalSamples; off += FRAME) {
    const rms = frameRms(pcm, off);

    if (rms < thresh) {
      if (silenceStart < 0) silenceStart = off;
      silenceFrames++;
    } else {
      // Speech frame — silence region just ended (if any).
      if (silenceFrames >= SILENCE_FRAMES) {
        // Track the longest silence seen for the current chunk.
        if (silenceFrames > bestSilDur) {
          bestSilStart = silenceStart;
          bestSilEnd   = off;
          bestSilDur   = silenceFrames;
        }
        // Natural split: enough speech before this silence.
        if ((silenceStart - chunkStart) >= MIN_CHUNK) {
          chunks.push({ pcm: pcm.subarray(chunkStart * 2, silenceStart * 2), hasOverlap: nextHasOverlap });
          nextHasOverlap = false;
          chunkStart     = off;
          bestSilStart   = -1; bestSilEnd = -1; bestSilDur = 0;
        }
      }
      silenceStart  = -1;
      silenceFrames = 0;
    }

    // Hard cap: chunk has grown to MAX_CHUNK.
    if ((off + FRAME - chunkStart) >= MAX_CHUNK) {
      if (bestSilStart >= 0) {
        // Split at the longest silence found — best boundary available.
        chunks.push({ pcm: pcm.subarray(chunkStart * 2, bestSilStart * 2), hasOverlap: nextHasOverlap });
        nextHasOverlap = false;
        chunkStart     = bestSilEnd; // skip silence
      } else {
        // No qualifying silence at all — forced split with 2 s overlap.
        const splitAt = off + FRAME;
        chunks.push({ pcm: pcm.subarray(chunkStart * 2, splitAt * 2), hasOverlap: nextHasOverlap });
        nextHasOverlap = true; // next chunk carries the overlap flag
        chunkStart     = Math.max(0, splitAt - OVERLAP_SAMPLES);
      }
      silenceStart = -1; silenceFrames = 0;
      bestSilStart = -1; bestSilEnd    = -1; bestSilDur = 0;
    }
  }

  if (chunkStart * 2 < pcm.length) {
    chunks.push({ pcm: pcm.subarray(chunkStart * 2), hasOverlap: nextHasOverlap });
  }
  return chunks.length > 0 ? chunks : [{ pcm, hasOverlap: false }];
}

// Soft word-boundary deduplication for the 2 s overlap fallback.
// Tries 3→1 word matches at the end of t1 / start of t2.
// On match: removes duplicated words from start of t2.
// On no match: keeps all words (avoids creating artifacts).
function stitchOverlap(t1, t2) {
  const w1 = t1.trim().split(/\s+/);
  const w2 = t2.trim().split(/\s+/);
  for (let len = 3; len >= 1; len--) {
    if (w1.length >= len && w2.length >= len &&
        w1.slice(-len).join(' ').toLowerCase() === w2.slice(0, len).join(' ').toLowerCase()) {
      return w1.join(' ') + ' ' + w2.slice(len).join(' ');
    }
  }
  return t1.trim() + ' ' + t2.trim();
}

// Transcribe PCM split at silence boundaries. Returns one string per logical chunk.
async function transcribeChunked(pcm48k) {
  const chunks = splitAtSilence(pcm48k);
  if (chunks.length > 1) {
    log(`pipeline: ${(pcm48k.length / 2 / 48000).toFixed(1)}s → ${chunks.length} silence-split chunks`);
  }
  const parts = [];
  for (const { pcm, hasOverlap } of chunks) {
    const t = await transcribe(pcmToWav(pcm));
    if (!t) continue;
    if (hasOverlap && parts.length > 0) {
      parts[parts.length - 1] = stitchOverlap(parts[parts.length - 1], t);
    } else {
      parts.push(t);
    }
  }
  return parts;
}

// Append one transcript line to a per-session JSONL log on disk.
function logTranscript(sessionId, userId, text) {
  const dir = (process.env.TRANSCRIPT_DIR ?? './transcripts').replace(/\/+$/, '');
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, `session_${sessionId}.jsonl`),
      JSON.stringify({ tsMs: Date.now(), userId: userId.toString(), text }) + '\n',
    );
  } catch (e) {
    warn('pipeline: transcript log error:', e.message);
  }
}

// Push Opus frames to every downlink subscriber of a session.
function sendOpusToSession(sessionId, opusFrames) {
  const s = sessions.get(BigInt(sessionId));
  if (!s || s.downlinks.size === 0) {
    debug('pipeline: no downlink subscribers for session', sessionId.toString());
    return;
  }
  const ts0 = Date.now();
  for (const ws of s.downlinks) {
    if (ws.readyState !== 1) continue;
    let seq = 0;
    for (let i = 0; i < opusFrames.length; i++) {
      const pkt = buildFrame({
        magic: MAGIC_DNLK, codec: 'opus',
        sessionId: BigInt(sessionId), userId: 0n,
        seq: seq++, tsMs: ts0 + i * 20, payload: opusFrames[i],
      });
      try { ws.send(pkt, { binary: true }); } catch {}
    }
  }
  log('pipeline: sent', opusFrames.length, 'opus frames to session', sessionId.toString());
}

// ── State ────────────────────────────────────────────────────────────────────

// Active pipeline per session key → AbortController for its TTS stream.
// A new run aborts the previous one rather than silently skipping.
const activePipelines = new Map();

// Last LLM response per session — used to add interrupt context to history.
const lastResponses = new Map(); // sessionId(string) → response text

// ── Main pipeline ────────────────────────────────────────────────────────────

export async function runPipeline(sessionId, userId) {
  const key = `${sessionId}:${userId}`;
  if (activePipelines.has(key)) {
    debug('pipeline: aborting previous run for', key);
    activePipelines.get(key).abort();
  }
  const ctrl = new AbortController();
  activePipelines.set(key, ctrl);

  try {
    // 1. Drain buffered Opus frames for this speaker.
    const opusBuffers = drainBuffer(sessionId, userId);
    if (opusBuffers.length === 0) {
      debug('pipeline: no frames for', key);
      return;
    }
    debug('pipeline: decoding', opusBuffers.length, 'opus frames for', key);

    // 2. Decode Opus → 48 kHz mono PCM.
    const pcm48k = opusFramesToPcm(opusBuffers);

    // 3. STT — split at silence boundaries, transcribe each chunk independently.
    let transcripts;
    try {
      transcripts = await transcribeChunked(pcm48k);
    } catch (e) {
      warn('pipeline: stt error:', e.message);
      return;
    }

    if (transcripts.length === 0) {
      debug('pipeline: empty transcript, skipping');
      return;
    }

    // Log the full utterance (all chunks joined) to disk.
    logTranscript(sessionId, userId, transcripts.join(' '));

    // 4. Read wake-word config.
    const wakeWord = process.env.WAKE_WORD        ?? 'Rabenauge';
    const fuzzy    = (process.env.WAKE_WORD_FUZZY ?? 'true') !== 'false';
    const maxPos   = Number(process.env.WAKE_WORD_POSITION ?? 3);

    // 5 & 6. Scan each chunk independently for stop / wake-word.
    //        Wake-word position resets at each chunk boundary (natural pause = new sentence start).
    let wakeResult = null;
    let transcript = null; // the chunk that triggered the wake word

    for (const chunk of transcripts) {
      const wordCount = chunk.trim().split(/\s+/).length;
      const wr        = detectWakeWord(chunk, wakeWord, fuzzy, maxPos);

      // Stop-command check (works with or without wake word).
      const isStop = (wr.detected && isStopCommand(wr.query)) ||
                     (!wr.detected && wordCount <= 5 && isStopCommand(chunk));

      if (isStop) {
        broadcastToAllBots({ type: 'stop_playback', cmdId: randomUUID() });

        const session = sessions.get(BigInt(sessionId));
        if (session) {
          const interrupted = lastResponses.get(String(sessionId));
          session.conversationHistory.push({
            role: 'system',
            content: interrupted
              ? `Der Sprecher hat dich unterbrochen. Deine letzte Antwort war: "${interrupted.slice(0, 100)}"`
              : 'Der Sprecher hat die Wiedergabe gestoppt.',
          });
        }

        broadcastToAllBots({
          type: 'chat_message', cmdId: randomUUID(),
          question: chunk, isStop: true,
        });
        log('pipeline: stop command detected, playback cleared');
        return;
      }

      if (wr.detected) {
        wakeResult = wr;
        transcript = chunk;
        break; // first wake-word hit wins
      }
    }

    if (!wakeResult) {
      log('pipeline: no wake word in transcript, ignoring');
      return;
    }

    const { query } = wakeResult;
    log('pipeline: wake word detected, query=', JSON.stringify(query));

    // 7. LLM.
    const session = sessions.get(BigInt(sessionId));
    if (!session) {
      warn('pipeline: session not found', sessionId.toString());
      return;
    }

    let response;
    try {
      response = await chat(session.conversationHistory, query);
    } catch (e) {
      warn('pipeline: llm error:', e.message);
      return;
    }

    const { text: responseText, speakerId, model: ttsModel } = response;

    // Persist turn to history using the spoken text (not raw JSON).
    session.conversationHistory.push({ role: 'user',      content: query        });
    session.conversationHistory.push({ role: 'assistant', content: responseText });
    lastResponses.set(String(sessionId), responseText);

    // Always send the Q&A to the Discord text channel.
    broadcastToAllBots({
      type: 'chat_message', cmdId: randomUUID(),
      question: transcript, answer: responseText, isStop: false,
    });

    // 8–10. Streaming TTS → resample → encode → push to downlink.
    // StreamingAudioPipeline keeps a single OpusEncoder and accumulator alive
    // across all chunks so that chunk boundaries cause no encoder resets or
    // dropped samples (fixes the noise-after-2s bug).
    let audioPipe = null;
    try {
      const opts = { model: ttsModel, speakerId };
      for await (const { pcm, sampleRate } of synthesizeStream(responseText, opts, ctrl.signal)) {
        if (ctrl.signal.aborted) break;
        audioPipe ??= new StreamingAudioPipeline(sampleRate);
        sendOpusToSession(sessionId, audioPipe.push(pcm));
      }
      if (audioPipe && !ctrl.signal.aborted) {
        sendOpusToSession(sessionId, audioPipe.flush());
      }
    } catch (e) {
      if (e.name !== 'AbortError') warn('pipeline: tts stream error:', e.message);
    }
  } finally {
    // Only clean up if this run is still the active one (a newer run may have replaced it).
    if (activePipelines.get(key) === ctrl) activePipelines.delete(key);
  }
}
