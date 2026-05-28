import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { warn } from './logger.js';

// JSONL schema version. Stamped on EVERY event so offline/finalize tooling can
// branch on it. Bump when the shape or semantics of any event field changes.
//   v1 — Phase 2 enriched log (session_meta, user_transcript, turn lifecycle).
//   v2 — Phase 3: user_transcript carries token-level `words`, clock_sync events,
//        session_meta.clockOffsetMs. Missing fields → sensible fallbacks
//        (e.g. no `words` ⇒ utterance-level merge).
export const SCHEMA_VERSION = 2;

function normalizeValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]),
    );
  }
  return value;
}

export function logTranscriptEvent(sessionId, type, fields = {}) {
  const dir = (process.env.TRANSCRIPT_DIR ?? './transcripts').replace(/\/+$/, '');
  try {
    mkdirSync(dir, { recursive: true });
    const event = normalizeValue({
      schemaVersion: SCHEMA_VERSION,
      tsMs: Date.now(),
      type,
      sessionId: sessionId.toString(),
      ...fields,
    });
    appendFileSync(
      join(dir, `session_${sessionId}.jsonl`),
      JSON.stringify(event) + '\n',
    );
  } catch (e) {
    warn('transcript: log error:', e.message);
  }
}
