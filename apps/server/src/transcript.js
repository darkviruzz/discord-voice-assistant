import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { warn } from './logger.js';

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
