// Campaign context — semantic RAG lookup with a static-file fallback.
//
// When RAG_URL is set, `query` is sent to the Python RAG service (apps/rag/),
// which returns the most relevant vault chunks for the current wake-word text.
// When RAG is unset/unreachable/empty, this degrades to Variante A: a single
// hand-/Cowork-maintained file (CAMPAIGN.md) read from the Obsidian vault,
// cached with an mtime check so edits take effect without a server restart.
//
// The result is prepended as a `system` block for both the answer LLM and the
// rolling summarizer (so proper names are known to be "game-relevant").

import fs from 'fs';
import path from 'path';
import { warn, debug } from './logger.js';
import { queryRag, ragEnabled } from './ragClient.js';

let cache = { path: null, mtimeMs: 0, content: '' };

function contextFilePath() {
  const file = process.env.CAMPAIGN_CONTEXT_FILE ?? 'CAMPAIGN.md';
  if (path.isAbsolute(file)) return file;
  const vault = process.env.OBSIDIAN_VAULT_PATH;
  if (!vault) return null; // relative file but no vault root → feature disabled
  return path.resolve(vault, file);
}

function maxChars() {
  const v = Number(process.env.CAMPAIGN_CONTEXT_MAX_CHARS ?? 6000);
  return Number.isFinite(v) ? Math.max(0, v) : 6000;
}

// Truncate to a char budget, preferring a clean cut at a line/word boundary
// near the limit (keeps the front — the file is authored most-important-first).
function truncate(text, limit) {
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const lastNl = head.lastIndexOf('\n');
  if (lastNl >= limit * 0.6) return head.slice(0, lastNl).trimEnd();
  const lastSp = head.lastIndexOf(' ');
  return (lastSp >= limit * 0.6 ? head.slice(0, lastSp) : head).trimEnd();
}

// Synchronous read of the static CAMPAIGN.md (the fallback path). Returns the
// cached/truncated file content, or '' when unavailable/disabled.
function readCampaignFile() {
  const fp = contextFilePath();
  if (!fp) return '';
  let stat;
  try {
    stat = fs.statSync(fp);
  } catch {
    return ''; // missing file → degrade silently
  }
  if (cache.path === fp && cache.mtimeMs === stat.mtimeMs) {
    return cache.content;
  }
  try {
    const raw = fs.readFileSync(fp, 'utf8').trim();
    const content = truncate(raw, maxChars());
    cache = { path: fp, mtimeMs: stat.mtimeMs, content };
    debug(`campaignContext: loaded ${content.length} chars from ${fp}`);
    return content;
  } catch (e) {
    warn('campaignContext: read failed:', e.message);
    return '';
  }
}

// Cap vault text (RAG hits) at the same CAMPAIGN_CONTEXT_MAX_CHARS budget as
// the static file. RAG chunks are whole `##` sections — a note without
// headings is one arbitrarily large chunk — so this bound is what keeps the
// prompt size predictable. Hits arrive most-relevant-first, so keeping the
// front keeps the best ones.
export function capCampaignContext(text) {
  return truncate(String(text ?? '').trim(), maxChars());
}

// Returns the campaign-context text for `query`, or '' when unavailable/disabled.
//
// Async because the RAG path is an HTTP call. When RAG_URL is set and the query
// is non-empty, a semantic vault lookup is preferred; an empty/failed RAG result
// transparently falls back to the static CAMPAIGN.md (existing behaviour).
// Added latency is bounded by RAG_TIMEOUT_MS.
export async function getCampaignContext(query = null) {
  if ((process.env.LIVE_CONTEXT_ENABLED ?? 'true') === 'false') return '';
  if (ragEnabled() && typeof query === 'string' && query.trim()) {
    const rag = capCampaignContext(await queryRag(query));
    if (rag) return rag;
    // RAG unreachable/empty → fall through to the static file.
  }
  return readCampaignFile();
}

// Test/diagnostic hook.
export function _resetCache() { cache = { path: null, mtimeMs: 0, content: '' }; }
