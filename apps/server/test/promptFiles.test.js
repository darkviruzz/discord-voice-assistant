// Prompt files: note markup stripped, path rules (absolute / ./ / vault),
// per-call reading with the mtime cache, the warn-once fallback, the persona
// prompt in llm.js, the starter files in docs/prompts/ (== the built-in texts)
// and the settings contract for the new keys. No LLM — the summary paths are
// covered with fakes in sessionSummary/rollingSummary tests.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripNoteMarkup, promptFilePath, promptText, _resetPromptCache } from '../src/promptFiles.js';
import { DEFAULT_SYSTEM, systemPrompt } from '../src/llm.js';
import { PART_SYSTEM, FINAL_SYSTEM } from '../src/finalize/summary.js';
import { SUMMARY_SYSTEM } from '../src/rollingSummary.js';
import { catalogEntry } from '../src/configCatalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const repoDir = path.resolve(serverDir, '../..');

const KEYS = ['OBSIDIAN_VAULT_PATH', 'SYSTEM_PROMPT_FILE', 'SYSTEM_PROMPT', 'SESSION_SUMMARY_PART_PROMPT_FILE',
  'SESSION_SUMMARY_FINAL_PROMPT_FILE', 'LIVE_SUMMARY_PROMPT_FILE'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } _resetPromptCache(); });
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  _resetPromptCache();
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-files-'));

// console.warn / console.log (the logger) captured for one call.
function capture(fn) {
  const orig = { warn: console.warn, log: console.log };
  const warns = [];
  const logs = [];
  console.warn = (...a) => warns.push(a.join(' '));
  console.log = (...a) => logs.push(a.join(' '));
  try { return { value: fn(), warns, logs }; } finally { Object.assign(console, orig); }
}

// Rewrite a file so the cache sees a change even within one mtime tick.
function rewrite(fp, text, bumpS = 2) {
  fs.writeFileSync(fp, text);
  const t = new Date(Date.now() + bumpS * 1000);
  fs.utimesSync(fp, t, t);
}

// ── note markup ──────────────────────────────────────────────────────────────

test('stripNoteMarkup: frontmatter, %% comments %%, BOM and CRLF go; the text stays as written', () => {
  const note = [
    '﻿---',
    'tags: [rabenauge/prompt]',
    'rabenauge-setting: SESSION_SUMMARY_PART_PROMPT_FILE',
    '---',
    '%%',
    'Kommentar über mehrere Zeilen',
    '%%',
    'Du protokollierst eine Runde. %%inline%%',
    '',
    '',
    '',
    '- Regel eins',
    '  eingerückt bleibt eingerückt',
    '---',
    'Nach einem Trenner.   ',
  ].join('\r\n');
  assert.equal(stripNoteMarkup(note), [
    'Du protokollierst eine Runde.',
    '',
    '- Regel eins',
    '  eingerückt bleibt eingerückt',
    '---',
    'Nach einem Trenner.',
  ].join('\n'));
  assert.equal(stripNoteMarkup('---\ntags: x\n---\n%% nur Kommentar %%\n'), '', 'frontmatter + comment only = empty');
  assert.equal(stripNoteMarkup('Text\n---\nkein: frontmatter\n---\n'), 'Text\n---\nkein: frontmatter\n---', 'only a leading block is frontmatter');
  assert.equal(stripNoteMarkup(undefined), '');
});

// ── paths ────────────────────────────────────────────────────────────────────

test('promptFilePath: absolute as is, ./… = working directory, otherwise relative to the vault', () => {
  const vault = tmp();
  assert.equal(promptFilePath('SYSTEM_PROMPT_FILE'), null, 'unset');
  process.env.SYSTEM_PROMPT_FILE = '   ';
  assert.equal(promptFilePath('SYSTEM_PROMPT_FILE'), null, 'blank');

  process.env.OBSIDIAN_VAULT_PATH = vault;
  process.env.SYSTEM_PROMPT_FILE = './prompt.txt';
  assert.equal(promptFilePath('SYSTEM_PROMPT_FILE'), path.resolve('prompt.txt'), 'the old meaning stays');
  process.env.SYSTEM_PROMPT_FILE = '..\\prompts\\p.md';
  assert.equal(promptFilePath('SYSTEM_PROMPT_FILE'), path.resolve('..', 'prompts', 'p.md'));
  process.env.SYSTEM_PROMPT_FILE = 'Rabenauge/Konfiguration/Prompt Persona.md';
  assert.equal(promptFilePath('SYSTEM_PROMPT_FILE'), path.join(vault, 'Rabenauge', 'Konfiguration', 'Prompt Persona.md'));
  const abs = path.join(tmp(), 'p.md');
  process.env.SYSTEM_PROMPT_FILE = abs;
  assert.equal(promptFilePath('SYSTEM_PROMPT_FILE'), abs);

  delete process.env.OBSIDIAN_VAULT_PATH;
  process.env.SYSTEM_PROMPT_FILE = 'prompt.txt';
  assert.equal(promptFilePath('SYSTEM_PROMPT_FILE'), path.resolve('prompt.txt'), 'no vault → working directory');
});

// ── loading ──────────────────────────────────────────────────────────────────

test('promptText: no setting → built-in, silently', () => {
  const { value, warns } = capture(() => promptText('LIVE_SUMMARY_PROMPT_FILE', 'EINGEBAUT'));
  assert.equal(value, 'EINGEBAUT');
  assert.deepEqual(warns, []);
});

test('promptText: a vault note is read per call — an edit applies to the next call', () => {
  const vault = tmp();
  fs.mkdirSync(path.join(vault, 'Rabenauge'));
  const fp = path.join(vault, 'Rabenauge', 'Prompt Live.md');
  fs.writeFileSync(fp, '---\ntags: [x]\n---\n%% Hinweis %%\nVersion eins.\n');
  process.env.OBSIDIAN_VAULT_PATH = vault;
  process.env.LIVE_SUMMARY_PROMPT_FILE = 'Rabenauge/Prompt Live.md';

  const first = capture(() => promptText('LIVE_SUMMARY_PROMPT_FILE', 'EINGEBAUT'));
  assert.equal(first.value, 'Version eins.');
  assert.ok(first.logs.some((l) => /prompt: LIVE_SUMMARY_PROMPT_FILE loaded from .*Prompt Live\.md \(13 chars\)/.test(l)), first.logs.join('\n'));
  const again = capture(() => promptText('LIVE_SUMMARY_PROMPT_FILE', 'EINGEBAUT'));
  assert.equal(again.value, 'Version eins.');
  assert.deepEqual(again.logs, [], 'unchanged file: cached, not logged again');

  rewrite(fp, 'Version zwei, länger.\n');
  assert.equal(capture(() => promptText('LIVE_SUMMARY_PROMPT_FILE', 'EINGEBAUT')).value, 'Version zwei, länger.');
});

test('promptText: missing or empty file → built-in with ONE warning; readable in between → warned again', () => {
  const vault = tmp();
  process.env.OBSIDIAN_VAULT_PATH = vault;
  process.env.SESSION_SUMMARY_FINAL_PROMPT_FILE = 'Prompt Final.md';
  const fp = path.join(vault, 'Prompt Final.md');
  const call = () => promptText('SESSION_SUMMARY_FINAL_PROMPT_FILE', 'EINGEBAUT');

  const missing = capture(() => [call(), call(), call()]);
  assert.deepEqual(missing.value, ['EINGEBAUT', 'EINGEBAUT', 'EINGEBAUT']);
  assert.equal(missing.warns.length, 1, missing.warns.join('\n'));
  assert.match(missing.warns[0], /prompt: SESSION_SUMMARY_FINAL_PROMPT_FILE .*Prompt Final\.md not readable \(ENOENT\) — using the built-in prompt/);

  fs.writeFileSync(fp, '---\ntags: [x]\n---\n%% noch leer %%\n');
  const empty = capture(() => [call(), call()]);
  assert.deepEqual(empty.value, ['EINGEBAUT', 'EINGEBAUT']);
  assert.equal(empty.warns.length, 1);
  assert.match(empty.warns[0], /is empty/);

  rewrite(fp, 'Eigener Prompt.');
  assert.equal(capture(call).value, 'Eigener Prompt.');
  fs.rmSync(fp);
  const gone = capture(() => [call(), call()]);
  assert.deepEqual(gone.value, ['EINGEBAUT', 'EINGEBAUT']);
  assert.equal(gone.warns.length, 1, 'a file that worked and broke again is worth a new warning');
});

test('persona: SYSTEM_PROMPT_FILE (vault note or ./ file) > SYSTEM_PROMPT > built-in, read per call', () => {
  const vault = tmp();
  process.env.OBSIDIAN_VAULT_PATH = vault;
  assert.equal(systemPrompt(), DEFAULT_SYSTEM, 'nothing set');
  process.env.SYSTEM_PROMPT = '   ';
  assert.equal(systemPrompt(), DEFAULT_SYSTEM, 'a cleared inline prompt is no prompt');
  process.env.SYSTEM_PROMPT = 'Inline-Persona.';
  assert.equal(systemPrompt(), 'Inline-Persona.');

  process.env.SYSTEM_PROMPT_FILE = 'Rabenauge/Konfiguration/Prompt Persona.md';
  const { value, warns } = capture(systemPrompt);
  assert.equal(value, 'Inline-Persona.', 'missing file → SYSTEM_PROMPT');
  assert.match(warns[0], /using the SYSTEM_PROMPT prompt/);

  const dir = path.join(vault, 'Rabenauge', 'Konfiguration');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Prompt Persona.md'), '---\ntags: [rabenauge/prompt]\n---\nDu bist Rabenauge aus dem Vault.\n');
  assert.equal(capture(systemPrompt).value, 'Du bist Rabenauge aus dem Vault.');

  // ./ keeps its old meaning: relative to the server's working directory.
  const cwd = process.cwd();
  const work = tmp();
  fs.writeFileSync(path.join(work, 'prompt.txt'), 'Du bist Rabenauge aus prompt.txt.\n');
  process.chdir(work);
  try {
    process.env.SYSTEM_PROMPT_FILE = './prompt.txt';
    assert.equal(capture(systemPrompt).value, 'Du bist Rabenauge aus prompt.txt.');
  } finally { process.chdir(cwd); }
});

test('the built-in persona describes the context blocks pipeline.js sends', () => {
  const src = fs.readFileSync(path.join(serverDir, 'src/pipeline.js'), 'utf8')
    + fs.readFileSync(path.join(serverDir, 'src/lastSession.js'), 'utf8');
  for (const heading of ['Kampagnen-Kontext', 'Zusammenfassung der letzten abgeschlossenen Sitzung',
    'Bisheriger Gesprächsverlauf (Zusammenfassung)', 'Aktuelles Live-Transkript der Runde',
    'Neueste Beiträge im Live-Transkript (Fortsetzung)']) {
    assert.ok(src.includes(heading), `block "${heading}" no longer sent — update DEFAULT_SYSTEM`);
    assert.ok(DEFAULT_SYSTEM.includes(`"${heading}"`), `DEFAULT_SYSTEM does not name "${heading}"`);
  }
  // The question tail (llm.js chat: context blocks, then "Frage: …").
  assert.match(DEFAULT_SYSTEM, /direkt vor der Frage/);
  assert.match(DEFAULT_SYSTEM, /"Frage:"/);
});

// ── built-in summary prompts ─────────────────────────────────────────────────

// Round 3 (2026-10-12): scheduling talk and character building became "open
// questions", an allied NPC became "von Gaglath besiegt".
test('built-in summary prompts: in-game only, NPC roles kept, in-game date and place', () => {
  for (const [name, p] of Object.entries({ PART_SYSTEM, FINAL_SYSTEM, SUMMARY_SYSTEM })) {
    assert.match(p, /Terminplanung/, `${name}: scheduling is off-game`);
    assert.match(p, /Technikprobleme/, `${name}: tech trouble is off-game`);
    assert.match(p, /Verbündete[^.]*nicht zu Gegnern/, `${name}: allies stay allies`);
    assert.match(p, /Personen nicht zu Gegenständen/, `${name}: NPCs are no items`);
    assert.match(p, /besiegt[^.]*eindeutig/, `${name}: who defeated whom only when said`);
  }
  for (const p of [PART_SYSTEM, FINAL_SYSTEM]) {
    assert.match(p, /Schichtdienste/);
    assert.match(p, /Erstellen, Benennen oder Verwalten von Spielfiguren/);
  }
  assert.match(PART_SYSTEM, /Datum oder eine Tageszeit der Spielwelt/);
  assert.match(PART_SYSTEM, /"X ist dran" heißt nur, dass X an der Reihe ist/);
  assert.match(FINAL_SYSTEM, /Letzte Zeile[^\n]*"Ort: <Ort> · Ingame-Datum: <Datum>", ohne genanntes Datum nur "Ort: <Ort>"/);
  assert.match(FINAL_SYSTEM, /reale Datum der Sitzung ist kein Ingame-Datum/);
  assert.match(FINAL_SYSTEM, /bei kurzen Sitzungen direkt das Transkript/, 'the single-chunk path sends the transcript');
});

// ── starter files ────────────────────────────────────────────────────────────

const STARTERS = {
  'Prompt Persona.md': ['SYSTEM_PROMPT_FILE', DEFAULT_SYSTEM],
  'Prompt Sitzung Abschnitt.md': ['SESSION_SUMMARY_PART_PROMPT_FILE', PART_SYSTEM],
  'Prompt Sitzung Zusammenfassung.md': ['SESSION_SUMMARY_FINAL_PROMPT_FILE', FINAL_SYSTEM],
  'Prompt Live-Zusammenfassung.md': ['LIVE_SUMMARY_PROMPT_FILE', SUMMARY_SYSTEM],
};

test('docs/prompts/ starters are the built-in texts (change one, change the other)', () => {
  const dir = path.join(repoDir, 'docs', 'prompts');
  const notes = fs.readdirSync(dir).filter((f) => f.startsWith('Prompt ') && f.endsWith('.md')).sort();
  assert.deepEqual(notes, Object.keys(STARTERS).sort());
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  for (const [file, [key, builtin]] of Object.entries(STARTERS)) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.equal(stripNoteMarkup(raw), builtin, `${file} differs from the built-in prompt`);
    assert.match(raw, new RegExp(`^---\\r?\\n[\\s\\S]*rabenauge-setting: ${key}\\r?\\n[\\s\\S]*?---`), `${file}: frontmatter names ${key}`);
    assert.ok(raw.includes(`${key}=Rabenauge/Konfiguration/${file}`), `${file}: comment shows the setting`);
    assert.ok(readme.includes(`${key}=Rabenauge/Konfiguration/${file}`), `README: ${key} line`);
  }
});

// ── settings contract ────────────────────────────────────────────────────────

test('prompt-file settings: complete catalog entries, live per call, documented in .env.example', () => {
  const example = fs.readFileSync(path.join(serverDir, '.env.example'), 'utf8');
  const expect = {
    SYSTEM_PROMPT_FILE: ['./prompt.txt', 'live'],
    SYSTEM_PROMPT: ['', 'live'],
    SESSION_SUMMARY_PART_PROMPT_FILE: ['', 'next-finalize'],
    SESSION_SUMMARY_FINAL_PROMPT_FILE: ['', 'next-finalize'],
    LIVE_SUMMARY_PROMPT_FILE: ['', 'live'],
  };
  for (const [key, [def, applyMode]] of Object.entries(expect)) {
    const e = catalogEntry('server', key);
    assert.ok(e && e.label && e.desc && e.type === 'string', `${key} catalog entry`);
    assert.equal(e.def, def, `${key} default`);
    assert.equal(e.applyMode, applyMode, `${key} applyMode`);
    assert.match(example, new RegExp(`^(#\\s*)?${key}=`, 'm'), `${key} missing from apps/server/.env.example`);
    if (key.endsWith('_FILE')) assert.match(e.desc, /OBSIDIAN_VAULT_PATH/, `${key}: desc explains the path rule`);
  }
});
