// An address the server sends a secret to is env-only, like the secret itself.
// Otherwise whoever may use the settings panel could point e.g. LLM_BASE_URL
// at their own host and collect LLM_API_KEY from the next request. Same rule
// as the bot's SERVER_BASE_URL / CONTROL_WS_URL (← CONTROL_BEARER).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG, catalogEntry, isSecretEntry, isEnvOnlyEntry } from '../src/configCatalog.js';
import { applyServerOverrides, coerce } from '../src/configStore.js';
import { registerConfigRoutes } from '../src/configApi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '../src');

// Secret → every address it is sent to (providers/*.js). A new provider key
// fails the tests below until it is listed here with its destination.
const DESTINATIONS = {
  server: {
    STT_API_KEY: ['STT_BASE_URL'],
    LLM_API_KEY: ['LLM_BASE_URL'],
    SUMMARY_API_KEY: ['SUMMARY_BASE_URL', 'LLM_BASE_URL'],
    EMBED_API_KEY: ['EMBED_BASE_URL'],
    TTS_API_KEY: ['TTS_BASE_URL'],
    ELEVENLABS_API_KEY: ['ELEVENLABS_BASE_URL'],
  },
  bot: {
    CONTROL_BEARER: ['SERVER_BASE_URL', 'CONTROL_WS_URL'],
  },
};
const SERVER_URLS = [...new Set(Object.values(DESTINATIONS.server).flat())];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-envonly-'));
const file = path.join(dir, 'config.overrides.json');
const ENV = ['CONFIG_OVERRIDES_FILE', 'WAKE_WORD', ...SERVER_URLS, 'STT_API_KEY'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('every API key in the catalog is mapped to the address(es) it is sent to', () => {
  const keys = CATALOG.filter((e) => e.scope === 'server' && /API_?KEY/i.test(e.key)).map((e) => e.key).sort();
  assert.deepEqual(keys, Object.keys(DESTINATIONS.server).sort());
  for (const k of keys) assert.equal(isSecretEntry(catalogEntry('server', k)), true, k);
});

test('every API key the server code reads is mapped', () => {
  const read = new Set();
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) { if (name !== 'public') walk(p); continue; }
      if (!p.endsWith('.js') || name === 'configCatalog.js') continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const m of src.matchAll(/(?:env\(\s*'|process\.env\.)([A-Z0-9_]*API_?KEY)\b/g)) read.add(m[1]);
    }
  };
  walk(srcDir);
  assert.ok(read.size >= 5, `scan found only ${[...read].join(', ')}`);
  for (const k of read) assert.ok(DESTINATIONS.server[k], `${k} is read in apps/server/src but has no destination in DESTINATIONS`);
});

test('every destination is env-only, says why, and coerce() refuses it', () => {
  for (const [scope, map] of Object.entries(DESTINATIONS)) {
    for (const [secret, urls] of Object.entries(map)) {
      for (const url of urls) {
        const e = catalogEntry(scope, url);
        assert.ok(e, `${scope}:${url} missing from the catalog`);
        assert.equal(e.editable, false, `${scope}:${url} must be editable: false (receives ${secret})`);
        assert.equal(isEnvOnlyEntry(e), true);
        if (scope === 'server') {
          assert.match(e.note ?? '', /Nur per \.env/, `${url}: note`);
          assert.throws(() => coerce('server', url, 'http://evil.example/v1'), /nicht editierbar/, url);
        }
      }
    }
  }
  // Keyless addresses stay editable in the panel.
  for (const url of ['OLLAMA_URL', 'WHISPER_URL', 'TTS_URL']) assert.equal(isEnvOnlyEntry(catalogEntry('server', url)), false, url);
});

// Runs before the panel tests: the boot apply captures the .env baseline.
test('boot: a persisted override of an env-only key is ignored (and warned about), others apply', () => {
  process.env.CONFIG_OVERRIDES_FILE = file;
  process.env.LLM_BASE_URL = 'http://vllm.local:8000/v1'; // from .env
  delete process.env.WAKE_WORD;
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    server: { WAKE_WORD: 'Krähenauge', LLM_BASE_URL: 'http://evil.example/v1', TTS_BASE_URL: 'http://evil.example/v1', STT_API_KEY: 'sk-planted' },
  }));
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  let n;
  try { n = applyServerOverrides(); } finally { console.warn = orig; }
  assert.equal(n, 1);
  assert.equal(process.env.WAKE_WORD, 'Krähenauge');
  assert.equal(process.env.LLM_BASE_URL, 'http://vllm.local:8000/v1', '.env value kept');
  assert.equal(process.env.TTS_BASE_URL, saved.TTS_BASE_URL);
  assert.equal(process.env.STT_API_KEY, saved.STT_API_KEY);
  assert.equal(warns.length, 3, warns.join(' | '));
  for (const k of ['LLM_BASE_URL', 'TTS_BASE_URL', 'STT_API_KEY']) assert.ok(warns.some((w) => w.includes(k)), k);
});

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  registerConfigRoutes(app);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/transcript/config`;
});
after(() => server?.close());

const put = async (body) => {
  const res = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8')).server;

test('panel API: PUT on each key-receiving URL is refused, persistent and temporary', async () => {
  for (const key of SERVER_URLS) {
    const before = process.env[key];
    const diskBefore = onDisk()[key];
    for (const persist of [true, false]) {
      const r = await put({ persist, updates: [{ scope: 'server', key, value: 'http://evil.example/v1' }] });
      assert.equal(r.status, 400, `${key} persist=${persist}`);
      assert.equal(r.body.ok, false);
      assert.deepEqual(r.body.applied, []);
      assert.match(r.body.errors.join(' '), new RegExp(`${key} ist nicht editierbar`));
    }
    assert.equal(process.env[key], before, `${key}: process.env unchanged`);
    assert.equal(onDisk()[key], diskBefore, `${key}: overrides file unchanged`);
  }
});

test('panel API: GET shows them read-only with the reason', async () => {
  const data = await (await fetch(base)).json();
  const items = data.groups.flatMap((g) => g.items).filter((i) => i.scope === 'server');
  for (const key of SERVER_URLS) {
    const it = items.find((i) => i.key === key);
    assert.equal(it.editable, false, key);
    assert.equal(it.secret, false, `${key}: the address itself is shown`);
    assert.match(it.note, /_API_KEY an diese Adresse/, key);
  }
});

test('panel API: reset removes a stale persisted entry of such a URL', async () => {
  assert.ok('LLM_BASE_URL' in onDisk());
  const r = await put({ resets: [{ scope: 'server', key: 'LLM_BASE_URL' }] });
  assert.equal(r.body.ok, true);
  assert.equal('LLM_BASE_URL' in onDisk(), false);
  assert.equal(process.env.LLM_BASE_URL, 'http://vllm.local:8000/v1', 'back to the .env value');
});
