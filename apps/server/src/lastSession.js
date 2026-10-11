import { latestSessionSummary, capText } from './finalize/summary.js';

// "What happened last time" context: the summary of the most recently
// finalized session (finalize writes summary.md into the archive), handed to
// the LLM as background on every request. Deliberately ON REQUEST only — the
// block tells the model not to recite it unprompted, and nothing is pushed at
// /join. Lookups are cached briefly: the archive changes only on finalize.

const CACHE_MS = 30_000;
let cache = { at: 0, root: null, value: null };

export function lastSessionContextEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.LAST_SESSION_CONTEXT_ENABLED ?? 'true').trim());
}

export function lastSessionContextMaxChars() {
  const n = Number(process.env.LAST_SESSION_CONTEXT_MAX_CHARS);
  return Number.isFinite(n) && n >= 200 ? Math.floor(n) : 2500;
}

// Drop the cache (tests; a finalize could call it, but 30 s staleness is fine).
export function resetLastSessionCache() {
  cache = { at: 0, root: null, value: null };
}

function fmtDate(ms) {
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat('de-DE', {
      timeZone: process.env.FINALIZE_TZ || 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric',
    }).format(new Date(ms));
  } catch { return null; }
}

// → system-block string, or '' (disabled / no finalized session with a summary).
export function lastSessionBlock({ now = Date.now() } = {}) {
  if (!lastSessionContextEnabled()) return '';
  const root = process.env.ARCHIVE_DIR ?? './archive';
  if (cache.root !== root || now - cache.at > CACHE_MS) {
    cache = { at: now, root, value: latestSessionSummary(root) };
  }
  const last = cache.value;
  if (!last?.text) return '';
  const date = fmtDate(last.sessionStartMs);
  return [
    `Zusammenfassung der letzten abgeschlossenen Sitzung${date ? ` (${date})` : ''} — nur verwenden, wenn danach gefragt wird; nicht ungefragt nacherzählen:`,
    capText(last.text, lastSessionContextMaxChars()),
  ].join('\n');
}
