// STT vocabulary prompt: parsing, budget (vocabulary first, never cut; the
// context gives way), loading from STT_VOCABULARY / STT_VOCABULARY_FILE, and
// the settings contract for the two keys.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseVocabulary, vocabularyPrompt, joinPrompt, currentVocabulary, sttPrompt,
  PROMPT_MAX_CHARS, VOCAB_MAX_CHARS, _resetVocabularyCache,
} from '../src/sttVocabulary.js';
import { catalogEntry } from '../src/configCatalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const repoDir = path.resolve(serverDir, '../..');

const KEYS = ['STT_VOCABULARY', 'STT_VOCABULARY_FILE', 'OBSIDIAN_VAULT_PATH'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  _resetVocabularyCache();
});

// Capture console.warn (the logger's warn) for one call.
function captureWarn(fn) {
  const orig = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try { return { value: fn(), lines }; } finally { console.warn = orig; }
}

const NAMES = ['Gaglath Matho', 'Rhogar Tonitruvales', 'Uhtred Ragnason', 'Greyhawk'];

// ── parsing ──────────────────────────────────────────────────────────────────

test('parseVocabulary: inline list — commas, semicolons, newlines, trimmed, deduplicated', () => {
  assert.deepEqual(parseVocabulary('Gaglath Matho, Rhogar Tonitruvales;Uhtred Ragnason\n  Greyhawk  ,, '), NAMES);
  assert.deepEqual(parseVocabulary('Greyhawk, greyhawk, GREYHAWK'), ['Greyhawk'], 'case-insensitive duplicates');
  assert.deepEqual(parseVocabulary('A, B, C.'), ['A', 'B', 'C'], 'a closing full stop is not part of a name');
  assert.deepEqual(parseVocabulary("So'Rel, Mr. Smith, Balthasar Roggifoort III"), ["So'Rel", 'Mr. Smith', 'Balthasar Roggifoort III']);
  assert.deepEqual(parseVocabulary(''), []);
  assert.deepEqual(parseVocabulary(undefined), []);
});

test('parseVocabulary: a reviewed Obsidian note works as is', () => {
  const note = [
    '﻿---',
    'tags: [stt]',
    'aliases: Nicht-Mitlesen',
    '---',
    '# STT-Vokabular',
    '',
    '## Spielercharaktere',
    '- [[20_Party/Characters/Gaglath Matho|Gaglath]]',
    '* **Rhogar Tonitruvales**   # PC · 9/10 Sessions',
    '1. [[Uhtred Ragnason#Hintergrund]]',
    '- [ ] Greyhawk',
    '# Hagrid der Haarige   # auskommentierter Kandidat',
    '%% Obsidian-Kommentar',
    'Versteckt %%',
    'Kjartan; Highport',
  ].join('\r\n');
  assert.deepEqual(parseVocabulary(note), [...NAMES, 'Kjartan', 'Highport']);
});

// ── budget ───────────────────────────────────────────────────────────────────

test('vocabularyPrompt: "A, B, C." in list order, cut at the first name that no longer fits', () => {
  assert.deepEqual(vocabularyPrompt(NAMES), {
    text: 'Gaglath Matho, Rhogar Tonitruvales, Uhtred Ragnason, Greyhawk.', used: NAMES, dropped: [],
  });
  // 'Gaglath Matho, Rhogar Tonitruvales.' = 35 chars: fits exactly into 35.
  const r = vocabularyPrompt(NAMES, 35);
  assert.equal(r.text, 'Gaglath Matho, Rhogar Tonitruvales.');
  assert.deepEqual(r.dropped, ['Uhtred Ragnason', 'Greyhawk']);
  assert.equal(vocabularyPrompt(NAMES, 34).text, 'Gaglath Matho.');
  assert.deepEqual(vocabularyPrompt([]), { text: '', used: [], dropped: [] });

  const many = Array.from({ length: 60 }, (_, i) => `Nichtspielercharakter ${i}`);
  const big = vocabularyPrompt(many);
  assert.ok(big.text.length <= VOCAB_MAX_CHARS, `${big.text.length} > ${VOCAB_MAX_CHARS}`);
  assert.ok(big.used.length > 5 && big.dropped.length > 0);
  assert.deepEqual([...big.used, ...big.dropped], many, 'order kept, nothing lost silently');
});

test('budget constants: the whole prompt fits the providers\' 500-char cut and Whisper\'s 224 prompt tokens', () => {
  assert.ok(PROMPT_MAX_CHARS <= 500, 'providers keep only the last 500 chars');
  // Conservative chars/token: ~2.5 for fantasy names, ~3.5 for German prose.
  const tokens = VOCAB_MAX_CHARS / 2.5 + (PROMPT_MAX_CHARS - VOCAB_MAX_CHARS) / 3.5;
  assert.ok(tokens < 224, `~${Math.round(tokens)} tokens`);
});

test('joinPrompt: vocabulary first, context after, context shortened (at a word) — the vocabulary never', () => {
  const vocab = vocabularyPrompt(NAMES).text;
  assert.equal(joinPrompt(vocab, 'Das ist ein Satz.'), `${vocab} Das ist ein Satz.`);
  assert.equal(joinPrompt(vocab, undefined), vocab);
  assert.equal(joinPrompt(vocab, '   '), vocab);
  assert.equal(joinPrompt('', 'Das ist ein Satz.'), 'Das ist ein Satz.');
  assert.equal(joinPrompt('', ''), undefined);
  assert.equal(joinPrompt(undefined, undefined), undefined);

  const words = Array.from({ length: 200 }, (_, i) => `wort${i}`).join(' ') + ' ENDE.';
  const p = joinPrompt(vocab, words);
  assert.ok(p.length <= PROMPT_MAX_CHARS, String(p.length));
  assert.ok(p.startsWith(`${vocab} `), 'vocabulary intact at the front');
  assert.ok(p.endsWith('ENDE.'), 'most recent context kept');
  const ctx = p.slice(vocab.length + 1);
  assert.ok(words.endsWith(ctx), 'context = a tail of the original');
  assert.match(ctx, /^wort\d+ /, 'starts at a whole word');
  assert.ok(words.includes(` ${ctx}`), 'the cut word was dropped, not split');

  // Any length of either part: ≤ 500, vocabulary intact.
  for (const n of [0, 1, 5, 40, 400]) {
    const v = vocabularyPrompt(Array.from({ length: n }, (_, i) => `Name${i}`)).text;
    for (const len of [0, 10, 260, 499, 500, 501, 5000]) {
      const out = joinPrompt(v, 'x '.repeat(len)) ?? '';
      assert.ok(out.length <= PROMPT_MAX_CHARS, `n=${n} len=${len}: ${out.length}`);
      assert.ok(out.startsWith(v), `n=${n} len=${len}: vocabulary cut`);
    }
  }
});

test('joinPrompt without vocabulary keeps the old behaviour: last 500 chars of the context', () => {
  const p = joinPrompt('', 'x'.repeat(600) + 'ENDE');
  assert.equal(p.length, 500, 'one long "word" is kept as a raw tail');
  assert.ok(p.endsWith('ENDE'));
});

// ── loading ──────────────────────────────────────────────────────────────────

test('currentVocabulary: inline names first, then the file (relative to the vault); edits apply on the next call', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-vocab-'));
  try {
    const file = path.join(vault, 'STT-Vokabular.md');
    fs.writeFileSync(file, '# Liste\n- Uhtred Ragnason\n- Gaglath Matho\n');
    process.env.OBSIDIAN_VAULT_PATH = vault;
    process.env.STT_VOCABULARY_FILE = 'STT-Vokabular.md';
    process.env.STT_VOCABULARY = 'Gaglath Matho, Rhogar Tonitruvales';

    let v = currentVocabulary();
    assert.deepEqual(v.used, ['Gaglath Matho', 'Rhogar Tonitruvales', 'Uhtred Ragnason']);
    assert.equal(v.file, file);
    assert.equal(sttPrompt('Weiter geht es.'), 'Gaglath Matho, Rhogar Tonitruvales, Uhtred Ragnason. Weiter geht es.');

    fs.writeFileSync(file, '# Liste\n- Uhtred Ragnason\n- Greyhawk Stadt\n');
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(file, t, t); // make sure the mtime moves even on coarse clocks
    v = currentVocabulary();
    assert.deepEqual(v.used, ['Gaglath Matho', 'Rhogar Tonitruvales', 'Uhtred Ragnason', 'Greyhawk Stadt']);

    process.env.STT_VOCABULARY = '';
    assert.deepEqual(currentVocabulary().used, ['Uhtred Ragnason', 'Greyhawk Stadt'], 'panel change applies at once');

    process.env.STT_VOCABULARY_FILE = file; // absolute works too
    delete process.env.OBSIDIAN_VAULT_PATH;
    assert.deepEqual(currentVocabulary().used, ['Uhtred Ragnason', 'Greyhawk Stadt']);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('currentVocabulary: a vault note with frontmatter — the frontmatter never becomes names (with and without inline names)', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-vocab-fm-'));
  try {
    fs.writeFileSync(path.join(vault, 'STT-Vokabular.md'),
      '﻿---\r\ntags: [rabenauge/stt]\r\nrabenauge-setting: STT_VOCABULARY_FILE\r\n---\r\n# Spielercharaktere\r\nRabenauge\r\nWyvern   # Kommentar\r\n');
    process.env.OBSIDIAN_VAULT_PATH = vault;
    process.env.STT_VOCABULARY_FILE = 'STT-Vokabular.md';
    process.env.STT_VOCABULARY = '';
    assert.deepEqual(currentVocabulary().used, ['Rabenauge', 'Wyvern']);
    process.env.STT_VOCABULARY = 'Faylith';
    assert.deepEqual(currentVocabulary().used, ['Faylith', 'Rabenauge', 'Wyvern']);
  } finally {
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('currentVocabulary: nothing configured → no prompt; context passes through unchanged', () => {
  assert.deepEqual(currentVocabulary(), { names: [], text: '', used: [], dropped: [], file: null });
  assert.equal(sttPrompt(undefined), undefined);
  assert.equal(sttPrompt('Das ist ein Satz.'), 'Das ist ein Satz.');
});

test('currentVocabulary: missing file / relative file without vault → warned once, inline names still used', () => {
  process.env.STT_VOCABULARY = 'Greyhawk';
  process.env.STT_VOCABULARY_FILE = 'fehlt.md';
  let r = captureWarn(() => currentVocabulary());
  assert.deepEqual(r.value.used, ['Greyhawk']);
  assert.equal(r.value.file, null);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /relative but OBSIDIAN_VAULT_PATH is empty/);
  assert.equal(captureWarn(() => currentVocabulary()).lines.length, 0, 'not repeated per request');

  process.env.OBSIDIAN_VAULT_PATH = path.join(os.tmpdir(), 'kein-vault-hier-xyz');
  r = captureWarn(() => currentVocabulary());
  assert.deepEqual(r.value.used, ['Greyhawk']);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /not readable/);
  assert.equal(captureWarn(() => currentVocabulary()).lines.length, 0);
});

test('currentVocabulary: a list over budget is cut with ONE warning naming the first left-out name', () => {
  const many = Array.from({ length: 40 }, (_, i) => `Nichtspielercharakter ${i}`);
  process.env.STT_VOCABULARY = many.join(', ');
  const r = captureWarn(() => currentVocabulary());
  assert.ok(r.value.text.length <= VOCAB_MAX_CHARS);
  assert.equal(r.value.used.length + r.value.dropped.length, 40);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], new RegExp(`${r.value.dropped.length} of 40 names left out .*"${r.value.dropped[0]}"`));
  assert.equal(captureWarn(() => { currentVocabulary(); sttPrompt('x'); }).lines.length, 0, 'once per list, not per request');
});

// ── settings contract ────────────────────────────────────────────────────────

const VOCAB_KEYS = ['STT_VOCABULARY', 'STT_VOCABULARY_FILE'];

test('vocabulary keys: complete live catalog entries in the STT group, empty default', () => {
  for (const key of VOCAB_KEYS) {
    const e = catalogEntry('server', key);
    assert.ok(e, `${key} missing from configCatalog.js`);
    assert.equal(e.group, 'Server · STT');
    assert.equal(e.applyMode, 'live', 'read per STT request');
    assert.equal(e.type, 'string');
    assert.equal(e.def, '');
    assert.ok(e.label && e.desc.length > 80, `${key} label/desc`);
  }
});

test('vocabulary keys: documented in apps/server/.env.example, passed through compose, in deploy/.env.example', () => {
  const example = fs.readFileSync(path.join(serverDir, '.env.example'), 'utf8');
  const compose = fs.readFileSync(path.join(repoDir, 'deploy/docker-compose.yml'), 'utf8');
  const start = compose.indexOf('\n  server:');
  const serverEnv = compose.slice(start, compose.indexOf('\n    env_file:', start));
  const deployExample = fs.readFileSync(path.join(repoDir, 'deploy/.env.example'), 'utf8');
  for (const key of VOCAB_KEYS) {
    assert.match(example, new RegExp(`^#?\\s*${key}=`, 'm'), `${key} in apps/server/.env.example`);
    assert.match(serverEnv, new RegExp(`^\\s+${key}: \\$\\{${key}:-\\}\\r?$`, 'm'), `${key} in compose server env`);
    assert.match(deployExample, new RegExp(`^${key}=\\r?$`, 'm'), `${key} in deploy/.env.example`);
  }
});
