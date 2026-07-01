import { randomUUID } from 'crypto';
import { sessions, ensureSession } from './state.js';
import { drainBuffer } from './uplink.js';
import { detectWakeWord } from './wakeword.js';
import { transcribe } from './stt.js';
import { chat } from './llm.js';
import { streamTtsToSession, cancelTtsForSession } from './ttsStream.js';
import { logTranscriptEvent } from './transcript.js';
import { log, warn, debug } from './logger.js';
import { broadcastToAllBots } from './broadcast.js';
import { appendLive, renderLiveContext, liveContextEnabled } from './liveContext.js';
import { publishEntry, publishAnnotation } from './liveBus.js';
import { maybeFold } from './rollingSummary.js';
import { getCampaignContext } from './campaignContext.js';
import { loadSpeakerMap } from './speakerMap.js';
import { speakerLabel, normalizeText } from './finalize/merge.js';
import opus from '@discordjs/opus';

const { OpusEncoder } = opus;

// ── Stop-command detection ───────────────────────────────────────────────────

const DEFAULT_STOP_PHRASES = [
  'stop',
  'stopp',
  'abbrechen',
  'beenden',
  'hör auf',
  'aufhören',
  'halt',
  'halte an',
  'halte ein',
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stopPhrases() {
  const raw = process.env.STOP_PHRASES;
  const phrases = raw
    ? raw.split(',').map((item) => item.trim()).filter(Boolean)
    : DEFAULT_STOP_PHRASES;
  return phrases.length > 0 ? phrases : DEFAULT_STOP_PHRASES;
}

function stopRegex() {
  const body = stopPhrases()
    .map((phrase) => phrase.split(/\s+/).map(escapeRegex).join('\\s+'))
    .sort((a, b) => b.length - a.length)
    .join('|');
  return new RegExp(`(^|[^\\p{L}\\p{N}])(?:${body})(?=$|[^\\p{L}\\p{N}])`, 'iu');
}

function isStopCommand(text) {
  return stopRegex().test(text);
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

const SAMPLE_RATE     = 48000;
const FRAME           = 960;              // 20 ms @ 48 kHz
const SILENCE_FRAMES  = 15;               // 300 ms continuous silence → split candidate
const MIN_CHUNK       = SAMPLE_RATE * 10; // 10 s minimum speech before a natural split
const OVERLAP_SAMPLES = SAMPLE_RATE *  2; // 2 s overlap used only in the no-silence fallback

function numberEnv(name, fallback, min = 0) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

function maxChunkSamples() {
  return Math.round(SAMPLE_RATE * numberEnv('STT_MAX_CHUNK_SECONDS', 30, 1));
}

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
  const maxChunk = maxChunkSamples();
  if (totalSamples <= maxChunk) return [{ pcm, hasOverlap: false, split: 'single', startSample: 0 }];

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
          chunks.push({
            pcm: pcm.subarray(chunkStart * 2, silenceStart * 2),
            hasOverlap: nextHasOverlap,
            split: 'natural-silence',
            startSample: chunkStart,
          });
          nextHasOverlap = false;
          chunkStart     = off;
          bestSilStart   = -1; bestSilEnd = -1; bestSilDur = 0;
        }
      }
      silenceStart  = -1;
      silenceFrames = 0;
    }

    // Hard cap: chunk has grown to STT_MAX_CHUNK_SECONDS.
    if ((off + FRAME - chunkStart) >= maxChunk) {
      if (bestSilStart >= 0) {
        // Split at the longest silence found — best boundary available.
        chunks.push({
          pcm: pcm.subarray(chunkStart * 2, bestSilStart * 2),
          hasOverlap: nextHasOverlap,
          split: 'natural-silence',
          startSample: chunkStart,
        });
        nextHasOverlap = false;
        chunkStart     = bestSilEnd; // skip silence
      } else {
        // No qualifying silence at all — forced split with 2 s overlap.
        const splitAt = off + FRAME;
        chunks.push({
          pcm: pcm.subarray(chunkStart * 2, splitAt * 2),
          hasOverlap: nextHasOverlap,
          split: 'forced-overlap',
          startSample: chunkStart,
        });
        nextHasOverlap = true; // next chunk carries the overlap flag
        chunkStart     = Math.max(0, splitAt - OVERLAP_SAMPLES);
      }
      silenceStart = -1; silenceFrames = 0;
      bestSilStart = -1; bestSilEnd    = -1; bestSilDur = 0;
    }
  }

  if (chunkStart * 2 < pcm.length) {
    chunks.push({
      pcm: pcm.subarray(chunkStart * 2),
      hasOverlap: nextHasOverlap,
      split: 'tail',
      startSample: chunkStart,
    });
  }
  return chunks.length > 0 ? chunks : [{ pcm, hasOverlap: false, split: 'single', startSample: 0 }];
}

function logSilenceSplitDebug(pcm48k, chunks) {
  const totalSec = pcm48k.length / 2 / SAMPLE_RATE;
  const maxSec = numberEnv('STT_MAX_CHUNK_SECONDS', 30, 1);
  if (totalSec <= maxSec) return;

  const thresh = Number(process.env.STT_SILENCE_THRESH ?? 300);
  const details = chunks.map((chunk, i) => {
    const sec = chunk.pcm.length / 2 / SAMPLE_RATE;
    const overlap = chunk.hasOverlap ? ',overlap-in' : '';
    return `#${i + 1}:${sec.toFixed(1)}s/${chunk.split}${overlap}`;
  }).join(' ');
  debug(`pipeline: silence split debug duration=${totalSec.toFixed(1)}s maxChunk=${maxSec}s threshold=${thresh} chunks=${chunks.length} ${details}`);
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

function summarizeStt(chunks, chunkResults) {
  let weightedNoSpeech = 0;
  let totalWeight = 0;
  let noSpeechProbMax = null;

  for (const result of chunkResults) {
    const avg = result.meta?.noSpeechProbAvg;
    if (typeof avg !== 'number') continue;
    const weight = Math.max(1, result.text.length || result.durationMs || 1);
    weightedNoSpeech += avg * weight;
    totalWeight += weight;
    const max = result.meta?.noSpeechProbMax;
    if (typeof max === 'number') noSpeechProbMax = noSpeechProbMax === null ? max : Math.max(noSpeechProbMax, max);
  }

  return {
    provider: 'whisper.cpp',
    noSpeechProbAvg: totalWeight > 0 ? weightedNoSpeech / totalWeight : null,
    noSpeechProbMax,
    chunkDurationsMs: chunks.map((chunk) => Math.round((chunk.pcm.length / 2 / SAMPLE_RATE) * 1000)),
    splitTypes: chunks.map((chunk) => chunk.split),
    chunks: chunkResults.map((result, i) => ({
      index: i,
      durationMs: result.durationMs,
      splitType: chunks[i]?.split ?? 'unknown',
      hasOverlap: !!chunks[i]?.hasOverlap,
      textLength: result.text.length,
      segmentCount: result.meta?.segmentCount ?? 0,
      noSpeechProbAvg: result.meta?.noSpeechProbAvg ?? null,
      noSpeechProbMax: result.meta?.noSpeechProbMax ?? null,
      language: result.meta?.language ?? null,
    })),
  };
}

// Transcribe PCM split at silence boundaries. Returns text chunks plus STT metadata.
//
// `parts` (aka segments) are the natural-silence-separated groups: forced-overlap
// chunks are stitched (de-duplicated) into the previous part, so a part boundary
// always corresponds to a natural silence. Chunk text is normalized (collapsing
// whisper's internal segment newlines to single spaces) so live and reload render
// identically — no mid-word line breaks.
//
// `rawChunks` keeps every whisper chunk verbatim ({ text, split }) for the debug
// per-chunk view. `onProgress({ segments, chunks })` fires after each transcribed
// chunk so the UI can update the utterance live as chunks arrive.
export async function transcribeChunked(pcm48k, { onProgress } = {}) {
  const chunks = splitAtSilence(pcm48k);
  logSilenceSplitDebug(pcm48k, chunks);
  if (chunks.length > 1) {
    log(`pipeline: ${(pcm48k.length / 2 / 48000).toFixed(1)}s → ${chunks.length} silence-split chunks`);
  }
  const parts = [];
  const rawChunks = []; // [{ text, split }] per whisper chunk (debug view)
  const chunkResults = [];
  // Flat word-timestamp list across all chunks, in ms relative to utterance start.
  const words = [];
  let anyWords = false;
  const overlapSec = OVERLAP_SAMPLES / SAMPLE_RATE;
  for (const { pcm, hasOverlap, startSample, split } of chunks) {
    const { text: rawText, meta, words: chunkWords } = await transcribe(pcmToWav(pcm));
    const text = normalizeText(rawText); // collapse whisper's internal \n → single spaces
    const result = {
      text,
      meta,
      durationMs: Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000),
    };
    chunkResults.push(result);

    if (Array.isArray(chunkWords)) {
      anyWords = true;
      const offsetSec = (startSample ?? 0) / SAMPLE_RATE;
      for (const w of chunkWords) {
        // Drop words inside the duplicated overlap region of a stitched chunk.
        if (hasOverlap && w.t0 < overlapSec) continue;
        words.push({
          w: w.w,
          t0: Math.round((w.t0 + offsetSec) * 1000),
          t1: Math.round((w.t1 + offsetSec) * 1000),
        });
      }
    }

    if (!text) continue;
    if (hasOverlap && parts.length > 0) {
      parts[parts.length - 1] = stitchOverlap(parts[parts.length - 1], text);
    } else {
      parts.push(text);
    }
    rawChunks.push({ text, split: split ?? null });

    // Live progress: emit the current segments + raw chunks as each chunk lands.
    if (onProgress) {
      try { onProgress({ segments: parts.slice(), chunks: rawChunks.slice() }); }
      catch (e) { debug('transcribeChunked: onProgress error:', e.message); }
    }
  }
  return {
    transcripts: parts,
    chunks: rawChunks,
    stt: summarizeStt(chunks, chunkResults),
    words: anyWords ? words : null,
  };
}

// ── State ────────────────────────────────────────────────────────────────────

// Active pipeline per session key → AbortController for its TTS stream.
// A new run aborts the previous one rather than silently skipping.
const activePipelines = new Map();

// Last LLM response per session — used to add interrupt context to history.
const lastResponses = new Map(); // sessionId(string) → response text
const textHistories = new Map();

function wakeWordName() {
  return process.env.WAKE_WORD ?? 'Rabenauge';
}

// Assemble the extra `system` blocks for a voice session, in priority order:
// campaign context → rolling summary → live transcript. Empty parts are skipped
// so an unavailable block costs nothing. `query` is forwarded to the campaign
// lookup (RAG hook for later). Returns [] when live context is disabled.
function buildSystemBlocks(session, query) {
  if (!liveContextEnabled()) return [];
  const blocks = [];
  const campaign = getCampaignContext(query);
  if (campaign) blocks.push(`Kampagnen-Kontext:\n${campaign}`);
  const summary = session?.liveContext?.summary;
  if (summary && summary.trim()) {
    blocks.push(`Bisheriger Gesprächsverlauf (Zusammenfassung):\n${summary.trim()}`);
  }
  const live = renderLiveContext(session);
  if (live) blocks.push(`Aktuelles Live-Transkript der Runde:\n${live}`);
  return blocks;
}

function sessionlessHistory(scope) {
  const key = scope || 'global';
  if (!textHistories.has(key)) textHistories.set(key, []);
  return textHistories.get(key);
}

function appendHistory(history, userText, assistantText) {
  history.push({ role: 'user', content: userText });
  history.push({ role: 'assistant', content: assistantText });
  const maxTurns = numberEnv('HISTORY_TURNS', 6, 1);
  const maxMessages = Math.ceil(maxTurns * 2);
  if (history.length > maxMessages) {
    history.splice(0, history.length - maxMessages);
  }
}

function maxStopWordsWithoutWake() {
  return Math.floor(numberEnv('STOP_WITHOUT_WAKE_MAX_WORDS', 5, 0));
}

function maybeStopWithoutWake(text) {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return wordCount <= maxStopWordsWithoutWake() && isStopCommand(text);
}

function handleStopCommand({ sessionId, userId, text, wakeWordDetected = false, query = null, userDisplayName = null, channelId = null, source = 'voice' }) {
  if (sessionId) cancelTtsForSession(sessionId, 'stopword');
  broadcastToAllBots({ type: 'stop_playback', cmdId: randomUUID() });
  logTranscriptEvent(sessionId ?? `text_${channelId ?? 'global'}`, 'stop_command', {
    userId,
    userDisplayName,
    text,
    source,
    wakeWordDetected,
    query,
  });

  if (sessionId) {
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
  }

  broadcastToAllBots({
    type: 'chat_message',
    cmdId: randomUUID(),
    channelId,
    question: text,
    userDisplayName,
    assistantName: wakeWordName(),
    isStop: true,
  });
  log('pipeline: stop command detected, playback cleared');
}

async function answerQuestion({
  sessionId,
  userId,
  userDisplayName = null,
  query,
  transcript,
  source = 'voice',
  channelId = null,
  tts = true,
}) {
  const turnId = randomUUID();
  const sid = sessionId ? BigInt(sessionId) : null;
  const session = sid ? sessions.get(sid) : null;
  const history = sid
    ? session?.conversationHistory
    : sessionlessHistory(channelId ? `channel_${channelId}` : 'global');

  if (!history) {
    warn('pipeline: session not found', sessionId?.toString?.() ?? String(sessionId));
    return;
  }

  // Voice sessions get campaign context + rolling summary + live transcript as
  // extra system blocks; text/global queries get none (no live buffer).
  const systemBlocks = session ? buildSystemBlocks(session, query) : [];

  let response;
  try {
    response = await chat(history, query, { systemBlocks });
  } catch (e) {
    warn('pipeline: llm error:', e.message);
    return;
  }

  const { text: responseText, speakerId, model: ttsModel } = response;
  logTranscriptEvent(sessionId ?? `text_${channelId ?? 'global'}`, 'assistant_response', {
    turnId,
    userId,
    userDisplayName,
    source,
    channelId,
    query,
    text: responseText,
    speakerId,
    model: ttsModel,
    ttsRequested: tts,
  });

  appendHistory(history, query, responseText);
  if (sid) lastResponses.set(sid.toString(), responseText);

  // Mirror the reply into the live-transcript buffer so later turns see it,
  // then fold if the raw window overflowed. Fire-and-forget (single-flight).
  if (session) {
    const stored = appendLive(session, { label: wakeWordName(), text: responseText, startMs: Date.now(), kind: 'assistant' });
    if (stored && sid) publishEntry(sid, stored);
    maybeFold(session).catch((e) => warn('pipeline: fold error:', e.message));
  }

  broadcastToAllBots({
    type: 'chat_message',
    cmdId: randomUUID(),
    channelId,
    question: transcript ?? query,
    answer: responseText,
    userDisplayName,
    assistantName: wakeWordName(),
    isStop: false,
  });

  if (!tts) return;
  if (!sid) {
    logTranscriptEvent(`text_${channelId ?? 'global'}`, 'tts_skipped', {
      turnId,
      reason: 'no active voice session',
    });
    return;
  }

  try {
    await streamTtsToSession(sid, responseText, {
      model: ttsModel,
      speakerId,
      turnId,
    });
  } catch (e) {
    if (e.name !== 'AbortError') warn('pipeline: tts stream error:', e.message);
  }
}

// ── Main pipeline ────────────────────────────────────────────────────────────

export async function runTextPipeline({
  sessionId = null,
  userId = '0',
  userDisplayName = null,
  question,
  channelId = null,
  tts = false,
  source = 'text',
} = {}) {
  const query = String(question || '').trim();
  if (!query) return;

  const logSessionId = sessionId ?? `text_${channelId ?? 'global'}`;
  logTranscriptEvent(logSessionId, 'text_query', {
    userId,
    userDisplayName,
    channelId,
    text: query,
    ttsRequested: tts,
    source,
  });

  if (maybeStopWithoutWake(query)) {
    handleStopCommand({
      sessionId,
      userId,
      userDisplayName,
      channelId,
      text: query,
      source,
    });
    return;
  }

  const sid = sessionId ? BigInt(sessionId) : null;
  if (sid) ensureSession(sid);

  await answerQuestion({
    sessionId,
    userId,
    userDisplayName,
    channelId,
    query,
    transcript: query,
    source,
    tts,
  });
}

export async function runPipeline(sessionId, userId, metadata = {}) {
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

    // Speaker label + a STABLE startMs for this utterance's live entry, computed
    // up front so the streaming partials and the final entry share one identity
    // (the client upserts by startMs).
    const session = sessions.get(sessionId);
    const liveLabel = session
      ? speakerLabel(userId, metadata.userDisplayName, loadSpeakerMap(session.guildId))
      : (metadata.userDisplayName || String(userId));
    const entryStartMs = metadata.startTsMs ?? Date.now();

    // 3. STT — split at silence boundaries, transcribe each chunk independently.
    //    Stream a display-only partial after each chunk so the utterance grows
    //    live on the transcript page (not persisted to JSONL / LLM buffer).
    let transcripts;
    let stt;
    let words;
    let rawChunks;
    try {
      const onProgress = (session && liveContextEnabled())
        ? ({ segments, chunks }) => publishEntry(sessionId, {
            label: liveLabel,
            text: segments.join(' '),
            segments,
            chunks,
            startMs: entryStartMs,
            kind: 'user',
            partial: true,
          })
        : undefined;
      const result = await transcribeChunked(pcm48k, { onProgress });
      transcripts = result.transcripts;
      stt = result.stt;
      words = result.words;
      rawChunks = result.chunks;
    } catch (e) {
      warn('pipeline: stt error:', e.message);
      return;
    }

    // Log the full utterance (all chunks joined) to disk.
    // `words` (ms relative to utterance start) enables word-level interrupt
    // splitting at finalize; absent → merge falls back to utterance-level.
    // `segments` (natural-silence groups) + `rawChunks` ({text,split}) let the
    // reload/snapshot render identically to the live stream.
    const fullTranscript = transcripts.join(' ');
    logTranscriptEvent(sessionId, 'user_transcript', {
      userId,
      userDisplayName: metadata.userDisplayName ?? null,
      startTsMs: metadata.startTsMs ?? null,
      endTsMs: metadata.endTsMs ?? null,
      durationMs: metadata.durationMs ?? null,
      text: fullTranscript,
      chunks: transcripts,
      segments: transcripts,
      rawChunks,
      words: words ?? null,
      stt,
    });

    if (!fullTranscript) {
      debug('pipeline: empty transcript, skipping wake-word processing');
      return;
    }

    // Keep EVERY utterance in the live-transcript buffer (not just wake-word
    // queries) so the LLM sees the whole table conversation as context.
    // startMs of the live entry for this utterance — reused below to annotate it
    // (wake/stop) once detection has run. null when no entry was stored.
    let liveEntryStartMs = null;
    if (session) {
      const stored = appendLive(session, {
        label: liveLabel,
        text: fullTranscript,
        startMs: entryStartMs,
        kind: 'user',
      });
      if (stored) {
        liveEntryStartMs = stored.startMs;
        // Final entry carries the structured render data (replaces the partials).
        stored.segments = transcripts;
        stored.chunks = rawChunks;
        publishEntry(sessionId, stored, { noSpeechProb: stt?.noSpeechProbAvg ?? null });
      }
      maybeFold(session).catch((e) => warn('pipeline: fold error:', e.message));
    }

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
                     (!wr.detected && wordCount <= maxStopWordsWithoutWake() && isStopCommand(chunk));

      if (isStop) {
        // Retro-mark the live line as a stop (detection runs after append).
        if (liveEntryStartMs != null) {
          publishAnnotation(sessionId, { startMs: liveEntryStartMs, stopDetected: true });
        }
        handleStopCommand({
          sessionId,
          userId,
          userDisplayName: metadata.userDisplayName ?? null,
          text: chunk,
          wakeWordDetected: wr.detected,
          query: wr.detected ? wr.query : null,
          source: 'voice',
        });
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
    // Retro-mark the live line as a wake-word trigger (whole utterance).
    if (liveEntryStartMs != null) {
      publishAnnotation(sessionId, { startMs: liveEntryStartMs, wakeDetected: true });
    }
    logTranscriptEvent(sessionId, 'wakeword_query', {
      userId,
      userDisplayName: metadata.userDisplayName ?? null,
      transcript,
      query,
    });

    // 7. LLM + optional TTS.
    await answerQuestion({
      sessionId,
      userId,
      userDisplayName: metadata.userDisplayName ?? null,
      query,
      transcript,
      source: 'voice',
      tts: true,
    });
  } finally {
    // Only clean up if this run is still the active one (a newer run may have replaced it).
    if (activePipelines.get(key) === ctrl) activePipelines.delete(key);
  }
}
