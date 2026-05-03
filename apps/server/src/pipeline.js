import { randomUUID } from 'crypto';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { sessions } from './state.js';
import { drainBuffer } from './uplink.js';
import { detectWakeWord } from './wakeword.js';
import { transcribe } from './stt.js';
import { chat } from './llm.js';
import { synthesize } from './tts.js';
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

// Parse a WAV buffer and return { pcm, sampleRate, channels, bitDepth }.
function parseWav(buf) {
  if (buf.length < 44) throw new Error('wav: buffer too short');
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('wav: not RIFF');
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('wav: not WAVE');

  let offset = 12;
  let sampleRate, channels, bitDepth, dataStart, dataLen;

  while (offset + 8 <= buf.length) {
    const id   = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    offset += 8;
    if (id === 'fmt ') {
      const fmt = buf.readUInt16LE(offset);
      if (fmt !== 1) throw new Error(`wav: unsupported format ${fmt} (only PCM=1)`);
      channels   = buf.readUInt16LE(offset + 2);
      sampleRate = buf.readUInt32LE(offset + 4);
      bitDepth   = buf.readUInt16LE(offset + 14);
    } else if (id === 'data') {
      dataStart = offset;
      dataLen   = Math.min(size, buf.length - offset);
      break;
    }
    offset += size % 2 === 0 ? size : size + 1; // RIFF chunks are word-aligned
  }

  if (dataStart == null) throw new Error('wav: no data chunk');
  return { pcm: buf.subarray(dataStart, dataStart + dataLen), sampleRate, channels, bitDepth };
}

// Stereo / multi-channel → mono by averaging.
function toMono(pcmI16Le, channels) {
  if (channels === 1) return pcmI16Le;
  const frames = Math.floor(pcmI16Le.length / 2 / channels);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += pcmI16Le.readInt16LE((i * channels + c) * 2);
    }
    out.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return out;
}

// Linear-interpolation resampler (mono int16LE).
function resampleMono(src, fromRate, toRate) {
  if (fromRate === toRate) return src;
  const srcFrames = src.length / 2;
  const dstFrames = Math.round(srcFrames * toRate / fromRate);
  const dst = Buffer.alloc(dstFrames * 2);
  for (let i = 0; i < dstFrames; i++) {
    const pos = i * fromRate / toRate;
    const lo  = Math.min(Math.floor(pos), srcFrames - 1);
    const hi  = Math.min(lo + 1,          srcFrames - 1);
    const s0  = src.readInt16LE(lo * 2);
    const s1  = src.readInt16LE(hi * 2);
    const s   = Math.round(s0 + (s1 - s0) * (pos - lo));
    dst.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return dst;
}

// Encode 48 kHz mono int16LE PCM to an array of Opus Buffer packets.
function pcm48kToOpusFrames(pcm48k) {
  const enc        = new OpusEncoder(48000, 1);
  const frameSamples = 960;      // 20 ms @ 48 kHz
  const frameBytes   = frameSamples * 2;
  const frames = [];
  for (let off = 0; off + frameBytes <= pcm48k.length; off += frameBytes) {
    frames.push(Buffer.from(enc.encode(pcm48k.subarray(off, off + frameBytes))));
  }
  return frames;
}

// ── Long-audio transcription helpers ────────────────────────────────────────

const FRAME          = 960;        // 20 ms @ 48 kHz
const SILENCE_FRAMES = 15;         // 300 ms continuous silence → split point
const MIN_CHUNK      = 48000 * 10; // 10 s minimum speech before a split
const MAX_CHUNK      = 48000 * 30; // 30 s hard cap

function frameRms(pcm, sampleOffset) {
  let sum = 0;
  for (let i = 0; i < FRAME; i++) {
    const s = pcm.readInt16LE((sampleOffset + i) * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / FRAME);
}

// Split PCM at natural pauses (≥ 300 ms RMS silence).
// Silence is discarded; each chunk starts at the first speech frame after a pause.
function splitAtSilence(pcm) {
  const totalSamples = pcm.length / 2;
  if (totalSamples <= MAX_CHUNK) return [pcm];
  const thresh  = Number(process.env.STT_SILENCE_THRESH ?? 300);
  const chunks  = [];
  let chunkStart   = 0;
  let silenceStart = -1;
  let silenceFrames = 0;

  for (let off = 0; off + FRAME <= totalSamples; off += FRAME) {
    const rms = frameRms(pcm, off);

    if (rms < thresh) {
      if (silenceStart < 0) silenceStart = off;
      silenceFrames++;
    } else {
      if (silenceFrames >= SILENCE_FRAMES && (silenceStart - chunkStart) >= MIN_CHUNK) {
        chunks.push(pcm.subarray(chunkStart * 2, silenceStart * 2));
        chunkStart = off; // skip silence, new chunk starts at this speech frame
      }
      silenceStart = -1;
      silenceFrames = 0;
    }

    // Hard cap: force split if chunk grows beyond MAX_CHUNK
    if ((off + FRAME - chunkStart) >= MAX_CHUNK) {
      const splitAt = silenceStart > chunkStart ? silenceStart : off + FRAME;
      chunks.push(pcm.subarray(chunkStart * 2, splitAt * 2));
      chunkStart    = splitAt;
      silenceStart  = -1;
      silenceFrames = 0;
    }
  }

  if (chunkStart * 2 < pcm.length) chunks.push(pcm.subarray(chunkStart * 2));
  return chunks.length > 0 ? chunks : [pcm];
}

// Transcribe PCM split at silence boundaries. Returns one string per chunk.
async function transcribeChunked(pcm48k) {
  const chunks = splitAtSilence(pcm48k);
  if (chunks.length > 1) {
    log(`pipeline: ${(pcm48k.length / 2 / 48000).toFixed(1)}s → ${chunks.length} silence-split chunks`);
  }
  const parts = [];
  for (const chunk of chunks) {
    const t = await transcribe(pcmToWav(chunk));
    if (t) parts.push(t);
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

// Prevent simultaneous pipeline runs per session (avoids LLM/GPU contention).
const activePipelines = new Set();

// Last LLM response per session — used to add interrupt context to history.
const lastResponses = new Map(); // sessionId(string) → response text

// ── Main pipeline ────────────────────────────────────────────────────────────

export async function runPipeline(sessionId, userId) {
  const key = `${sessionId}:${userId}`;
  if (activePipelines.has(key)) {
    debug('pipeline: already running for', key, '— skipping');
    return;
  }
  activePipelines.add(key);

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

    // 8. TTS.
    let wavAudio;
    try {
      wavAudio = await synthesize(responseText, { model: ttsModel, speakerId });
    } catch (e) {
      warn('pipeline: tts error:', e.message);
      return;
    }

    // 9. Parse TTS WAV → mono 48 kHz PCM.
    let pcmOut;
    try {
      const { pcm, sampleRate, channels } = parseWav(wavAudio);
      const mono = toMono(pcm, channels);
      pcmOut = resampleMono(mono, sampleRate, 48000);
    } catch (e) {
      warn('pipeline: wav parse error:', e.message);
      return;
    }

    // 10. Encode to Opus and push to downlink.
    const opusOut = pcm48kToOpusFrames(pcmOut);
    sendOpusToSession(sessionId, opusOut);
  } finally {
    activePipelines.delete(key);
  }
}
