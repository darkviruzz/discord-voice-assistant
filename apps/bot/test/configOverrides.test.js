import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CATALOG, isSecretEntry } from '../../server/src/configCatalog.js';

// configOverrides.js keeps module state: the override-file path is fixed on
// first use (from DATA_DIR) and the .env baseline is captured on the first
// apply. So: point DATA_DIR at a scratch dir, define the "baseline" env, load
// the module once and capture that baseline, then isolate tests by wiping the
// override file and restoring process.env after each one.
let dataDir;
let mod;
let savedEnv;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-cfg-'));
  process.env.DATA_DIR = dataDir;
  process.env.REWIND_MS = '1000'; // pretend this came from .env
  delete process.env.GATE_MS;     // …and this one did not
  mod = await import('../src/configOverrides.js');
  assert.equal(mod.applyOverridesAtBoot(), 0, 'no override file yet → baseline captured, nothing applied');
});

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.REWIND_MS;
});

beforeEach(() => { savedEnv = { ...process.env }; });

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  fs.rmSync(overridesPath(), { force: true });
});

const overridesPath = () => path.join(dataDir, 'config.overrides.json');
const readOverrides = () => JSON.parse(fs.readFileSync(overridesPath(), 'utf8'));

test('config_update applies only allow-listed bot keys; secrets and arbitrary env vars are refused', async () => {
  const { applyConfigUpdate } = mod;
  const before = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS };
  const r = applyConfigUpdate({
    set: {
      INTERRUPT_MIN_MS: 900,
      DISCORD_TOKEN: 'stolen',
      CONTROL_BEARER: 'stolen',
      NODE_OPTIONS: '--require /tmp/evil.js',
      PATH: '/evil',
    },
  });
  assert.deepEqual(r.applied, ['INTERRUPT_MIN_MS']);
  assert.deepEqual(r.ignored.sort(), ['CONTROL_BEARER', 'DISCORD_TOKEN', 'NODE_OPTIONS', 'PATH']);
  assert.equal(process.env.INTERRUPT_MIN_MS, '900', 'value stringified into process.env');
  assert.equal(process.env.PATH, before.PATH);
  assert.equal(process.env.NODE_OPTIONS, before.NODE_OPTIONS);
  assert.notEqual(process.env.DISCORD_TOKEN, 'stolen');
  assert.deepEqual(readOverrides(), { version: 1, bot: { INTERRUPT_MIN_MS: '900' } }, 'only the allowed key persisted');
});

test('persisted overrides are re-applied at boot; non-bot keys smuggled into the file are ignored', async () => {
  fs.writeFileSync(overridesPath(), JSON.stringify({
    version: 1,
    bot: { GATE_MS: 120, REWIND_MS: '750', NODE_OPTIONS: '--inspect', DISCORD_TOKEN: 'x' },
  }));
  const nodeOptions = process.env.NODE_OPTIONS;
  assert.equal(mod.applyOverridesAtBoot(), 2);
  assert.equal(process.env.GATE_MS, '120');
  assert.equal(process.env.REWIND_MS, '750');
  assert.equal(process.env.NODE_OPTIONS, nodeOptions);
});

test('a missing or corrupt override file boots with zero overrides', async () => {
  assert.equal(mod.applyOverridesAtBoot(), 0);
  fs.writeFileSync(overridesPath(), '{oops');
  assert.equal(mod.applyOverridesAtBoot(), 0);
  fs.writeFileSync(overridesPath(), JSON.stringify({ version: 1, bot: null }));
  assert.equal(mod.applyOverridesAtBoot(), 0);
});

test('reset restores the .env baseline, or removes a key the baseline never had', async () => {
  // Baseline (captured in before()): REWIND_MS=1000 from .env, GATE_MS unset.
  const { applyConfigUpdate } = mod;
  applyConfigUpdate({ set: { REWIND_MS: '500', GATE_MS: '90' } });
  assert.equal(process.env.REWIND_MS, '500');
  assert.equal(process.env.GATE_MS, '90');

  const r = applyConfigUpdate({ reset: ['REWIND_MS', 'GATE_MS', 'DISCORD_TOKEN'] });
  assert.deepEqual(r.applied, ['REWIND_MS', 'GATE_MS']);
  assert.deepEqual(r.ignored, ['DISCORD_TOKEN']);
  assert.equal(process.env.REWIND_MS, '1000', 'back to the .env value');
  assert.equal('GATE_MS' in process.env, false, 'no baseline → removed');
  assert.deepEqual(readOverrides().bot, {}, 'reset also drops the persisted override');
});

test('persist:false is temporary — process.env changes, the override file does not', async () => {
  const { applyConfigUpdate } = mod;
  applyConfigUpdate({ set: { GATE_MS: '100' } });
  const r = applyConfigUpdate({ set: { GATE_MS: '55' }, persist: false });
  assert.equal(r.persisted, false);
  assert.equal(process.env.GATE_MS, '55');
  assert.equal(readOverrides().bot.GATE_MS, '100', 'persisted desired state unchanged');
});

test('reportableConfig reports bot values but never secret values — only whether they are set', async () => {
  process.env.DISCORD_TOKEN = 'very-secret-token';
  process.env.CONTROL_BEARER = '';
  process.env.INTERRUPT_MIN_MS = '850';
  const { reportableConfig } = mod;
  const rep = reportableConfig();
  assert.equal(rep.values.INTERRUPT_MIN_MS, '850');
  assert.equal(rep.values.DISCORD_TOKEN, undefined);
  assert.equal(rep.values.CONTROL_BEARER, undefined);
  assert.equal(rep.secretsSet.DISCORD_TOKEN, true);
  assert.equal(rep.secretsSet.CONTROL_BEARER, false, 'empty string counts as not set');
  assert.ok(!JSON.stringify(rep).includes('very-secret-token'));
});

test('contract: every non-secret bot key in the server catalog is accepted by the bot', async () => {
  // configCatalog.js (server) and BOT_KEYS (bot) must list the same keys —
  // otherwise the settings panel offers a key the bot silently ignores.
  const catalogKeys = CATALOG.filter((e) => e.scope === 'bot' && !isSecretEntry(e) && e.editable !== false).map((e) => e.key);
  assert.ok(catalogKeys.length > 10);
  const { applyConfigUpdate } = mod;
  const r = applyConfigUpdate({ set: Object.fromEntries(catalogKeys.map((k) => [k, '1'])), persist: false });
  assert.deepEqual(r.ignored, [], `catalog keys the bot would ignore: ${r.ignored.join(', ')}`);
  assert.deepEqual(r.applied.sort(), [...catalogKeys].sort());

  // …and the catalog's bot secrets are exactly what the bot refuses to take.
  const secretKeys = CATALOG.filter((e) => e.scope === 'bot' && isSecretEntry(e)).map((e) => e.key);
  const s = applyConfigUpdate({ set: Object.fromEntries(secretKeys.map((k) => [k, 'x'])), persist: false });
  assert.deepEqual(s.applied, []);

  // …and env-only keys (shell commands, server URLs that receive the bearer)
  // are refused even though the server would never send them.
  const envOnly = CATALOG.filter((e) => e.scope === 'bot' && !isSecretEntry(e) && e.editable === false).map((e) => e.key);
  for (const k of ['SERVER_START_CMD', 'SERVER_STOP_CMD', 'FINALIZE_UPLOAD_CMD', 'SERVER_BASE_URL', 'CONTROL_WS_URL']) {
    assert.ok(envOnly.includes(k), `${k} must be editable:false in the catalog`);
  }
  const e = applyConfigUpdate({ set: Object.fromEntries(envOnly.map((k) => [k, 'touch /tmp/pwned'])), persist: false });
  assert.deepEqual(e.applied, []);
  assert.deepEqual(e.ignored.sort(), [...envOnly].sort());
});
