// Read-only transcript snapshot for the web UI.
//
// The live in-RAM buffer (session.liveContext.buffer) is intentionally lossy:
// older turns are folded out into a rolling summary once it overflows. For a
// page (re)load mid-session we want the WHOLE conversation, so the snapshot is
// rebuilt from the on-disk JSONL via the same buildModelFromEvents() path used
// by finalize and the LLM resume-rebuild — guaranteeing identical ordering and
// speaker labels. The rolling summary (when present) is taken from RAM so the
// UI can show what was folded away.

import { readSessionEvents } from './sessionEvents.js';
import { buildModelFromEvents } from './finalize/merge.js';
import { loadSpeakerMap } from './speakerMap.js';
import { sessions } from './state.js';

function toBig(sessionId) {
  try { return BigInt(sessionId); } catch { return null; }
}

// Map a finalize span to the UI entry shape. `nsp` maps user-utterance keys to
// their no_speech_prob (debug-only), recovered from the raw user_transcript
// events (spans don't carry STT diagnostics).
function spanToEntry(span, nsp) {
  const kind = span.type === 'assistant' ? 'assistant' : 'user';
  const entry = { label: span.label, text: span.text, startMs: span.startMs, kind };
  if (kind === 'user' && span.userId != null) {
    const prob = nsp.get(`${span.userId}:${span.startMs}`);
    if (prob != null) entry.meta = { noSpeechProb: prob };
  }
  return entry;
}

// Build the full snapshot for a session id (string|BigInt). Works purely from
// the JSONL, so it also serves sessions that have already ended (left the
// in-RAM map) — handy for debugging past runs.
export function buildSnapshot(sessionId) {
  const sid = String(sessionId);
  const session = sessions.get(toBig(sid));
  const { events } = readSessionEvents(sid);

  const speakerMap = loadSpeakerMap(session?.guildId ?? null);
  const model = buildModelFromEvents(events, { speakerMap });

  // no_speech_prob lookup keyed by userId:startTsMs (user spans keep startTsMs
  // as startMs, so this matches exactly; assistant spans get re-timed and have
  // no STT diagnostics anyway).
  const nsp = new Map();
  for (const e of events) {
    if (e?.type === 'user_transcript' && e.stt && e.userId != null) {
      nsp.set(`${e.userId}:${e.startTsMs ?? e.tsMs}`, e.stt.noSpeechProbAvg ?? null);
    }
  }

  const entries = (model.spans || [])
    .slice()
    .sort((a, b) => a.startMs - b.startMs)
    .map((s) => spanToEntry(s, nsp));

  return {
    sessionId: sid,
    entries,
    summary: session?.liveContext?.summary || '',
    participants: model.participants || [],
    guildName: session?.guildName ?? null,
    channelName: session?.channelName ?? null,
    active: !!session,
  };
}

// Newest active session id (decimal string), or null when none is in RAM.
export function newestActiveSessionId() {
  let best = null;
  let bestAt = -1;
  for (const [sid, s] of sessions) {
    if (s.createdAt > bestAt) { bestAt = s.createdAt; best = sid.toString(); }
  }
  return best;
}

// Lightweight list of in-RAM sessions for the UI picker / auto-detect.
export function listSessions() {
  const out = [];
  for (const [sid, s] of sessions) {
    out.push({
      sessionId: sid.toString(),
      createdAt: s.createdAt,
      guildName: s.guildName ?? null,
      channelName: s.channelName ?? null,
      bufferEntries: s.liveContext?.buffer?.length ?? 0,
    });
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}
