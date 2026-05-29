import { debug } from './logger.js';

// sessions: Map<sessionId(BigInt), { speakers: Map<userId(BigInt), Speaker>, downlinks: Set<WebSocket>, createdAt: number }>
export const sessions = new Map();

export function ensureSession(sessionId) {
  const sid = BigInt(sessionId);
  if (!sessions.has(sid)) {
    sessions.set(sid, {
      speakers: new Map(),
      downlinks: new Set(),
      conversationHistory: [],   // { role, content }[] for LLM context
      // Discord context (stashed at session_start) — needed for the speaker map
      // (campaign labels) and campaign-context file resolution.
      guildId: null,
      guildName: null,
      channelName: null,
      // Live-transcript context fed to the LLM as system blocks. Pure in-RAM,
      // rebuilt from the JSONL on resume (see rollingSummary.rebuildLiveContext).
      liveContext: {
        buffer: [],         // { label, text, startMs, kind:'user'|'assistant' }[], sorted by startMs
        summary: '',        // rolling summary of folded-out older turns
        summarizing: false, // single-flight guard so two folds never overlap
        lastFoldAt: 0,      // epoch ms of last fold (optional min-interval throttle)
        rebuilt: false,     // resume rebuild has run for this session
      },
      createdAt: Date.now(),
    });
    debug('new session', sid.toString());
  }
  return sessions.get(sid);
}

export function ensureSpeaker(sessionId, userId) {
  const s = ensureSession(sessionId);
  const uid = BigInt(userId);
  if (!s.speakers.has(uid)) {
    s.speakers.set(uid, { frames: 0, lastSeq: -1, codec: null });
  }
  return s.speakers.get(uid);
}

export function dropSession(sessionId) {
  const sid = BigInt(sessionId);
  const had = sessions.delete(sid);
  if (had) debug('drop session', sid.toString());
  return had;
}
