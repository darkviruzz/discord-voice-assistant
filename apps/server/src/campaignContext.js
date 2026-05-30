// Campaign context (Variante A — static file).
//
// Reads a single hand-/Cowork-maintained file (CAMPAIGN.md) from the Obsidian
// vault and returns it as a compact text block to prepend as a `system` message
// for both the answer LLM and the rolling summarizer (so proper names are known
// to be "game-relevant"). Cached with an mtime check so edits take effect
// without a server restart.
//
// The signature takes an optional `query` so this can later be swapped for a
// semantic RAG lookup (Phase 4) without changing callers.

import fs from 'fs';
import path from 'path';
import { warn, debug } from './logger.js';

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

// Returns the campaign-context text, or '' when unavailable/disabled.
// `query` is currently ignored (RAG hook for later).
export function getCampaignContext(query = null) {
  if ((process.env.LIVE_CONTEXT_ENABLED ?? 'true') === 'false') return '';
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

// Test/diagnostic hook.
export function _resetCache() { cache = { path: null, mtimeMs: 0, content: '' }; }
