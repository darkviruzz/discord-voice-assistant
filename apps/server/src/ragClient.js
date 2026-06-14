// RAG client — thin HTTP wrapper around the Python RAG service (apps/rag/).
//
// The service does semantic search over the Obsidian vault. This client is
// deliberately fail-soft: if RAG_URL is unset, the service is down, or it is
// slow, every call resolves to '' so the caller can fall back (e.g. to the
// static CAMPAIGN.md) without the voice pipeline ever blocking on it.
//
// `fetch` is native in Node 22 — no extra dependency.

import { warn, debug } from './logger.js';

function ragUrl() {
  const url = process.env.RAG_URL;
  return url && url.trim() ? url.replace(/\/+$/, '') : null;
}

function timeoutMs() {
  const v = Number(process.env.RAG_TIMEOUT_MS ?? 800);
  return Number.isFinite(v) && v > 0 ? v : 800;
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
// when RAG is unconfigured/unreachable/slow/empty. Never throws.
export async function queryRag(query, topK = 3) {
  const base = ragUrl();
  if (!base) return '';
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) return '';

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs());
  try {
    const res = await fetch(`${base}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: text, top_k: topK }),
      signal: ac.signal,
    });
    if (!res.ok) {
      warn(`ragClient: HTTP ${res.status}`);
      return '';
    }
    const data = await res.json();
    const results = Array.isArray(data) ? data : (data?.results ?? []);
    const out = formatChunks(Array.isArray(results) ? results : []);
    debug(`ragClient: query "${text.slice(0, 40)}" → ${out.length} chars`);
    return out;
  } catch (e) {
    // AbortError (timeout) and connection errors both degrade to ''.
    debug(`ragClient: query failed (degrading to fallback): ${e.message}`);
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
