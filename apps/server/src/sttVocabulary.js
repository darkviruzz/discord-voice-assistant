// STT vocabulary — campaign names as a Whisper decoder prompt.
//
// Whisper reads its `prompt` as "the transcript so far": names spelled there
// are much more likely to come out spelled that way ("Gaglath Matho" instead
// of "Gaglat Mato"). The list comes from two optional server settings:
//
//   STT_VOCABULARY       inline list (comma, semicolon or newline separated)
//   STT_VOCABULARY_FILE  a file with the same format — absolute, or relative to
//                        OBSIDIAN_VAULT_PATH (like CAMPAIGN_CONTEXT_FILE).
//                        One or more names per line; `#` starts a comment (so
//                        Markdown headings are ignored), list markers, YAML
//                        frontmatter and [[wikilinks]] are stripped — a
//                        reviewed Obsidian note works as is.
//
// Inline names come first, then the file's; duplicates are dropped. Order is
// priority: the list is cut to VOCAB_MAX_CHARS, later names are left out (one
// warning per change of the list).
//
// Budget. Whisper (whisper.cpp and the OpenAI API alike) only reads the LAST
// 224 prompt tokens and drops the front, and the providers cut the prompt to
// its last 500 chars. The vocabulary goes FIRST (the recent transcript right
// before the audio matters most for continuity), so the whole prompt is built
// to fit: vocabulary ≤ 250 chars (~100 tokens even for odd fantasy names at
// ~2.5 chars/token), then as much of the context as the remaining
// PROMPT_MAX_CHARS allow — the context is shortened, never the vocabulary.
//
// Read per call (statSync + cache on mtime), so a panel change or an edited
// file applies to the next STT request.
//
// Short utterances. On a cough, a laugh or a single word the audio carries
// little to decode, and Whisper leans on the prompt instead: a name list turns
// noise into "Gnoll." or "Vielen Dank fürs Zuschauen." (round-2 logs: 41 of 49
// such fillers came from ≤ 1.2 s of audio). Utterances shorter than
// STT_VOCABULARY_MIN_MS (default 1200, 0 = always) therefore get the normal
// context but no vocabulary. They are still transcribed: this is no minimum
// utterance length.

import fs from 'fs';
import path from 'path';
import { log, warn, debug } from './logger.js';

export const PROMPT_MAX_CHARS = 500;
export const VOCAB_MAX_CHARS = 250;

// Utterances shorter than this (ms) are prompted without the vocabulary.
// Empty or garbage → the default; only an explicit 0 means "always".
export function vocabularyMinMs() {
  const raw = String(process.env.STT_VOCABULARY_MIN_MS ?? '1200').trim();
  const n = raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 1200;
}

// Text → names, in order, deduplicated case-insensitively.
// A settings file's text without BOM and YAML frontmatter. Needed before the
// file is appended to the inline setting: "inline\n---\n…" no longer starts
// with the frontmatter, so the parsers' own (start-anchored) strip misses it
// and the frontmatter lines would become names / correction entries.
export function stripFileFrontmatter(text) {
  return String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
}

export function parseVocabulary(text) {
  const src = String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '') // frontmatter
    .replace(/%%[\s\S]*?%%/g, '');                              // Obsidian comments
  const out = [];
  const seen = new Set();
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine
      // [[path/Note#Heading|Alias]] → Note (before `#` is read as a comment)
      .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g, (_, t) => t.split('/').pop())
      .replace(/#.*/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '');
    for (const part of line.split(/[,;]/)) {
      const name = part.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().replace(/[.:!?]+$/, '');
      if (!name) continue;
      const key = name.toLocaleLowerCase('de');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

// names → { text, used, dropped }. `text` is "A, B, C." and at most maxChars
// long; names are taken in order until the next one no longer fits.
export function vocabularyPrompt(names, maxChars = VOCAB_MAX_CHARS) {
  const used = [];
  let len = 1; // the closing "."
  let i = 0;
  for (; i < names.length; i++) {
    const add = (used.length ? 2 : 0) + names[i].length;
    if (len + add > maxChars) break;
    used.push(names[i]);
    len += add;
  }
  return { text: used.length ? `${used.join(', ')}.` : '', used, dropped: names.slice(i) };
}

// Vocabulary first, then the context's tail in the room that is left. A cut
// that lands inside a word drops that partial word.
export function joinPrompt(vocab, context, maxChars = PROMPT_MAX_CHARS) {
  const v = String(vocab ?? '').trim();
  const full = String(context ?? '').replace(/\s+/g, ' ').trim();
  const room = maxChars - (v ? v.length + 1 : 0);
  let c = full;
  if (c.length > room) {
    c = room > 0 ? full.slice(full.length - room) : '';
    const sp = c.indexOf(' ');
    if (c && full[full.length - room - 1] !== ' ' && sp >= 0) c = c.slice(sp + 1);
    c = c.trim();
  }
  const out = [v, c].filter(Boolean).join(' ');
  return out || undefined;
}

let cache = { key: null, value: null };
const warned = new Set();

function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  warn(msg);
}

// The file a *_FILE setting names: absolute, or relative to
// OBSIDIAN_VAULT_PATH. null when unset (or relative without a vault).
// Shared with sttPostprocess.js (STT_CORRECTIONS_FILE).
export function settingFilePath(key) {
  const file = (process.env[key] ?? '').trim();
  if (!file) return null;
  if (path.isAbsolute(file)) return file;
  const vault = (process.env.OBSIDIAN_VAULT_PATH ?? '').trim();
  if (!vault) {
    warnOnce(`novault|${key}|${file}`, `stt: ${key} "${file}" is relative but OBSIDIAN_VAULT_PATH is empty — file ignored`);
    return null;
  }
  return path.resolve(vault, file);
}

// statSync of a settings file, or null (warned once per path) when missing.
export function settingFileStat(key, fp) {
  if (!fp) return null;
  try { return fs.statSync(fp); }
  catch (e) {
    warnOnce(`missing|${fp}`, `stt: ${key} ${fp} not readable (${e.code || e.message}) — file ignored`);
    return null;
  }
}

// The effective vocabulary: { names, text, used, dropped, file }.
export function currentVocabulary() {
  const inline = process.env.STT_VOCABULARY ?? '';
  const fp = settingFilePath('STT_VOCABULARY_FILE');
  const stat = settingFileStat('STT_VOCABULARY_FILE', fp);
  const key = `${inline}\0${fp}\0${stat ? `${stat.mtimeMs}:${stat.size}` : '-'}`;
  if (cache.key === key) return cache.value;

  let fileText = '';
  if (stat) {
    try { fileText = fs.readFileSync(fp, 'utf8'); }
    catch (e) { warn(`stt: STT_VOCABULARY_FILE ${fp} read failed: ${e.message}`); }
  }
  const names = parseVocabulary(`${inline}\n${stripFileFrontmatter(fileText)}`);
  const value = { names, ...vocabularyPrompt(names), file: stat ? fp : null };
  cache = { key, value };
  if (names.length) {
    log(`stt: vocabulary prompt: ${value.used.length} names, ${value.text.length} chars${value.file ? ` (file ${value.file})` : ''}`);
  }
  if (value.dropped.length) {
    warn(`stt: vocabulary is longer than ${VOCAB_MAX_CHARS} chars — ${value.dropped.length} of ${names.length} names left out `
      + `of the prompt (from "${value.dropped[0]}" on). Order = priority; shorten or reorder the list.`);
  }
  return value;
}

// The prompt for one STT request: vocabulary + `context` (already-committed
// text, or nothing). undefined when there is neither. `audioMs` = length of
// the whole utterance (not just the window sent); below vocabularyMinMs() the
// vocabulary is left out. Unknown length → vocabulary as usual.
export function sttPrompt(context, { audioMs } = {}) {
  const vocab = currentVocabulary().text;
  if (vocab && Number.isFinite(audioMs) && audioMs < vocabularyMinMs()) {
    debug(`stt: ${Math.round(audioMs)} ms utterance < STT_VOCABULARY_MIN_MS ${vocabularyMinMs()} — prompt without vocabulary`);
    return joinPrompt('', context);
  }
  return joinPrompt(vocab, context);
}

// Test hook.
export function _resetVocabularyCache() {
  cache = { key: null, value: null };
  warned.clear();
}
