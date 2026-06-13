// Live-transcript pub/sub. The STT/LLM pipeline already appends every utterance
// and every reply to `session.liveContext.buffer` (see liveContext.appendLive);
// this bus mirrors each *newly stored* entry to any interested transport — today
// the read-only SSE web UI (transcriptApi.js).
//
// Kept separate from:
//   • liveContext.js — pure buffer ops, deliberately free of transport concerns
//   • state.js       — plain session storage, no event machinery
// so neither module grows an EventEmitter dependency. pipeline.js calls
// appendLive() (pure) and then publishEntry() (this module) as two distinct steps.

import { EventEmitter } from 'events';

const bus = new EventEmitter();
// Many SSE clients (one listener each) may subscribe at once; lift the warning cap.
bus.setMaxListeners(0);

// Publish one appended entry.
//   sessionId — BigInt | string | number; normalized to a decimal string so
//               subscribers can compare against a URL query param directly.
//   entry     — the stored liveContext entry { label, text, startMs, kind }.
//   meta      — optional debug-only fields not part of the entry itself
//               (e.g. { noSpeechProb }). Surfaced only in the UI's debug mode.
export function publishEntry(sessionId, entry, meta = null) {
  if (!entry || sessionId == null) return;
  bus.emit('entry', { sessionId: String(sessionId), entry, meta });
}

// Subscribe to every published entry. The handler receives the full envelope
// { sessionId, entry, meta } and is responsible for its own sessionId filtering.
// Returns an unsubscribe function.
export function subscribeEntries(handler) {
  bus.on('entry', handler);
  return () => bus.off('entry', handler);
}
