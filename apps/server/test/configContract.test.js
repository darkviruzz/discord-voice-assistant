// Generic settings-catalog contract across the whole code base (the per-area
// contracts — configRag/configStt/configTts/configLlm — go into more detail).
// Features merged in parallel each brought their own env keys; this catches
// the next one that reads a key the settings panel doesn't know, documents it
// with a different default, or falls back to another value in code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG, isSecretEntry } from '../src/configCatalog.js';
import { lastSessionContextEnabled, lastSessionContextMaxChars } from '../src/lastSession.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const repoDir = path.resolve(serverDir, '../..');

// Keys read in code that deliberately have no catalog entry (or none in the
// reading process's scope). Each needs a reason; anything else is a gap.
const ENV_ONLY = {
  server: {
    CONFIG_OVERRIDES_FILE: 'location of the override layer itself — cannot be set through it',
    DATA_DIR: 'server data root (index/overrides/speaker map); the catalog entry is the bot\'s DATA_DIR',
    GATE_MS: 'bot playout setting; the server only advertises it in serverParams',
    PLAYOUT_MAX_MS: 'bot playout setting (serverParams)',
    INTERRUPT_MIN_MS: 'bot playout setting (serverParams)',
    RESUME_GATE_MS: 'bot playout setting (serverParams)',
    REWIND_MS: 'bot playout setting (serverParams)',
    SESSION_IDLE_HOURS: 'server idle timer reads its own copy; the panel entry is the bot\'s',
  },
  bot: {
    SERVER_WATCHDOG_THRESHOLD_MS: 'env-only tuning, documented in apps/bot/.env.example',
    SERVER_WATCHDOG_COOLDOWN_MS: 'env-only tuning, documented in apps/bot/.env.example',
    WAKE_WORD: 'copied into the finalize manifest; the panel entry is the server\'s',
  },
};

// Code fallbacks that knowingly differ from the catalog default.
const KNOWN_DIVERGENT_FALLBACKS = {
  WHISPER_TEMPERATURE: 'code 0.2 predates the documented 0.1 (.env.example sets 0.1)',
  WHISPER_LANGUAGE: 'code auto-detects without a value; .env.example sets de',
  TTS_SPEED: 'empty catalog default = omit the field = speed 1',
  SERVER_START_TIMEOUT_MS: 'code 30000 for a local start; catalog/.env.example document 300000 for cloud starts',
  DATA_DIR: 'catalog entry is the bot\'s DATA_DIR (/opt/...); both processes fall back to ./data',
};

const READ_RE = /process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[\s*'([A-Z][A-Z0-9_]+)'\s*\]|\b(?:env|envStr|envPositiveInt|intEnv|numberEnv|envList|promptText)\(\s*'([A-Z][A-Z0-9_]+)'/g;
const FALLBACK_RES = [
  /process\.env\.([A-Z][A-Z0-9_]+)\s*(?:\?\?|\|\|)\s*(?:'([^']*)'|(-?[\d_.]+))/g,
  /Number\(process\.env\.([A-Z][A-Z0-9_]+)\)\s*\|\|\s*(-?[\d_.]+)()/g,
  /\b(?:env|intEnv|numberEnv|envPositiveInt)\(\s*'([A-Z][A-Z0-9_]+)'\s*,\s*(?:'([^']*)'|(-?[\d_.]+))/g,
];

function sourceFiles(scope) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) { if (name !== 'public') walk(p); continue; }
      if (p.endsWith('.js') && name !== 'configCatalog.js') out.push(p);
    }
  };
  walk(path.join(repoDir, 'apps', scope, 'src'));
  return out;
}

function keysRead(scope) {
  const keys = new Map();
  for (const f of sourceFiles(scope)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(READ_RE)) {
      const k = m[1] ?? m[2] ?? m[3];
      if (!keys.has(k)) keys.set(k, path.relative(repoDir, f));
    }
  }
  return keys;
}

const inCatalog = (scope, key) => CATALOG.some((e) => e.scope === scope && e.key === key);

for (const scope of ['server', 'bot']) {
  test(`every env key the ${scope} reads is in the settings catalog (or a documented env-only key)`, () => {
    const read = keysRead(scope);
    assert.ok(read.size > (scope === 'server' ? 80 : 20), `scan found only ${read.size} keys`);
    const missing = [...read].filter(([k]) => !inCatalog(scope, k) && !ENV_ONLY[scope][k])
      .map(([k, f]) => `${k} (${f})`);
    assert.deepEqual(missing, [], `add a catalog entry (scope ${scope}) or an ENV_ONLY reason`);
    for (const k of Object.keys(ENV_ONLY[scope])) assert.ok(read.has(k), `stale ENV_ONLY entry ${k}`);
  });
}

test('code fallbacks == catalog defaults (literal fallbacks in server and bot code)', () => {
  const norm = (v) => (/^-?[\d.]+$/.test(v) ? String(Number(v)) : v);
  const bad = [];
  for (const scope of ['server', 'bot']) {
    for (const f of sourceFiles(scope)) {
      const src = fs.readFileSync(f, 'utf8');
      for (const re of FALLBACK_RES) {
        for (const m of src.matchAll(re)) {
          const key = m[1];
          const val = (m[2] ?? m[3] ?? '').replace(/_/g, '');
          const defs = CATALOG.filter((e) => e.key === key).map((e) => e.def);
          if (!defs.length || KNOWN_DIVERGENT_FALLBACKS[key]) continue;
          if (!defs.some((d) => norm(d) === norm(val))) bad.push(`${key}: code ${JSON.stringify(val)} vs catalog ${JSON.stringify(defs)} (${path.relative(repoDir, f)})`);
        }
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('last-session context defaults == catalog (not a literal fallback the scan sees)', () => {
  const saved = { e: process.env.LAST_SESSION_CONTEXT_ENABLED, m: process.env.LAST_SESSION_CONTEXT_MAX_CHARS };
  delete process.env.LAST_SESSION_CONTEXT_ENABLED;
  delete process.env.LAST_SESSION_CONTEXT_MAX_CHARS;
  try {
    const def = (k) => CATALOG.find((e) => e.scope === 'server' && e.key === k).def;
    assert.equal(String(lastSessionContextEnabled()), def('LAST_SESSION_CONTEXT_ENABLED'));
    assert.equal(String(lastSessionContextMaxChars()), def('LAST_SESSION_CONTEXT_MAX_CHARS'));
  } finally {
    if (saved.e === undefined) delete process.env.LAST_SESSION_CONTEXT_ENABLED; else process.env.LAST_SESSION_CONTEXT_ENABLED = saved.e;
    if (saved.m === undefined) delete process.env.LAST_SESSION_CONTEXT_MAX_CHARS; else process.env.LAST_SESSION_CONTEXT_MAX_CHARS = saved.m;
  }
});

test('active lines in the .env.example files carry the catalog default', () => {
  const SAMPLE_VALUES = { bot: ['GUILD_IDS'] }; // placeholders the user must replace
  for (const [scope, file] of [['server', 'apps/server/.env.example'], ['bot', 'apps/bot/.env.example']]) {
    const txt = fs.readFileSync(path.join(repoDir, file), 'utf8');
    for (const [, key, value] of txt.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
      const e = CATALOG.find((x) => x.scope === scope && x.key === key);
      if (!e) { assert.ok(ENV_ONLY[scope][key], `${file}: ${key} is neither in the catalog nor ENV_ONLY`); continue; }
      if (isSecretEntry(e) || SAMPLE_VALUES[scope]?.includes(key)) continue;
      assert.equal(value.trim(), e.def, `${file}: ${key}`);
    }
  }
});
