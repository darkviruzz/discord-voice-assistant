// Settings-catalog contract for the STT provider variables: every key
// providers/stt.js reads is a catalog entry in the STT group, documented in
// apps/server/.env.example; the provider keys are passed through to the
// server container with the catalog default; the API key is a secret.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { catalogEntry, isSecretEntry } from '../src/configCatalog.js';
import { coerce } from '../src/configStore.js';
import { sttConfig, sttProvider } from '../src/providers/stt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const repoDir = path.resolve(serverDir, '../..');

function sttKeysUsed() {
  const src = fs.readFileSync(path.join(serverDir, 'src/providers/stt.js'), 'utf8');
  const keys = new Set();
  for (const m of src.matchAll(/\benv\('([A-Z0-9_]+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) keys.add(m[1]);
  return [...keys].sort();
}

// The provider-layer keys introduced with STT_PROVIDER (the WHISPER_* ones
// predate it and are wired in compose separately).
const PROVIDER_KEYS = () => sttKeysUsed().filter((k) => k.startsWith('STT_'));

test('every key providers/stt.js reads is a complete server catalog entry in the STT group', () => {
  const used = sttKeysUsed();
  for (const k of ['STT_PROVIDER', 'STT_BASE_URL', 'STT_MODEL', 'STT_API_KEY', 'STT_LANGUAGE', 'STT_TIMEOUT_MS', 'WHISPER_URL']) {
    assert.ok(used.includes(k), `${k} not read by providers/stt.js? found ${used.join(', ')}`);
  }
  for (const key of used) {
    const e = catalogEntry('server', key);
    assert.ok(e, `${key} missing from configCatalog.js`);
    assert.equal(e.group, 'Server · STT', `${key} group`);
    assert.ok(e.label && e.desc && e.type && e.applyMode, `${key} incomplete catalog entry`);
    assert.equal(e.applyMode, 'live', `${key} is read per request → live`);
  }
});

test('STT catalog defaults == code fallbacks', () => {
  const keys = sttKeysUsed();
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    const def = (k) => catalogEntry('server', k).def;
    assert.equal(sttProvider(), def('STT_PROVIDER'));
    const c = sttConfig();
    assert.equal(String(c.timeoutMs), def('STT_TIMEOUT_MS'));
    assert.equal(c.url, def('WHISPER_URL'));
    process.env.STT_PROVIDER = 'openai';
    const o = sttConfig();
    assert.equal(o.url, def('STT_BASE_URL') || null);
    assert.equal(o.model, def('STT_MODEL') || null);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('STT_PROVIDER / STT_LANGUAGE enums: panel accepts the documented values and "" = fallback', () => {
  assert.equal(coerce('server', 'STT_PROVIDER', 'openai'), 'openai');
  assert.equal(coerce('server', 'STT_PROVIDER', 'whispercpp'), 'whispercpp');
  assert.throws(() => coerce('server', 'STT_PROVIDER', 'vllm'), /erwartet einen von/);
  assert.equal(coerce('server', 'STT_LANGUAGE', ''), '');
  assert.equal(coerce('server', 'STT_LANGUAGE', 'de'), 'de');
  assert.equal(coerce('server', 'STT_TIMEOUT_MS', '30000'), '30000');
  assert.throws(() => coerce('server', 'STT_TIMEOUT_MS', ''), /Zahl/);
});

test('STT_API_KEY is a read-only secret (flag and name blacklist)', () => {
  const e = catalogEntry('server', 'STT_API_KEY');
  assert.equal(e.secret, true);
  assert.equal(e.editable, false);
  assert.equal(isSecretEntry({ key: 'STT_API_KEY' }), true, 'blacklist alone must catch it too');
  assert.throws(() => coerce('server', 'STT_API_KEY', 'sk-x'), /Secret/);
});

test('STT vars are documented in apps/server/.env.example with the catalog default', () => {
  const example = fs.readFileSync(path.join(serverDir, '.env.example'), 'utf8');
  for (const key of sttKeysUsed()) {
    const m = example.match(new RegExp(`^(#\\s*)?${key}=(.*)$`, 'm'));
    assert.ok(m, `${key} missing from apps/server/.env.example`);
    // Commented-out examples show a sample value; active lines = catalog default.
    if (!m[1]) assert.equal(m[2].trim(), catalogEntry('server', key).def, `${key} default in .env.example`);
  }
});

test('STT provider vars are passed through to the server container and documented in deploy/.env.example', () => {
  const compose = fs.readFileSync(path.join(repoDir, 'deploy/docker-compose.yml'), 'utf8');
  const start = compose.indexOf('\n  server:');
  const end = compose.indexOf('\n    env_file:', start);
  const serverEnv = compose.slice(start, end);
  const deployExample = fs.readFileSync(path.join(repoDir, 'deploy/.env.example'), 'utf8');
  for (const key of PROVIDER_KEYS()) {
    const m = serverEnv.match(new RegExp(`^\\s+${key}: \\$\\{${key}:-([^}]*)\\}`, 'm'));
    assert.ok(m, `${key} missing from the server service environment in deploy/docker-compose.yml`);
    assert.equal(m[1], catalogEntry('server', key).def, `${key} compose default`);
    const d = deployExample.match(new RegExp(`^${key}=(.*)$`, 'm'));
    assert.ok(d, `${key} missing from deploy/.env.example`);
    assert.equal(d[1].trim(), catalogEntry('server', key).def, `${key} default in deploy/.env.example`);
  }
});
