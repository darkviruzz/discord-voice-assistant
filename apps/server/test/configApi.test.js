import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { registerConfigRoutes } from '../src/configApi.js';

// PUT/GET /transcript/config semantics beyond the secret handling covered in
// configSecrets.test.js: persist vs temporary, warnings, partial failures,
// resets and the bot desired state.
let server;
let base;
let dir;
const ENV = ['CONFIG_OVERRIDES_FILE', 'PORT', 'STT_MAX_CHUNK_SECONDS', 'WAKE_WORD'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cfg-api-'));
  process.env.CONFIG_OVERRIDES_FILE = join(dir, 'overrides.json');
  process.env.PORT = '7440';
  const app = express();
  app.use(express.json());
  registerConfigRoutes(app);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/transcript/config`;
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const put = async (body) => {
  const res = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const item = async (scope, key) => {
  const data = await (await fetch(base)).json();
  return { data, it: data.groups.flatMap((g) => g.items).find((i) => i.scope === scope && i.key === key) };
};
const overridesOnDisk = () => JSON.parse(readFileSync(process.env.CONFIG_OVERRIDES_FILE, 'utf8'));

test('persisted server update: applied to process.env, written to the file, reported as persisted', async () => {
  const r = await put({ updates: [{ scope: 'server', key: 'STT_MAX_CHUNK_SECONDS', value: '45' }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.applied, [{ scope: 'server', key: 'STT_MAX_CHUNK_SECONDS', value: '45', applyMode: 'live', persisted: true }]);
  assert.equal(process.env.STT_MAX_CHUNK_SECONDS, '45');
  assert.equal(overridesOnDisk().server.STT_MAX_CHUNK_SECONDS, '45');
  const { it } = await item('server', 'STT_MAX_CHUNK_SECONDS');
  assert.equal(it.value, '45');
  assert.equal(it.status, 'persisted');
});

test('temporary update of a restart-only key warns that it has no effect until saved + restarted', async () => {
  const r = await put({ persist: false, updates: [{ scope: 'server', key: 'PORT', value: '8000' }] });
  assert.equal(r.body.ok, true);
  assert.match(r.body.warnings.join(' '), /PORT: applyMode „Neustart nötig"/);
  assert.equal((await item('server', 'PORT')).it.status, 'temporary');
  assert.equal('PORT' in (overridesOnDisk().server), false, 'temporary never reaches the file');
});

test('partial failure: valid updates still apply (200, ok:false), errors listed; all-invalid → 400', async () => {
  const mixed = await put({ updates: [
    { scope: 'server', key: 'WAKE_WORD', value: 'Krähe' },
    { scope: 'server', key: 'NOPE_NOT_A_KEY', value: '1' },
    { scope: 'server', key: 'STT_MAX_CHUNK_SECONDS', value: 'viele' },
  ] });
  assert.equal(mixed.status, 200);
  assert.equal(mixed.body.ok, false);
  assert.deepEqual(mixed.body.applied.map((a) => a.key), ['WAKE_WORD']);
  assert.equal(mixed.body.errors.length, 2);
  assert.match(mixed.body.errors.join(' | '), /unbekannt: server:NOPE_NOT_A_KEY/);
  assert.equal(process.env.STT_MAX_CHUNK_SECONDS, '45', 'invalid value did not overwrite the previous one');

  const bad = await put({ updates: [{ scope: 'server', key: 'STT_MAX_CHUNK_SECONDS', value: '' }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.applied.length, 0);
});

test('bot update without a connected bot: stored as desired state, warning returned, nothing pushed', async () => {
  const r = await put({ updates: [{ scope: 'bot', key: 'GATE_MS', value: '90' }] });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.botPushed, 0);
  assert.match(r.body.warnings.join(' '), /Kein Bot verbunden/);
  assert.equal(process.env.GATE_MS, undefined, 'bot keys never touch the server env');
  const { data, it } = await item('bot', 'GATE_MS');
  assert.equal(data.botDesiredState.GATE_MS, '90');
  assert.equal(it.value, '90');
  assert.equal(it.botReported, false, 'no bot report yet → desired value shown');
});

test('resets drop the override and restore the default (unknown reset keys are errors)', async () => {
  const r = await put({ resets: [
    { scope: 'server', key: 'STT_MAX_CHUNK_SECONDS' },
    { scope: 'bot', key: 'GATE_MS' },
    { scope: 'bot', key: 'NOPE' },
  ] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.applied.map((a) => `${a.scope}:${a.key}:${a.reset}`), ['server:STT_MAX_CHUNK_SECONDS:true', 'bot:GATE_MS:true']);
  assert.deepEqual(r.body.errors, ['unbekannt: bot:NOPE']);
  const file = overridesOnDisk();
  assert.equal('STT_MAX_CHUNK_SECONDS' in file.server, false);
  assert.equal('GATE_MS' in file.bot, false);
  assert.equal((await item('server', 'STT_MAX_CHUNK_SECONDS')).it.status, 'default');
});

test('an empty or malformed body changes nothing', async () => {
  const r = await put({ updates: 'nope', resets: { a: 1 } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.ok, r.body.applied, r.body.errors], [true, [], []]);
});
