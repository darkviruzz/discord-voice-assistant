import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isSecretKey, isSecretEntry, CATALOG } from '../src/configCatalog.js';
import { setBotReported, getBotReported, coerce } from '../src/configStore.js';
import { registerConfigRoutes } from '../src/configApi.js';

let server, base, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cfg-test-'));
  process.env.CONFIG_OVERRIDES_FILE = join(dir, 'overrides.json');
  const app = express();
  app.use(express.json());
  registerConfigRoutes(app);
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CONFIG_OVERRIDES_FILE;
});

test('blacklist erkennt Secret-Namen, aber keine harmlosen Keys', () => {
  for (const k of ['DISCORD_TOKEN', 'SESSION_SECRET', 'CONTROL_BEARER',
    'ELEVENLABS_API_KEY', 'TRANSCRIPT_UI_PASS', 'MY_NEW_PASSWORD', 'X_CREDENTIALS']) {
    assert.equal(isSecretKey(k), true, `${k} muss als Secret gelten`);
  }
  for (const k of ['WAKE_WORD', 'STOP_PHRASES', 'PAUSE_THRESHOLD_S', 'TRANSCRIPT_UI_AUTH',
    'OLLAMA_KEEP_ALIVE', 'ELEVENLABS_VOICE_ID', 'SPEAKER_MAP_FILE']) {
    assert.equal(isSecretKey(k), false, `${k} darf kein Secret sein`);
  }
});

test('jeder explizit geflaggte Katalog-Secret wird auch von der Blacklist erfasst', () => {
  // Damit ein vergessenes Flag nie schwächer schützt als heute: alle
  // secret:true-Einträge müssen ebenfalls per Namen erkannt werden.
  for (const e of CATALOG.filter((e) => e.secret)) {
    assert.equal(isSecretEntry({ key: e.key }), true, `${e.key} muss die Blacklist treffen`);
  }
});

test('Blacklist greift auch ohne secret-Flag (isSecretEntry, worauf coerce/itemFor bauen)', () => {
  // Der Katalog hat derzeit keinen ungeflaggten Secret-Namen, über den sich der
  // Blacklist-Pfad in coerce() End-to-End prüfen ließe — daher direkt:
  for (const key of ['NEW_SERVICE_API_KEY', 'SMTP_PASSWORD', 'OAUTH_CLIENT_SECRET', 'GITHUB_TOKEN']) {
    assert.equal(isSecretEntry({ key, secret: false }), true, key);
  }
  assert.equal(isSecretEntry({ key: 'WAKE_WORD', secret: false }), false);
  assert.equal(isSecretEntry(null), false);
});

test('coerce verweigert geflaggte Secrets mit klarer Meldung', () => {
  assert.throws(() => coerce('server', 'TRANSCRIPT_UI_PASS', 'x'), /TRANSCRIPT_UI_PASS ist ein Secret/);
  assert.throws(() => coerce('bot', 'CONTROL_BEARER', 'x'), /Secret/);
});

test('GET /transcript/config liefert nie Secret-Werte, PUT lehnt sie ab', async (t) => {
  process.env.SESSION_SECRET = 'super-geheim';
  t.after(() => { delete process.env.SESSION_SECRET; });
  const res = await fetch(`${base}/transcript/config`);
  const data = await res.json();
  const items = data.groups.flatMap((g) => g.items);
  const secretItems = items.filter((i) => i.secret);
  assert.ok(secretItems.length >= 5, 'Katalog muss Secrets enthalten');
  for (const it of secretItems) {
    assert.equal(it.value, null, `${it.key}: Wert darf nicht ausgeliefert werden`);
    assert.equal(it.editable, false, `${it.key}: muss read-only sein`);
  }
  assert.ok(!JSON.stringify(data).includes('super-geheim'), 'Secret-Wert darf nirgends im Payload stehen');

  const put = await fetch(`${base}/transcript/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates: [{ scope: 'server', key: 'SESSION_SECRET', value: 'neu' }] }),
  });
  const out = await put.json();
  assert.equal(put.status, 400, 'nothing applied → 400');
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /Secret/);
  assert.equal(process.env.SESSION_SECRET, 'super-geheim', 'Wert unverändert');
});

test('config_state-Report: Werte gecacht, Secrets doppelt gefiltert, API zeigt Ist + Drift', async () => {
  setBotReported({
    values: {
      INTERRUPT_MIN_MS: '900',
      // Bot dürfte das nie schicken — der Server muss es trotzdem wegfiltern:
      DISCORD_TOKEN: 'geleakter-wert',
    },
    secretsSet: { CONTROL_BEARER: true },
  });
  const rep = getBotReported();
  assert.equal(rep.values.INTERRUPT_MIN_MS, '900');
  assert.equal(rep.values.DISCORD_TOKEN, undefined, 'Token-Wert darf nicht in den Cache');
  assert.equal(rep.secretsSet.DISCORD_TOKEN, true, 'nur „gesetzt?" bleibt übrig');
  assert.equal(rep.secretsSet.CONTROL_BEARER, true);

  const res = await fetch(`${base}/transcript/config`);
  const data = await res.json();
  assert.ok(!JSON.stringify(data).includes('geleakter-wert'));
  const items = data.groups.flatMap((g) => g.items);
  const interrupt = items.find((i) => i.scope === 'bot' && i.key === 'INTERRUPT_MIN_MS');
  assert.equal(interrupt.value, '900', 'gemeldeter Ist-Wert wird angezeigt');
  assert.equal(interrupt.botReported, true);
  const bearer = items.find((i) => i.scope === 'bot' && i.key === 'CONTROL_BEARER');
  assert.equal(bearer.isSet, true, 'Bot-Secret-Status kommt aus dem Report');
  assert.equal(typeof data.botReportedAt, 'number');

  // Drift: Desired State (Override) ≠ gemeldeter Ist-Wert.
  const put = await fetch(`${base}/transcript/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates: [{ scope: 'bot', key: 'INTERRUPT_MIN_MS', value: '1200' }] }),
  });
  assert.equal((await put.json()).ok, true);
  const res2 = await fetch(`${base}/transcript/config`);
  const it2 = (await res2.json()).groups.flatMap((g) => g.items)
    .find((i) => i.scope === 'bot' && i.key === 'INTERRUPT_MIN_MS');
  assert.equal(it2.value, '900', 'Anzeige bleibt der Ist-Wert');
  assert.equal(it2.desired, '1200', 'Drift zum gespeicherten Wunsch wird gemeldet');
});
