import { latestSessionSummaries, capText } from './finalize/summary.js';

// "What happened last time" context: the summaries of the most recently
// finalized sessions (finalize writes summary.md into the archive), handed to
// the LLM as background on every request. Deliberately ON REQUEST only — the
// block tells the model not to recite it unprompted, and nothing is pushed at
// /join. Lookups are cached briefly: the archive changes only on finalize.
//
// LAST_SESSION_CONTEXT_COUNT sessions (default 1), newest first, each under a
// heading with its date and place ("Letzte Sitzung (08.10.2026)",
// "Vorletzte Sitzung (01.10.2026)"). Without it, "fasse die letzten beiden
// Sessions zusammen" only had the newest one, RAG (no recency) added 2025
// session notes, and the model answered about the wrong sessions (live test
// 2026-10-20). LAST_SESSION_CONTEXT_MAX_CHARS caps the summaries together.

const CACHE_MS = 30_000;
const MAX_COUNT = 5;
let cache = { at: 0, root: null, count: 0, value: [] };

export function lastSessionContextEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.LAST_SESSION_CONTEXT_ENABLED ?? 'true').trim());
}

export function lastSessionContextMaxChars() {
  const n = Number(process.env.LAST_SESSION_CONTEXT_MAX_CHARS);
  return Number.isFinite(n) && n >= 200 ? Math.floor(n) : 2500;
}

// How many of the newest session summaries go into the block (1–5).
export function lastSessionContextCount() {
  const n = Number(process.env.LAST_SESSION_CONTEXT_COUNT);
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_COUNT, Math.floor(n)) : 1;
}

// Drop the cache (tests; a finalize could call it, but 30 s staleness is fine).
export function resetLastSessionCache() {
  cache = { at: 0, root: null, count: 0, value: [] };
}

function fmtDate(ms) {
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat('de-DE', {
      timeZone: process.env.FINALIZE_TZ || 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric',
    }).format(new Date(ms));
  } catch { return null; }
}

const PLACE = ['Letzte', 'Vorletzte', 'Drittletzte', 'Viertletzte', 'Fünftletzte'];

// Split `total` chars over texts of the given lengths: an equal share each, and
// what a short text leaves unused goes to the longer ones.
export function fairShares(lengths, total) {
  const shares = lengths.map(() => 0);
  let left = Math.max(0, total);
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b]);
  order.forEach((i, k) => {
    shares[i] = Math.min(lengths[i], Math.floor(left / (order.length - k)));
    left -= shares[i];
  });
  return shares;
}

// → system-block string, or '' (disabled / no finalized session with a summary).
export function lastSessionBlock({ now = Date.now() } = {}) {
  if (!lastSessionContextEnabled()) return '';
  const root = process.env.ARCHIVE_DIR ?? './archive';
  const count = lastSessionContextCount();
  if (cache.root !== root || cache.count !== count || now - cache.at > CACHE_MS) {
    cache = { at: now, root, count, value: latestSessionSummaries(root, { count }) };
  }
  const sessions = cache.value;
  if (!sessions.length) return '';
  const maxChars = lastSessionContextMaxChars();
  if (sessions.length === 1) {
    const date = fmtDate(sessions[0].sessionStartMs);
    return [
      `Zusammenfassung der letzten abgeschlossenen Sitzung${date ? ` (${date})` : ''} — nur verwenden, wenn danach gefragt wird; nicht ungefragt nacherzählen:`,
      capText(sessions[0].text, maxChars),
    ].join('\n');
  }
  const headings = sessions.map((s, i) => {
    const date = fmtDate(s.sessionStartMs);
    return `${PLACE[i]} Sitzung${date ? ` (${date})` : ''}:`;
  });
  // The headings and blank lines between the parts count against the cap too.
  const overhead = headings.reduce((n, h) => n + h.length + 1, 0) + 2 * (sessions.length - 1);
  const shares = fairShares(sessions.map((s) => s.text.length), maxChars - overhead);
  const parts = sessions.map((s, i) => [headings[i], capText(s.text, shares[i])])
    .filter(([, text]) => text)
    .map(([heading, text]) => `${heading}\n${text}`);
  return [
    'Zusammenfassungen der letzten abgeschlossenen Sitzungen, neueste zuerst — nur verwenden, wenn danach gefragt wird; nicht ungefragt nacherzählen:',
    parts.join('\n\n'),
  ].join('\n');
}
