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
import {
  createSttStream, mergeTokensToWords, normWord,
  opusFramesToPcm, pcmToWav,
} from './sttStreaming.js';

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

// Time-based overlap dedup for forced-overlap chunks: drop the words that lie
// inside the duplicated 2 s overlap region (word t0 < overlapSec) and append
// only the genuinely new tail. Whisper may transcribe the same audio passage
// DIFFERENTLY in the two chunks ("= 7 ergibt" vs "3,7 ergibt"), so the
// text-matching fallback below cannot find the seam — timestamps can.
// A 1-word exact seam dedup catches boundary words whisper placed twice.
export function stitchByTime(prevText, tokens, overlapSec) {
  const words = mergeTokensToWords(tokens);
  const kept = words.filter((w) => w.t0 >= overlapSec);
  if (kept.length > 0) {
    const prevWords = String(prevText || '').trim().split(/\s+/);
    const lastNorm = normWord(prevWords[prevWords.length - 1] ?? '');
    if (lastNorm && lastNorm === kept[0].norm) kept.shift();
  }
  const tail = kept.map((w) => w.text).join(' ');
  return tail ? `${String(prevText || '').trim()} ${tail}` : String(prevText || '').trim();
}

// Soft word-boundary deduplication for the 2 s overlap fallback — used only
// when the whisper server returned no word timestamps.
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
      // Assemble whisper's sub-word tokens into display words first —
      // finalize's interrupt-splitting joins `words` with spaces, so raw
      // token pieces would render as "Quant eng ra vit ation".
      for (const w of mergeTokensToWords(chunkWords)) {
        // Drop words inside the duplicated overlap region of a stitched chunk.
        if (hasOverlap && w.t0 < overlapSec) continue;
        words.push({
          w: w.text,
          t0: Math.round((w.t0 + offsetSec) * 1000),
          t1: Math.round((w.t1 + offsetSec) * 1000),
        });
      }
    }

    if (!text) continue;
    if (hasOverlap && parts.length > 0) {
      // Prefer the time-based cut (word timestamps); text matching is the
      // fallback for servers without word-level data.
      parts[parts.length - 1] = Array.isArray(chunkWords) && chunkWords.length > 0
        ? stitchByTime(parts[parts.length - 1], chunkWords, overlapSec)
        : stitchOverlap(parts[parts.length - 1], text);
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

// ── Streaming STT (LocalAgreement) ───────────────────────────────────────────
// True word-level streaming while a speaker is still talking: every tick the
// speaker's active window is re-transcribed as ONE piece (full context, no
// chunk boundaries), stable words are committed, the moving hypothesis tail is
// displayed alongside — see sttStreaming.js. Partials are DISPLAY-ONLY; the
// utterance_end pipeline stays authoritative (wake-word / LLM / JSONL) and, by
// sharing the same startMs, its final entry replaces the streamed preview.
//
// The buffer is NOT drained here — utterance_end still owns the frames. Each
// tick re-decodes the whole buffer (one fresh Opus decoder; cheap at this
// scale); the streamer itself only re-transcribes its bounded active window.
function streamingEnabled() {
  return (process.env.STT_STREAMING ?? 'true') !== 'false' && liveContextEnabled();
}

// Detect whether a NEW utterance interrupts something currently on screen:
//   1) another speaker is mid-utterance with visible text → float into that;
//   2) the assistant reply was just paused by THIS user (pendingInterrupt from
//      the bot's playback_paused) → float into the reply at the spoken position.
// Returns { hostStartMs, atWordIndex? } or null. Display-only — JSONL,
// wake-word and LLM paths are untouched.
function detectFloatInto(session, userId) {
  let float = null;
  for (const [uid, other] of session.speakers) {
    if (uid === BigInt(userId) || !other.stream || !other.stream.hasContent()) continue;
    if (!float || other.stream.startMs > float.hostStartMs) {
      float = { hostStartMs: other.stream.startMs };
    }
  }
  const pi = session.pendingInterrupt;
  if (!float && pi && pi.byUserId === String(userId) && (Date.now() - pi.at) < 15000) {
    // ~360 ms per spoken word (same heuristic as finalize's estimateSpeechMs);
    // the snapshot rebuild later re-anchors precisely via the TTS duration.
    const wordCount = String(pi.hostText || '').trim().split(/\s+/).filter(Boolean).length;
    float = {
      hostStartMs: pi.hostStartMs,
      atWordIndex: Math.max(0, Math.min(wordCount, Math.round((pi.msPlayed || 0) / 360))),
    };
    session.pendingInterrupt = null;
  }
  return float;
}

async function streamingTick(sessionId, session, userId, sp) {
  if (!sp.opusBuffer || sp.opusBuffer.length === 0) return;
  if (sp.stream?.busy) return;
  if (!sp.stream) {
    sp.stream = createSttStream({
      startMs: Date.now(),
      label: speakerLabel(userId, null, loadSpeakerMap(session.guildId)),
    });
    const float = detectFloatInto(session, userId);
    if (float) sp.stream.floatInto = float;
  }
  const stream = sp.stream;
  const pcm = opusFramesToPcm(sp.opusBuffer);
  const res = await stream.tick(pcm);
  // utterance ended mid-transcribe → the final entry owns the display now
  if (!res?.changed || sp.stream !== stream) return;
  // Nichts Anzeigbares (z. B. nur weggefilterte Sound-Annotationen wie
  // "[Musik]") → keine leere Blase mit Caret in der UI erzeugen.
  if (!String(res.text || '').trim()) return;
  publishEntry(sessionId, {
    label: stream.label,
    text: res.text,
    segments: res.segments,
    chunks: res.chunks,
    startMs: stream.startMs,
    kind: 'user',
    partial: true,
    stableWords: res.stableWords,
    ...(stream.floatInto ? { floatInto: stream.floatInto } : {}),
  });
}

let streamTimer = null;
function startStreamingLoop() {
  if (streamTimer) return;
  const interval = numberEnv('STT_STREAM_INTERVAL_MS', 1000, 200);
  streamTimer = setInterval(() => {
    if (!streamingEnabled()) return;
    for (const [sessionId, session] of sessions) {
      if (!session?.speakers) continue;
      for (const [uid, sp] of session.speakers) {
        if (sp.opusBuffer && sp.opusBuffer.length > 0 && !sp.stream?.busy) {
          streamingTick(sessionId, session, uid, sp).catch(() => {});
        }
      }
    }
  }, interval);
  streamTimer.unref?.();
}
startStreamingLoop();

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

// Whether the assistant's Q&A (and stop notices) get mirrored into the Discord
// text channel. Default OFF — the voice/transcript path is the primary output;
// posting to chat is opt-in via DISCORD_POST_REPLIES=true.
function discordPostRepliesEnabled() {
  return (process.env.DISCORD_POST_REPLIES ?? 'false') === 'true';
}

// Assemble the extra `system` blocks for a voice session, in priority order:
// campaign context → rolling summary → live transcript. Empty parts are skipped
// so an unavailable block costs nothing. `query` is forwarded to the campaign
// lookup (semantic RAG when RAG_URL is set, else the static CAMPAIGN.md).
// Async because that lookup may be an HTTP call. Returns [] when live context
// is disabled.
async function buildSystemBlocks(session, query) {
  if (!liveContextEnabled()) return [];
  const blocks = [];
  const campaign = await getCampaignContext(query);
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

  if (discordPostRepliesEnabled()) {
    broadcastToAllBots({
      type: 'chat_message',
      cmdId: randomUUID(),
      channelId,
      question: text,
      userDisplayName,
      assistantName: wakeWordName(),
      isStop: true,
    });
  }
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
  const systemBlocks = session ? await buildSystemBlocks(session, query) : [];

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
    if (stored) {
      // Estimated spoken duration (~165 wpm) — closes the bubble's time window
      // for the client's overlap grouping; the snapshot later carries the real
      // TTS duration.
      const words = responseText.trim().split(/\s+/).filter(Boolean).length;
      stored.endMs = stored.startMs + Math.max(1500, words * 360);
      if (sid) publishEntry(sid, stored);
    }
    maybeFold(session).catch((e) => warn('pipeline: fold error:', e.message));
  }

  if (discordPostRepliesEnabled()) {
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
  }

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
    // (the client upserts by startMs). If the live streamer ran for this
    // utterance, DETACH it: its locked/committed words become the base of the
    // final transcript and a mid-flight tick discards its result on resume.
    const session = sessions.get(sessionId);
    const sp = session?.speakers?.get(BigInt(userId));
    const stream = sp?.stream ?? null;
    if (sp) sp.stream = null;
    if (stream) stream.detach();
    const liveLabel = session
      ? speakerLabel(userId, metadata.userDisplayName, loadSpeakerMap(session.guildId))
      : (metadata.userDisplayName || String(userId));
    const entryStartMs = stream?.startMs ?? metadata.startTsMs ?? Date.now();

    // Publizierte Live-Partials zurücknehmen, wenn diese Utterance KEIN finales
    // Entry bekommt (leeres/Bracket-only-Transkript wie "[Sprecherwechsel]",
    // STT-Fehler). Ohne Rücknahme bliebe die Partial-Blase mit Caret bis zum
    // Reload in der UI stehen. Für nie publizierte startMs ist das client-
    // seitig ein No-op.
    let partialPublished = stream?.hasContent() ?? false;
    const retractPartial = () => {
      if (!partialPublished || !session) return;
      publishEntry(sessionId, {
        label: liveLabel, text: '', startMs: entryStartMs, kind: 'user', retracted: true,
      });
    };

    // 3. STT.
    //    Streaming path: only the streamer's remaining active window is
    //    transcribed once more (complete audio, full context); everything the
    //    streamer already locked is reused verbatim — no chunk splitting, no
    //    overlap dedup, bounded final latency regardless of utterance length.
    //    Fallback path (streamer never ran / disabled): silence-split chunking
    //    with display-only progress partials, as before.
    let transcripts;
    let stt;
    let words;
    let rawChunks;
    try {
      if (stream?.hasContent() && stream.windowSeconds(pcm48k) <= 29) {
        const fin = await stream.finalize(pcm48k);
        transcripts = fin.segments;
        stt = fin.stt;
        words = fin.words;
        rawChunks = fin.rawChunks;
      } else if (stream?.hasContent()) {
        // Streaming loop stalled and the remaining window outgrew whisper's
        // 30 s limit — chunk just that window and prepend the locked groups.
        const st = stream.state;
        const winPcm = pcm48k.subarray(st.windowStartSample * 2);
        const chunked = await transcribeChunked(winPcm);
        const baseMs = Math.round(st.windowStartSample / (48000 / 1000));
        transcripts = [...st.lockedGroups, ...chunked.transcripts];
        rawChunks = [
          ...st.lockedGroups.map((t) => ({ text: t, split: 'stream-locked' })),
          ...chunked.chunks,
        ];
        words = chunked.words
          ? [...st.lockedWordsMs, ...chunked.words.map((w) => ({ w: w.w, t0: w.t0 + baseMs, t1: w.t1 + baseMs }))]
          : (st.lockedWordsMs.length > 0 ? st.lockedWordsMs : null);
        stt = { ...chunked.stt, mode: 'stream+chunked' };
      } else {
        const onProgress = (session && liveContextEnabled())
          ? ({ segments, chunks }) => {
              partialPublished = true;
              publishEntry(sessionId, {
                label: liveLabel,
                text: segments.join(' '),
                segments,
                chunks,
                startMs: entryStartMs,
                kind: 'user',
                partial: true,
              });
            }
          : undefined;
        const result = await transcribeChunked(pcm48k, { onProgress });
        transcripts = result.transcripts;
        stt = result.stt;
        words = result.words;
        rawChunks = result.chunks;
      }
    } catch (e) {
      warn('pipeline: stt error:', e.message);
      retractPartial();
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
        // The utterance is closed now — endMs lets the client group bubbles
        // that ran in parallel (they share the row width).
        stored.endMs = metadata.endTsMs ?? Date.now();
        // Keep the interruption placement across the partial→final swap.
        if (stream?.floatInto) stored.floatInto = stream.floatInto;
        publishEntry(sessionId, stored, { noSpeechProb: stt?.noSpeechProbAvg ?? null });
      } else {
        // makeEntry hat das Transkript verworfen (leer / Bracket-only wie
        // "[Sprecherwechsel]") — bereits gezeigte Partials zurücknehmen.
        retractPartial();
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
