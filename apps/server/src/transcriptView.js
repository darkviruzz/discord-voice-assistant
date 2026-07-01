// Read-only transcript snapshot for the web UI.
//
// The live in-RAM buffer (session.liveContext.buffer) is intentionally lossy:
// older turns are folded out into a rolling summary once it overflows. For a
// page (re)load mid-session we want the WHOLE conversation, so the snapshot is
// rebuilt from the on-disk JSONL via the same buildModelFromEvents() path used
// by finalize and the LLM resume-rebuild — guaranteeing identical ordering and
// speaker labels. The rolling summary (when present) is taken from RAM so the
// UI can show what was folded away.
//
// Beyond the plain transcript the snapshot also carries (all derived from the
// same JSONL, so they work for live AND ended sessions):
//   • wake/stop detection flags per user line (markDetections),
//   • per-utterance STT diagnostics + per-turn TTS lifecycle (debug only),
//   • the raw session_meta block (debug header),
//   • a small clock-sync debug summary.

import fs from 'fs';
import path from 'path';
import { readSessionEvents } from './sessionEvents.js';
import { buildModelFromEvents, speakerLabel } from './finalize/merge.js';
import { loadSpeakerMap } from './speakerMap.js';
import { sessions } from './state.js';

// States in which the bot is actually sitting in the voice channel.
const CONNECTED_STATES = new Set(['joined', 'occupied', 'alone']);
// …and additionally has humans present (not sitting alone).
const POPULATED_STATES = new Set(['joined', 'occupied']);

function toBig(sessionId) {
  try { return BigInt(sessionId); } catch { return null; }
}

function transcriptDir() {
  return (process.env.TRANSCRIPT_DIR ?? './transcripts').replace(/\/+$/, '');
}

// Current voice-channel presence for a session. Prefers the authoritative
// in-RAM state (live), and falls back to replaying voice_state/voice_member
// from the JSONL for sessions no longer in RAM (where the bot is, by
// definition, not currently connected).
export function buildVoice(sessionId) {
  const sid = String(sessionId);
  const session = sessions.get(toBig(sid));
  const speakerMap = loadSpeakerMap(session?.guildId ?? null);
  const label = (userId, name) => speakerLabel(userId, name, speakerMap);

  if (session?.voice) {
    const v = session.voice;
    return {
      state: v.state,
      connected: CONNECTED_STATES.has(v.state),
      populated: POPULATED_STATES.has(v.state),
      members: [...v.members.entries()].map(([userId, name]) => ({ userId, label: label(userId, name) })),
    };
  }

  // Cold/ended session: reconstruct from the log; bot is not connected now.
  const { events } = readSessionEvents(sid);
  const members = new Map();
  let state = null;
  for (const e of events) {
    if (e?.type === 'voice_member' && e.userId != null) {
      if (e.state === 'leave') members.delete(String(e.userId));
      else members.set(String(e.userId), e.displayName ?? null);
    } else if (e?.type === 'voice_state' && e.state) {
      state = e.state;
    }
  }
  return {
    state,
    connected: false,
    populated: false,
    members: [...members.entries()].map(([userId, name]) => ({ userId, label: label(userId, name) })),
  };
}

// ── debug-data builders (all keyed off the raw JSONL events) ──────────────────

// userId:startTsMs → STT diagnostics + utterance duration. User spans keep
// startTsMs as startMs, so the key matches exactly in spanToEntry.
function buildSttMap(events) {
  const map = new Map();
  for (const e of events) {
    if (e?.type !== 'user_transcript' || e.userId == null) continue;
    const stt = e.stt || {};
    map.set(`${e.userId}:${e.startTsMs ?? e.tsMs}`, {
      noSpeechProb: stt.noSpeechProbAvg ?? null,
      noSpeechProbMax: stt.noSpeechProbMax ?? null,
      provider: stt.provider ?? null,
      chunkDurationsMs: stt.chunkDurationsMs ?? null,
      splitTypes: stt.splitTypes ?? null,
      wordCount: stt.wordCount ?? (Array.isArray(e.words) ? e.words.length : null),
      durationMs: e.durationMs ?? null,
    });
  }
  return map;
}

// userId:startTsMs → structured render data (segments = natural-silence groups,
// rawChunks = per-whisper-chunk {text,split}) so the reloaded snapshot renders
// identically to the live stream. Keyed like buildSttMap.
function buildSegmentsMap(events) {
  const map = new Map();
  for (const e of events) {
    if (e?.type !== 'user_transcript' || e.userId == null) continue;
    map.set(`${e.userId}:${e.startTsMs ?? e.tsMs}`, {
      segments: Array.isArray(e.segments) ? e.segments : null,
      chunks: Array.isArray(e.rawChunks) ? e.rawChunks : null,
    });
  }
  return map;
}

// turnId → TTS lifecycle / model / interruptions, for the assistant debug view.
// playback_paused/resumed and tts_cancel carry the TTS `id`, not the turnId,
// so they are correlated via the tts_start id→turnId map.
function buildTurnMap(events, labelFor) {
  const idToTurn = new Map();
  for (const e of events) {
    if (e?.type === 'tts_start' && e.id && e.turnId) idToTurn.set(e.id, e.turnId);
  }
  const turns = new Map();
  const get = (t) => {
    if (!turns.has(t)) {
      turns.set(t, { ttsModel: null, speakerId: null, ttsStatus: null, ttsDurationMs: null, interruptions: [], truncated: false, played: null });
    }
    return turns.get(t);
  };

  for (const e of events) {
    if (!e || !e.type) continue;
    const viaId = e.id ? idToTurn.get(e.id) : null;
    switch (e.type) {
      case 'assistant_response':
        if (e.turnId) { const r = get(e.turnId); r.ttsModel = e.model ?? r.ttsModel; r.speakerId = e.speakerId ?? r.speakerId; r.ttsRequested = e.ttsRequested ?? r.ttsRequested; }
        break;
      case 'tts_start':
        if (e.turnId) { const r = get(e.turnId); r.ttsModel = e.model ?? r.ttsModel; r.speakerId = e.speakerId ?? r.speakerId; }
        break;
      case 'tts_done':
        if (e.turnId) { const r = get(e.turnId); r.ttsStatus = 'done'; r.ttsDurationMs = e.durationMs ?? r.ttsDurationMs; }
        break;
      case 'tts_cancel': {
        const t = e.turnId || viaId;
        if (t) { const r = get(t); r.ttsStatus = 'cancelled'; r.ttsReason = e.reason ?? null; }
        break;
      }
      case 'tts_error': {
        const t = e.turnId || viaId;
        if (t) { const r = get(t); r.ttsStatus = 'error'; r.ttsError = e.message ?? null; }
        break;
      }
      case 'assistant_response_played':
        if (e.turnId) { const r = get(e.turnId); r.truncated = !!e.truncated; if (e.truncated) r.played = e.text ?? null; r.msPlayed = e.msPlayed ?? null; }
        break;
      case 'playback_paused': {
        const t = e.turnId || viaId;
        if (t) {
          const by = e.interruptedByUserId != null ? String(e.interruptedByUserId) : null;
          get(t).interruptions.push({ by: by ? labelFor(by) : null, msPlayed: e.msPlayed ?? null });
        }
        break;
      }
      default: break;
    }
  }
  return turns;
}

// userId → best-known display name, for labeling interrupters etc.
function buildNameMap(events) {
  const names = new Map();
  for (const e of events) {
    if (e?.userId == null) continue;
    const n = e.userDisplayName ?? e.displayName ?? null;
    if (n && !names.has(String(e.userId))) names.set(String(e.userId), n);
  }
  return names;
}

// Map a finalize span to the UI entry shape, attaching wake/stop flags (always)
// and the debug bundle (STT for users, TTS/turn for assistants).
function spanToEntry(span, sttMap, turnMap, segMap) {
  const kind = span.type === 'assistant' ? 'assistant' : 'user';
  const entry = { label: span.label, text: span.text, startMs: span.startMs, kind };

  if (span.wakeDetected) entry.wakeDetected = true;
  if (span.stopDetected) entry.stopDetected = true;
  if (span.forceMarker) entry.marker = span.forceMarker; // 'unterbricht' | 'weiter'

  if (kind === 'user' && span.userId != null) {
    const stt = sttMap.get(`${span.userId}:${span.startMs}`);
    if (stt) entry.stt = stt;
    const seg = segMap && segMap.get(`${span.userId}:${span.startMs}`);
    if (seg) {
      if (seg.segments) entry.segments = seg.segments;
      if (seg.chunks) entry.chunks = seg.chunks;
    }
  } else if (kind === 'assistant') {
    if (span.interrupted) entry.interrupted = true;
    const turn = span.turnId ? turnMap.get(span.turnId) : null;
    if (turn) entry.turn = turn;
  }
  return entry;
}

// ── snapshot ──────────────────────────────────────────────────────────────

// Build the full snapshot for a session id (string|BigInt). Works purely from
// the JSONL, so it also serves sessions that have already ended (left the
// in-RAM map) — handy for debugging past runs.
export function buildSnapshot(sessionId) {
  const sid = String(sessionId);
  const session = sessions.get(toBig(sid));
  const { events } = readSessionEvents(sid);

  const speakerMap = loadSpeakerMap(session?.guildId ?? null);
  const model = buildModelFromEvents(events, { speakerMap });

  const sttMap = buildSttMap(events);
  const segMap = buildSegmentsMap(events);
  const nameMap = buildNameMap(events);
  const labelFor = (uid) => speakerLabel(uid, nameMap.get(String(uid)) ?? null, speakerMap);
  const turnMap = buildTurnMap(events, labelFor);

  const entries = (model.spans || [])
    .slice()
    .sort((a, b) => a.startMs - b.startMs)
    .map((s) => spanToEntry(s, sttMap, turnMap, segMap));

  const sessionMeta = events.find((e) => e?.type === 'session_meta') ?? null;
  const clockSyncs = events.filter((e) => e?.type === 'clock_sync');
  const lastSync = clockSyncs[clockSyncs.length - 1];

  return {
    sessionId: sid,
    entries,
    summary: session?.liveContext?.summary || '',
    participants: model.participants || [],
    voice: buildVoice(sid),
    sessionMeta,
    debug: {
      clockOffsetMs: model.clockOffsetMs ?? 0,
      clockSyncCount: clockSyncs.length,
      lastRttMs: lastSync?.rttMs ?? null,
    },
    guildName: session?.guildName ?? sessionMeta?.guildName ?? null,
    channelName: session?.channelName ?? sessionMeta?.channelName ?? null,
    startedAt: Number(sid),
    active: !!session,
  };
}

// ── session listing ─────────────────────────────────────────────────────────

// Newest active session id (decimal string), or null when none is in RAM.
export function newestActiveSessionId() {
  let best = null;
  let bestAt = -1;
  for (const [sid, s] of sessions) {
    if (s.createdAt > bestAt) { bestAt = s.createdAt; best = sid.toString(); }
  }
  return best;
}

// Lightweight list of in-RAM (active) sessions for the UI picker / auto-detect.
export function listSessions() {
  const out = [];
  for (const [sid, s] of sessions) {
    out.push({
      sessionId: sid.toString(),
      startedAt: Number(sid.toString()),
      createdAt: s.createdAt,
      guildName: s.guildName ?? null,
      channelName: s.channelName ?? null,
      bufferEntries: s.liveContext?.buffer?.length ?? 0,
      active: true,
    });
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

// All sessions that have a JSONL log on disk (including ended ones). Cheap:
// only the directory listing + a stat per file, no JSON parsing. The session id
// (= filename) is the epoch-ms session start, so it doubles as the timestamp.
export function listSessionsOnDisk() {
  let files = [];
  try { files = fs.readdirSync(transcriptDir()); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = /^session_(\d+)\.jsonl$/.exec(f);
    if (!m) continue;
    const sid = m[1];
    let mtimeMs = null;
    let size = 0;
    try { const st = fs.statSync(path.join(transcriptDir(), f)); mtimeMs = st.mtimeMs; size = st.size; } catch { /* ignore */ }
    out.push({ sessionId: sid, startedAt: Number(sid), mtimeMs, size, active: sessions.has(toBig(sid)) });
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}
