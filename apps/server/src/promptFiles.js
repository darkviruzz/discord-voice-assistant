// Prompt texts from files — so the campaign vault can carry them.
//
// The server's LLM prompts are built in, and each can be replaced by a file:
//
//   SYSTEM_PROMPT_FILE                 persona / answer prompt (llm.js)
//   SESSION_SUMMARY_PART_PROMPT_FILE   finalize: one part of the transcript
//   SESSION_SUMMARY_FINAL_PROMPT_FILE  finalize: the session summary
//   LIVE_SUMMARY_PROMPT_FILE           rolling live summary (rollingSummary.js)
//
// Path: absolute; "./…" or "../…" = relative to the server's working directory
// (apps/server — the old meaning of SYSTEM_PROMPT_FILE=./prompt.txt); any other
// relative path = relative to OBSIDIAN_VAULT_PATH (without a vault: the
// working directory). Starter files: docs/prompts/.
//
// The file is a normal Obsidian note: YAML frontmatter and %% comments %% are
// removed, the rest goes to the model as written. Read per call (statSync +
// cache on mtime/size), so an edit applies to the next call. A missing,
// unreadable or empty file falls back to the built-in text with one warning
// (again only after the file was readable in between or the path changed).

import fs from 'fs';
import path from 'path';
import { log, warn } from './logger.js';

// Note text → prompt text: BOM, frontmatter and %% comments %% removed, line
// ends normalised, runs of blank lines a removed comment leaves collapsed.
export function stripNoteMarkup(text) {
  return String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/, '')
    .replace(/%%[\s\S]*?%%/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The file a prompt setting names, resolved (see above). null when unset.
export function promptFilePath(key) {
  const file = String(process.env[key] ?? '').trim();
  if (!file) return null;
  if (path.isAbsolute(file)) return file;
  // Relative paths may be written Windows-style ("..\prompts\p.md",
  // "Rabenauge\Konfiguration\…"); on Linux a backslash is a file-name
  // character, so normalise before resolving (Windows takes / as well).
  const rel = file.replace(/\\/g, '/');
  if (/^\.\.?\//.test(rel)) return path.resolve(rel);
  const vault = String(process.env.OBSIDIAN_VAULT_PATH ?? '').trim();
  return path.resolve(vault || '.', rel);
}

const cache = new Map(); // key → { fp, sig, text }
const warned = new Set();

function warnOnce(key, fp, reason, fallback) {
  const id = `${key}\0${fp}\0${reason}`;
  if (warned.has(id)) return;
  warned.add(id);
  warn(`prompt: ${key} ${fp} ${reason} — using the ${fallback} prompt`);
}

// The prompt for `key`: the file's text, or `builtin` when no file is set or
// it gives nothing. `fallbackName` only names the fallback in the warning.
export function promptText(key, builtin, { fallbackName = 'built-in' } = {}) {
  const fp = promptFilePath(key);
  if (!fp) { cache.delete(key); return builtin; }
  let st;
  try { st = fs.statSync(fp); } catch (e) {
    cache.delete(key);
    warnOnce(key, fp, `not readable (${e.code || e.message})`, fallbackName);
    return builtin;
  }
  const sig = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(key);
  if (hit && hit.fp === fp && hit.sig === sig) return hit.text || builtin;

  let text = '';
  try { text = stripNoteMarkup(fs.readFileSync(fp, 'utf8')); } catch (e) {
    cache.delete(key);
    warnOnce(key, fp, `not readable (${e.code || e.message})`, fallbackName);
    return builtin;
  }
  cache.set(key, { fp, sig, text });
  if (!text) {
    warnOnce(key, fp, 'is empty (frontmatter and %% comments %% do not count)', fallbackName);
    return builtin;
  }
  // Readable again: a later failure is worth a new warning.
  for (const id of warned) if (id.startsWith(`${key}\0`)) warned.delete(id);
  log(`prompt: ${key} loaded from ${fp} (${text.length} chars)`);
  return text;
}

// Test hook.
export function _resetPromptCache() {
  cache.clear();
  warned.clear();
}
