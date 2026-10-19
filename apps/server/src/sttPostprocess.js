// STT post-processing of finished utterances — two clean-ups after Whisper,
// applied wherever a transcript leaves the STT layer: the live pipeline
// (JSONL, live view, wake word, LLM context), the streaming/progress partials
// and the finalize re-STT spans.
//
// Correction map (optional, empty by default)
//   STT_CORRECTIONS       inline rules, separated by comma, semicolon or newline
//   STT_CORRECTIONS_FILE  a file with the same rules — absolute, or relative to
//                         OBSIDIAN_VAULT_PATH (like STT_VOCABULARY_FILE).
//                         `#` starts a comment, list markers and YAML
//                         frontmatter are stripped.
//   One rule: `falsch => richtig`; several wrong forms share one target with
//   `|`: `Gaaglath | GaGlath => Gaglath`. Matching is case-insensitive and on
//   whole words only ("Rhoga" fixes "rhoga," but never "Rhogar"); the target
//   is written as given. All rules run in ONE pass, longest wrong form first,
//   so a replacement is never corrected again — and a rule whose target
//   contains its own wrong form as a word would grow the text on every pass,
//   so keep targets free of it. Inline rules come first; for a wrong form
//   listed twice the first rule wins. Read per call (cached on the setting and
//   the file's mtime), like the vocabulary.
//
// Hallucination filter (on by default)
//   STT_HALLUCINATION_FILTER   false = off
//   STT_HALLUCINATION_PHRASES  phrases separated by semicolon or newline;
//                              empty = DEFAULT_HALLUCINATION_PHRASES. A
//                              trailing `*` also matches any continuation
//                              ("Untertitel im Auftrag des ZDF*").
//   Whisper fills noise and near-silence with stock phrases from its subtitle
//   training data. An utterance is dropped only when ALL of it is such
//   phrases (one or several, compared without case, punctuation and
//   apostrophes) — the same words inside real speech are kept. Drops are
//   logged at debug level.

import fs from 'fs';
import { log, warn } from './logger.js';
import { settingFilePath, settingFileStat } from './sttVocabulary.js';

// ── correction map ───────────────────────────────────────────────────────────

const keyOf = (s) => String(s ?? '').toLocaleLowerCase('de').replace(/\s+/g, ' ').trim();

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Text → { rules: [{ from, to }], invalid: [entry] }.
export function parseCorrections(text) {
  const src = String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, ''); // frontmatter
  const rules = [];
  const invalid = [];
  const seen = new Set();
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
    for (const part of line.split(/[,;]/)) {
      const entry = part.trim();
      if (!entry) continue;
      const m = /^(.*?)(?:=>|→)(.*)$/.exec(entry);
      const to = m ? m[2].replace(/\s+/g, ' ').trim() : '';
      const froms = m ? m[1].split('|').map((f) => f.replace(/\s+/g, ' ').trim()).filter(Boolean) : [];
      if (!to || froms.length === 0) { invalid.push(entry); continue; }
      for (const from of froms) {
        const key = keyOf(from);
        if (from === to || seen.has(key)) continue;
        seen.add(key);
        rules.push({ from, to });
      }
    }
  }
  return { rules, invalid };
}

// rules → { re, map, maxWords } or null. `re` matches any wrong form on word
// boundaries (Unicode letters/digits), longest first.
export function compileCorrections(rules) {
  if (!rules?.length) return null;
  const sorted = rules.slice().sort((a, b) => b.from.length - a.from.length);
  const body = sorted.map((r) => r.from.split(' ').map(escapeRegex).join('\\s+')).join('|');
  return {
    re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'giu'),
    map: new Map(rules.map((r) => [keyOf(r.from), r.to])),
    maxWords: Math.max(...rules.map((r) => r.from.split(' ').length)),
  };
}

let corrCache = { key: null, value: null };
const warnedLists = new Set();

// The effective correction map: { rules, matcher, file }.
export function currentCorrections() {
  const inline = process.env.STT_CORRECTIONS ?? '';
  const fp = settingFilePath('STT_CORRECTIONS_FILE');
  const stat = settingFileStat('STT_CORRECTIONS_FILE', fp);
  const key = `${inline}\0${fp}\0${stat ? `${stat.mtimeMs}:${stat.size}` : '-'}`;
  if (corrCache.key === key) return corrCache.value;

  let fileText = '';
  if (stat) {
    try { fileText = fs.readFileSync(fp, 'utf8'); }
    catch (e) { warn(`stt: STT_CORRECTIONS_FILE ${fp} read failed: ${e.message}`); }
  }
  const { rules, invalid } = parseCorrections(`${inline}\n${fileText}`);
  const value = { rules, matcher: compileCorrections(rules), file: stat ? fp : null };
  corrCache = { key, value };
  if (rules.length) log(`stt: correction map: ${rules.length} rules${value.file ? ` (file ${value.file})` : ''}`);
  if (invalid.length && !warnedLists.has(key)) {
    warnedLists.add(key);
    warn(`stt: ${invalid.length} correction entries ignored (expected "falsch => richtig"): `
      + invalid.slice(0, 3).map((e) => JSON.stringify(e)).join(', '));
  }
  return value;
}

// Text with every wrong form replaced. No rules → the input unchanged.
export function applyCorrections(text, corrections = currentCorrections()) {
  const m = corrections?.matcher;
  if (!m || !text) return text;
  return String(text).replace(m.re, (hit) => m.map.get(keyOf(hit)) ?? hit);
}

// The same on a word-timestamp list [{ w, t0, t1 }] (finalize renders
// interrupted utterances from these, not from the text). A multi-word wrong
// form ("Ga Glath") merges its words into one that spans their times;
// punctuation around the words stays.
export function correctWords(words, corrections = currentCorrections()) {
  const m = corrections?.matcher;
  if (!m || !Array.isArray(words) || words.length === 0) return words;
  const out = [];
  for (let i = 0; i < words.length;) {
    let merged = false;
    for (let k = Math.min(m.maxWords, words.length - i); k >= 2; k--) {
      const seg = words.slice(i, i + k);
      const parts = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(seg.map((w) => String(w.w ?? '')).join(' '));
      const to = m.map.get(keyOf(parts[2]));
      if (to === undefined) continue;
      out.push({ ...seg[0], w: `${parts[1]}${to}${parts[3]}`, t1: seg[k - 1].t1 });
      i += k;
      merged = true;
      break;
    }
    if (merged) continue;
    const w = words[i++];
    const fixed = applyCorrections(w.w, corrections);
    out.push(fixed === w.w ? w : { ...w, w: fixed });
  }
  return out;
}

// ── hallucination filter ─────────────────────────────────────────────────────

// German Whisper fillers nobody at the table says as a whole utterance. The
// first three are from our own sessions (round 2 with vocabulary: 49×).
export const DEFAULT_HALLUCINATION_PHRASES = [
  'Vielen Dank fürs Zuschauen',
  'Danke fürs Zuschauen',
  'Vielen Dank für das Zuhören',
  'Vielen Dank für Ihre Aufmerksamkeit',
  'Untertitel im Auftrag des ZDF*',
  'Untertitelung im Auftrag des ZDF*',
  'Untertitel der Amara.org-Community',
  'Untertitel von Stephanie Geiges',
  'Untertitelung aufgrund der Audioqualität nicht möglich',
];

// Lower case, no apostrophes ("für's" = "fürs"), other non-letters → space.
const normPhrase = (s) => String(s ?? '').toLocaleLowerCase('de')
  .replace(/['’`´]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function hallucinationFilterEnabled() {
  return (process.env.STT_HALLUCINATION_FILTER ?? 'true') !== 'false';
}

let phraseCache = { key: null, value: [] };

// [{ phrase, norm, prefix }], longest first.
export function hallucinationPhrases() {
  const raw = process.env.STT_HALLUCINATION_PHRASES ?? '';
  if (phraseCache.key === raw) return phraseCache.value;
  const list = raw.trim() ? raw.split(/[;\r\n]+/) : DEFAULT_HALLUCINATION_PHRASES;
  const value = list
    .map((p) => p.trim())
    .filter(Boolean)
    .map((phrase) => ({ phrase, norm: normPhrase(phrase.replace(/\*\s*$/, '')), prefix: /\*\s*$/.test(phrase) }))
    .filter((p) => p.norm)
    .sort((a, b) => b.norm.length - a.norm.length);
  phraseCache = { key: raw, value };
  return value;
}

// The phrase `text` consists of (the first one, for the log), or null when the
// filter is off or any real word is left over.
export function matchHallucination(text) {
  if (!hallucinationFilterEnabled()) return null;
  const phrases = hallucinationPhrases();
  let rest = normPhrase(text);
  if (!rest || phrases.length === 0) return null;
  let first = null;
  while (rest) {
    const p = phrases.find((x) => rest === x.norm || rest.startsWith(`${x.norm} `));
    if (!p) return null;
    first ??= p.phrase;
    rest = p.prefix ? '' : rest.slice(p.norm.length).trim();
  }
  return first;
}

// ── one utterance ────────────────────────────────────────────────────────────

// { segments, words } of one finished utterance → { dropped, segments, words }.
//   dropped  the hallucination phrase it consisted of (segments [], words
//            null), else null.
//   segments / words  with the correction map applied.
export function postprocessUtterance({ segments = [], words = null } = {}) {
  const dropped = matchHallucination(segments.join(' '));
  if (dropped) return { dropped, segments: [], words: null };
  const corrections = currentCorrections();
  if (!corrections.matcher) return { dropped: null, segments, words };
  return {
    dropped: null,
    segments: segments.map((s) => applyCorrections(s, corrections)),
    words: correctWords(words, corrections),
  };
}

// Description for the session_meta snapshot.
export function postprocessConfig() {
  const c = currentCorrections();
  return {
    corrections: { rules: c.rules.length, file: c.file },
    hallucinationFilter: hallucinationFilterEnabled()
      ? { phrases: hallucinationPhrases().length, custom: !!(process.env.STT_HALLUCINATION_PHRASES ?? '').trim() }
      : false,
  };
}

// Test hook.
export function _resetPostprocessCache() {
  corrCache = { key: null, value: null };
  phraseCache = { key: null, value: [] };
  warnedLists.clear();
}
