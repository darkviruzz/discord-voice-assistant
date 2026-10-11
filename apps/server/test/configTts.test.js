// Settings-catalog contract for the TTS provider variables: every key
// providers/tts.js reads is a catalog entry in the TTS group, with the same
// default the code falls back to, documented in both .env.example files and
// passed through to the server container — so the settings panel, the docs
// and the running code cannot drift apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG, catalogEntry, isSecretEntry } from '../src/configCatalog.js';
import { coerce } from '../src/configStore.js';
import { ttsConfig, ttsProvider } from '../src/providers/tts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const repoDir = path.resolve(serverDir, '../..');
const GROUP = 'Server · TTS';

function keysReadByProvider() {
  const src = fs.readFileSync(path.join(serverDir, 'src/providers/tts.js'), 'utf8');
  const keys = new Set();
  for (const m of src.matchAll(/\benv\('([A-Z0-9_]+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) keys.add(m[1]);
  return [...keys].sort();
}

function withCleanEnv(fn) {
  const keys = CATALOG.filter((e) => e.group === GROUP).map((e) => e.key);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try { return fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

const def = (k) => catalogEntry('server', k).def;

test('every key providers/tts.js reads is a complete server catalog entry in the TTS group', () => {
  const used = keysReadByProvider();
  assert.ok(used.length >= 13, `found ${used.join(', ')}`);
  for (const key of used) {
    const e = catalogEntry('server', key);
    assert.ok(e, `${key} missing from configCatalog.js`);
    assert.equal(e.group, GROUP, `${key} group`);
    assert.ok(e.label && e.desc && e.type && e.applyMode, `${key} incomplete catalog entry`);
    assert.equal(e.applyMode, 'live', `${key} is read per TTS request`);
  }
});

test('TTS_PROVIDER enum == the providers the code dispatches on', () => {
  const e = catalogEntry('server', 'TTS_PROVIDER');
  assert.equal(e.type, 'enum');
  assert.deepEqual([...e.enumValues].sort(), ['elevenlabs', 'openai', 'piper']);
  withCleanEnv(() => {
    for (const v of e.enumValues) { process.env.TTS_PROVIDER = v; assert.equal(ttsProvider(), v); }
  });
  assert.deepEqual(catalogEntry('server', 'TTS_RESPONSE_FORMAT').enumValues, ['pcm', 'wav']);
});

test('TTS catalog defaults == code fallbacks', () => withCleanEnv(() => {
  const piper = ttsConfig();
  assert.equal(piper.provider, def('TTS_PROVIDER'));
  assert.equal(piper.url, def('TTS_URL'));
  assert.equal(String(piper.timeoutMs), def('TTS_TIMEOUT_MS'));

  process.env.TTS_PROVIDER = 'openai';
  const oa = ttsConfig();
  assert.equal(oa.url, def('TTS_BASE_URL'));
  assert.equal(oa.model, def('TTS_MODEL') || null);
  assert.equal(oa.voice, def('TTS_VOICE') || null);
  assert.equal(oa.responseFormat, def('TTS_RESPONSE_FORMAT'));
  assert.equal(String(oa.sampleRate), def('TTS_SAMPLE_RATE'));
  assert.equal(def('TTS_SPEED'), '', 'empty = speed field omitted');
  assert.equal(oa.speed, 1);

  process.env.TTS_PROVIDER = 'elevenlabs';
  const el = ttsConfig();
  assert.equal(el.url, def('ELEVENLABS_BASE_URL'));
  assert.equal(el.voiceId, def('ELEVENLABS_VOICE_ID'));
}));

test('TTS API keys are secrets: read-only in the panel, never writable', () => {
  for (const key of ['TTS_API_KEY', 'ELEVENLABS_API_KEY']) {
    const e = catalogEntry('server', key);
    assert.equal(e.secret, true, `${key} flagged`);
    assert.equal(e.editable, false, `${key} read-only`);
    assert.ok(isSecretEntry({ key }), `${key} also caught by the name blacklist`);
    assert.throws(() => coerce('server', key, 'x'), /Secret/);
  }
  assert.throws(() => coerce('server', 'TTS_RESPONSE_FORMAT', 'mp3'), /pcm, wav/);
  assert.equal(coerce('server', 'TTS_SPEED', ''), '', 'optional number: empty = server default, not 0');
  assert.throws(() => coerce('server', 'TTS_TIMEOUT_MS', ''), /Zahl/);
});

test('TTS vars are documented in apps/server/.env.example with the catalog default', () => {
  const example = fs.readFileSync(path.join(serverDir, '.env.example'), 'utf8');
  for (const key of keysReadByProvider()) {
    const m = example.match(new RegExp(`^(#\\s*)?${key}=(.*)$`, 'm'));
    assert.ok(m, `${key} missing from apps/server/.env.example`);
    // Commented-out provider examples show sample values; active lines must
    // equal the catalog default.
    if (!m[1]) assert.equal(m[2].trim(), def(key), `${key} default in .env.example`);
  }
});

test('TTS_* vars are passed through to the server container and listed in deploy/.env.example', () => {
  const compose = fs.readFileSync(path.join(repoDir, 'deploy/docker-compose.yml'), 'utf8');
  // The server's own `environment:` block (the rag service this used to end
  // at was removed — indexOf('\n  rag:') = -1 sliced to the end of the file).
  const start = compose.indexOf('\n  server:');
  const serverBlock = compose.slice(start, compose.indexOf('\n    env_file:', start));
  assert.ok(start > 0 && serverBlock.includes('TTS_PROVIDER'), 'server environment block not found');
  const deployEnv = fs.readFileSync(path.join(repoDir, 'deploy/.env.example'), 'utf8');
  // TTS_URL is fixed to the piper service inside the compose network;
  // ELEVENLABS_* stay in server.env (as before).
  const keys = keysReadByProvider().filter((k) => k.startsWith('TTS_') && k !== 'TTS_URL');
  for (const key of keys) {
    const m = serverBlock.match(new RegExp(`^\\s+${key}: \\$\\{${key}:-([^}]*)\\}`, 'm'));
    assert.ok(m, `${key} missing from the server service environment in deploy/docker-compose.yml`);
    assert.equal(m[1], def(key), `${key} compose default`);
    const d = deployEnv.match(new RegExp(`^${key}=(.*)$`, 'm'));
    assert.ok(d, `${key} missing from deploy/.env.example`);
    assert.equal(d[1].trim(), def(key), `${key} default in deploy/.env.example`);
  }
  assert.match(serverBlock, /^\s+TTS_URL: http:\/\/piper:5000$/m);
});
