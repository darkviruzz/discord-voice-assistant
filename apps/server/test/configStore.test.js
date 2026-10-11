import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyServerOverrides, setServerValue, setBotValue, resetValue, statusOf, displayValue,
  getOverrides, coerce,
} from '../src/configStore.js';

// Override layer: .env (baseline) → overrides file → temporary (in-memory).
// The baseline is captured once, on the first apply — so the "from .env"
// values are set up before that first call.
let dir;
let file;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-store-'));
  file = path.join(dir, 'nested', 'config.overrides.json');
  process.env.CONFIG_OVERRIDES_FILE = file;
  process.env.WAKE_WORD = 'Rabenauge';      // from .env
  process.env.PAUSE_THRESHOLD_S = '30';     // from .env
  delete process.env.HISTORY_TURNS;         // not in .env
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    server: { WAKE_WORD: 'Krähenauge' },
    bot: { GATE_MS: '95' },
  }));
  assert.equal(applyServerOverrides(), 1, 'boot: one persisted server override applied');
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of ['CONFIG_OVERRIDES_FILE', 'WAKE_WORD', 'PAUSE_THRESHOLD_S', 'HISTORY_TURNS', 'GATE_MS']) delete process.env[k];
});

const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'));

test('boot layers the persisted server section over .env and never applies the bot section locally', () => {
  assert.equal(process.env.WAKE_WORD, 'Krähenauge');
  assert.equal(statusOf('server', 'WAKE_WORD'), 'persisted');
  assert.equal(process.env.GATE_MS, undefined, 'bot desired state is pushed to the bot, not set on the server');
  assert.equal(statusOf('server', 'PAUSE_THRESHOLD_S'), 'default');
});

test('setServerValue(persist) writes env + file; temporary changes env only and is flagged temporary', () => {
  setServerValue('PAUSE_THRESHOLD_S', '45', true);
  assert.equal(process.env.PAUSE_THRESHOLD_S, '45');
  assert.equal(onDisk().server.PAUSE_THRESHOLD_S, '45');
  assert.equal(statusOf('server', 'PAUSE_THRESHOLD_S'), 'persisted');

  setServerValue('PAUSE_THRESHOLD_S', '60', false);
  assert.equal(process.env.PAUSE_THRESHOLD_S, '60');
  assert.equal(onDisk().server.PAUSE_THRESHOLD_S, '45', 'file keeps the persisted value (comes back after restart)');
  assert.equal(statusOf('server', 'PAUSE_THRESHOLD_S'), 'temporary');

  setServerValue('PAUSE_THRESHOLD_S', '50', true);
  assert.equal(statusOf('server', 'PAUSE_THRESHOLD_S'), 'persisted', 'persisting clears the temporary flag');
});

test('resetValue restores the .env value captured before any override, or unsets a key .env never had', () => {
  resetValue('server', 'WAKE_WORD');
  assert.equal(process.env.WAKE_WORD, 'Rabenauge', 'baseline from before the boot override');
  assert.equal(statusOf('server', 'WAKE_WORD'), 'default');
  assert.equal('WAKE_WORD' in onDisk().server, false);

  setServerValue('HISTORY_TURNS', '9', false);
  resetValue('server', 'HISTORY_TURNS');
  assert.equal('HISTORY_TURNS' in process.env, false);
  assert.equal(statusOf('server', 'HISTORY_TURNS'), 'default', 'temporary flag cleared too');
});

test('bot desired state: persisted vs temporary values, display and reset — process.env untouched', () => {
  assert.equal(displayValue('bot', 'GATE_MS'), '95');
  assert.equal(statusOf('bot', 'GATE_MS'), 'persisted');

  setBotValue('GATE_MS', '70', false);
  assert.equal(displayValue('bot', 'GATE_MS'), '70', 'temporary shadows the persisted value');
  assert.equal(statusOf('bot', 'GATE_MS'), 'temporary');
  assert.equal(getOverrides().bot.GATE_MS, '95');

  setBotValue('REWIND_MS', '400', true);
  assert.equal(onDisk().bot.REWIND_MS, '400');

  resetValue('bot', 'GATE_MS');
  assert.equal(displayValue('bot', 'GATE_MS'), undefined);
  assert.equal(statusOf('bot', 'GATE_MS'), 'default');
  assert.equal(process.env.GATE_MS, undefined);
  assert.equal(process.env.REWIND_MS, undefined);
});

test('a corrupt overrides file reads as empty instead of crashing the panel', () => {
  const saved = fs.readFileSync(file);
  try {
    fs.writeFileSync(file, '{"server": [1,');
    assert.deepEqual(getOverrides(), { version: 1, server: {}, bot: {} });
    assert.equal(statusOf('server', 'WAKE_WORD'), 'default');
  } finally {
    fs.writeFileSync(file, saved);
  }
});

// ── coerce (validation against the catalog) ──────────────────────────────────

test('coerce: booleans map to the entry\'s own on/off values', () => {
  assert.equal(coerce('server', 'DEBUG', true), '1');
  assert.equal(coerce('server', 'DEBUG', 'false'), '0');
  assert.equal(coerce('server', 'STT_STREAMING', '1'), 'true');
  assert.equal(coerce('server', 'STT_STREAMING', false), 'false');
  assert.throws(() => coerce('server', 'STT_STREAMING', 'ja'), /Boolean/);
});

test('coerce: numbers are canonicalised, garbage is refused', () => {
  assert.equal(coerce('server', 'PAUSE_THRESHOLD_S', ' 42 '), '42');
  assert.equal(coerce('server', 'WHISPER_TEMPERATURE', '0.10'), '0.1');
  assert.equal(coerce('bot', 'SERVER_STOP_DELAY_MS', 9e5), '900000');
  for (const bad of ['abc', '12px', 'NaN', 'Infinity']) {
    assert.throws(() => coerce('server', 'PAUSE_THRESHOLD_S', bad), /Zahl/, bad);
  }
});

test('coerce: a cleared number field is refused instead of silently becoming 0', () => {
  // The settings UI sends '' for an emptied <input type=number>; Number('') is 0.
  for (const blank of ['', '   ', null, undefined]) {
    assert.throws(() => coerce('server', 'LIVE_RAW_WINDOW_CHARS', blank), /Zahl/, JSON.stringify(blank));
    assert.throws(() => coerce('bot', 'SESSION_IDLE_HOURS', blank), /Zahl/, JSON.stringify(blank));
  }
});

test('coerce: optional numbers (catalog default "") accept blank as "unset", not 0', () => {
  // RAG_SCORE_THRESHOLD: "Leer = kein Filter" — 0 would discard every RAG hit.
  assert.equal(coerce('server', 'RAG_SCORE_THRESHOLD', ''), '');
  assert.equal(coerce('server', 'RAG_SCORE_THRESHOLD', '  '), '');
  assert.equal(coerce('server', 'RAG_SCORE_THRESHOLD', '0.75'), '0.75');
});

test('coerce: enums and lists', () => {
  assert.equal(coerce('bot', 'ARCHIVE_RETENTION', 'delete'), 'delete');
  assert.throws(() => coerce('bot', 'ARCHIVE_RETENTION', 'keep'), /move, delete/);
  assert.equal(coerce('server', 'STOP_PHRASES', ' stop , ,hör auf,  halt '), 'stop,hör auf,halt');
  assert.equal(coerce('bot', 'GUILD_IDS', ''), '');
});

test('coerce: unknown keys, wrong scope, secrets and read-only keys are refused', () => {
  assert.throws(() => coerce('server', 'NODE_OPTIONS', '--inspect'), /unbekannte Variable/);
  assert.throws(() => coerce('server', 'GATE_MS', '80'), /unbekannte Variable server:GATE_MS/, 'bot key in server scope');
  assert.throws(() => coerce('bot', 'DISCORD_TOKEN', 'x'), /Secret/);
  assert.throws(() => coerce('server', 'CONTROL_BEARER', 'x'), /Secret/);
});
