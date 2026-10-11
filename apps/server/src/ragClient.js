// RAG client — thin HTTP wrapper around the Python RAG service (apps/rag/).
//
// The service does semantic search over the Obsidian vault. This client is
// deliberately fail-soft: if RAG_URL is unset, the service is down, or it is
// slow, every call resolves to '' so the caller can fall back (e.g. to the
// static CAMPAIGN.md) without the voice pipeline ever blocking on it.
//
// Contract (apps/rag/server.py):
//   POST /query  {query: str, top_k: int 1..20, score_threshold?: float >= 0}
//             →  [{text, source, distance?}]   (closest chunks first)
// `distance` is the cosine distance (0 = identical .. 2 = opposite);
// score_threshold is the max distance a hit may have to be kept.
//
// `fetch` is native in Node 22 — no extra dependency.

import { log, warn, debug } from './logger.js';

const DEFAULT_TIMEOUT_MS = 800;
// setTimeout() clamps larger delays to 1 ms (TimeoutOverflowWarning), which
// would abort every query instantly.
const MAX_TIMEOUT_MS = 2_147_483_647;
// The service rejects top_k outside 1..20 with HTTP 422 (pydantic Field).
const MAX_TOP_K = 20;
const DEFAULT_TOP_K = 3;

function ragUrl() {
  const url = (process.env.RAG_URL ?? '').trim();
  return url ? url.replace(/\/+$/, '') : null;
}

function timeoutMs() {
  const v = Number(process.env.RAG_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

// Max cosine distance for /query hits, read fresh on every call (settings-panel
// friendly). Empty/unset/invalid/negative → null, meaning "no filter" — the
// RAG service then falls back to its own RAG_SCORE_THRESHOLD default, if any.
function scoreThreshold() {
  const raw = process.env.RAG_SCORE_THRESHOLD;
  if (!raw || !raw.trim()) return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function clampTopK(topK) {
  const v = Number(topK);
  return Number.isFinite(v) && v >= 1 ? Math.min(MAX_TOP_K, Math.floor(v)) : DEFAULT_TOP_K;
}

// Effective RAG settings as the client applies them (session_meta report).
export function ragConfig() {
  return { url: ragUrl(), timeoutMs: timeoutMs(), scoreThreshold: scoreThreshold() };
}

// Reachability state, only used to keep the log readable: warn once when RAG
// starts failing (a typo in RAG_URL must not hide behind DEBUG), stay quiet
// while it keeps failing, and log once when it recovers.
let failing = false;

function noteFailure(reason) {
  if (failing) {
    debug(`ragClient: query failed (degrading to fallback): ${reason}`);
    return;
  }
  failing = true;
  warn(`ragClient: RAG unavailable (${reason}) — falling back to CAMPAIGN.md until it recovers`);
}

function noteSuccess() {
  if (!failing) return;
  failing = false;
  log('ragClient: RAG reachable again');
}

// Render the service's [{ text, source }] result into a compact text block,
// one chunk per paragraph, each prefixed with its source for traceability.
function formatChunks(results) {
  return results
    .filter((r) => r && typeof r.text === 'string' && r.text.trim())
    .map((r) => {
      const src = r.source ? `[Quelle: ${r.source}]\n` : '';
      return `${src}${r.text.trim()}`;
    })
    .join('\n\n');
}

// Query the RAG service. Returns the top-k chunks joined into one string, or ''
// when RAG is unconfigured/unreachable/slow/empty. Never throws. The whole
// exchange (connect, headers and body) is bounded by RAG_TIMEOUT_MS unless the
// caller passes its own `timeoutMs` (off-hot-path callers like the briefing).
export async function queryRag(query, topK = DEFAULT_TOP_K, { timeoutMs: timeoutOverride } = {}) {
  const base = ragUrl();
  if (!base) return '';
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) return '';

  // score_threshold is only sent when configured — older RAG services would
  // ignore an unknown field anyway, but omitting it keeps the body minimal.
  const threshold = scoreThreshold();
  const body = { query: text, top_k: clampTopK(topK) };
  if (threshold !== null) body.score_threshold = threshold;

  const limit = Number.isFinite(timeoutOverride) && timeoutOverride > 0
    ? Math.min(timeoutOverride, MAX_TIMEOUT_MS)
    : timeoutMs();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), limit);
  try {
    const res = await fetch(`${base}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      // Release the connection instead of leaving the unread body to the GC.
      res.body?.cancel().catch(() => {});
      noteFailure(`HTTP ${res.status}`);
      return '';
    }
    const data = await res.json();
    const results = Array.isArray(data) ? data
      : Array.isArray(data?.results) ? data.results
        : null;
    if (!results) {
      noteFailure('unexpected response shape (expected a JSON array of {text, source})');
      return '';
    }
    noteSuccess();
    const out = formatChunks(results);
    debug(`ragClient: query "${text.slice(0, 40)}" → ${out.length} chars`);
    return out;
  } catch (e) {
    // AbortError (timeout), connection errors and malformed JSON all degrade to ''.
    const reason = ac.signal.aborted
      ? `timeout after ${limit} ms`
      : (e.cause?.code || e.cause?.message || e.message);
    noteFailure(reason);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// True when RAG is configured (used to decide whether to prefer it over the
// static campaign file). Does not check reachability.
export function ragEnabled() {
  return ragUrl() !== null;
}

// Test hook: forget the reachability state (log de-duplication).
export function _resetState() { failing = false; }
