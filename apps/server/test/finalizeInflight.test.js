import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { FinalizeRegistry } from '../src/finalize/inflight.js';
import { deliverFinalizeResult } from '../src/control.js';
import { botConnections } from '../src/broadcast.js';

// Finalize idempotency per session: one run, any number of waiters; successful
// results cached briefly for re-sends (same cmdId), failures never cached.

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeRegistry(opts = {}) {
  const delivered = []; // { cmdId, ws, payload }
  const reg = new FinalizeRegistry({
    deliver: (w, payload) => delivered.push({ cmdId: w.cmdId, ws: w.ws, payload }),
    ...opts,
  });
  return { reg, delivered };
}

const OK = { ok: true, sessionId: '100', transcriptPath: '/archive/s/transcript.md' };

test('a request for a running session joins it: one run, every waiter gets the result', async () => {
  const { reg, delivered } = makeRegistry();
  const gate = deferred();
  let runs = 0;
  assert.equal(reg.attach('100', { ws: 'a', cmdId: 'c1' }), null);
  const done = reg.start('100', { ws: 'a', cmdId: 'c1' }, async () => { runs++; return gate.promise; });

  // e.g. a manual /finalize racing the idle auto-finalize
  assert.equal(reg.attach('100', { ws: 'b', cmdId: 'c2' }), 'joined');
  assert.equal(reg.isRunning('100'), true);
  assert.equal(delivered.length, 0, 'nothing delivered while running');

  gate.resolve(OK);
  assert.deepEqual(await done, OK);
  assert.equal(runs, 1, 'no second run');
  assert.deepEqual(delivered.map((d) => [d.cmdId, d.ws]).sort(), [['c1', 'a'], ['c2', 'b']]);
  assert.ok(delivered.every((d) => d.payload === OK));
  assert.equal(reg.isRunning('100'), false);
});

test('a re-send (same cmdId) replaces the dead socket of its earlier attempt — delivered once, to the new one', async () => {
  const { reg, delivered } = makeRegistry();
  const gate = deferred();
  const done = reg.start('100', { ws: 'old-socket', cmdId: 'c1' }, () => gate.promise);
  assert.equal(reg.attach('100', { ws: 'new-socket', cmdId: 'c1' }), 'joined');
  gate.resolve(OK);
  await done;
  assert.deepEqual(delivered.map((d) => [d.cmdId, d.ws]), [['c1', 'new-socket']]);
});

test('a re-send arriving just after completion is answered from the cache (not NO_MANIFEST)', async () => {
  const { reg, delivered } = makeRegistry();
  await reg.start('100', { ws: 'a', cmdId: 'c1' }, async () => OK);
  delivered.length = 0;

  assert.equal(reg.attach('100', { ws: 'reconnected', cmdId: 'c1' }), 'cached');
  assert.deepEqual(delivered, [{ cmdId: 'c1', ws: 'reconnected', payload: OK }]);
});

test('joined waiters can be answered from the cache too', async () => {
  const { reg, delivered } = makeRegistry();
  const gate = deferred();
  const done = reg.start('100', { ws: 'a', cmdId: 'c1' }, () => gate.promise);
  reg.attach('100', { ws: 'b', cmdId: 'c2' });
  gate.resolve(OK);
  await done;
  delivered.length = 0;
  assert.equal(reg.attach('100', { ws: 'b2', cmdId: 'c2' }), 'cached');
  assert.equal(delivered.length, 1);
});

test('a NEW request (new cmdId) after completion runs again — deliberate re-finalize is not swallowed by the cache', async () => {
  const { reg } = makeRegistry();
  let runs = 0;
  await reg.start('100', { ws: 'a', cmdId: 'c1' }, async () => { runs++; return OK; });
  assert.equal(reg.attach('100', { ws: 'a', cmdId: 'c-refinalize' }), null);
  await reg.start('100', { ws: 'a', cmdId: 'c-refinalize' }, async () => { runs++; return { ...OK, spanCount: 2 }; });
  assert.equal(runs, 2);
  // The newer run superseded the old cache entry.
  assert.equal(reg.attach('100', { ws: 'a', cmdId: 'c1' }), null);
  assert.equal(reg.attach('100', { ws: 'a', cmdId: 'c-refinalize' }), 'cached');
});

test('failures are delivered to every waiter but never cached — a retry runs again', async () => {
  const { reg, delivered } = makeRegistry();
  const gate = deferred();
  const done = reg.start('100', { ws: 'a', cmdId: 'c1' }, () => gate.promise);
  reg.attach('100', { ws: 'b', cmdId: 'c2' });
  gate.reject(new Error('whisper down'));
  const payload = await done; // never rejects
  assert.deepEqual(payload, { ok: false, sessionId: '100', error: 'whisper down' });
  assert.equal(delivered.length, 2);
  assert.ok(delivered.every((d) => d.payload.ok === false && d.payload.error === 'whisper down'));

  // Same cmdId re-sent after the failure → no cached failure, runs again.
  assert.equal(reg.attach('100', { ws: 'a', cmdId: 'c1' }), null);
  let reran = false;
  const second = await reg.start('100', { ws: 'a', cmdId: 'c1' }, async () => { reran = true; return OK; });
  assert.equal(reran, true);
  assert.equal(second.ok, true);
});

test('an {ok:false} result returned without throwing is not cached either', async () => {
  const { reg } = makeRegistry();
  await reg.start('100', { ws: 'a', cmdId: 'c1' }, async () => ({ ok: false, sessionId: '100', error: 'x' }));
  assert.equal(reg.attach('100', { ws: 'a', cmdId: 'c1' }), null);
});

test('cached results expire after cacheTtlMs', async () => {
  let now = 1_000;
  const { reg } = makeRegistry({ cacheTtlMs: 500, now: () => now });
  await reg.start('100', { ws: 'a', cmdId: 'c1' }, async () => OK);
  now += 499;
  assert.equal(reg.attach('100', { ws: 'a', cmdId: 'c1' }), 'cached');
  now += 1;
  assert.equal(reg.attach('100', { ws: 'a', cmdId: 'c1' }), null);
});

test('runs are per session: another session is never joined', async () => {
  const { reg } = makeRegistry();
  const gate = deferred();
  const done = reg.start('100', { ws: 'a', cmdId: 'c1' }, () => gate.promise);
  assert.equal(reg.attach('200', { ws: 'a', cmdId: 'c9' }), null);
  gate.resolve(OK);
  await done;
});

test('start() for a running session refuses instead of running in parallel', async () => {
  const { reg } = makeRegistry();
  const gate = deferred();
  let runs = 0;
  const done = reg.start('100', { ws: 'a', cmdId: 'c1' }, () => { runs++; return gate.promise; });
  await assert.rejects(reg.start('100', { ws: 'b', cmdId: 'c2' }, async () => { runs++; return OK; }), /already running/);
  gate.resolve(OK);
  await done;
  assert.equal(runs, 1);
});

test('a throwing deliver for one waiter does not starve the others', async () => {
  const got = [];
  const reg = new FinalizeRegistry({
    deliver: (w) => { if (w.cmdId === 'bad') throw new Error('socket exploded'); got.push(w.cmdId); },
  });
  const gate = deferred();
  const done = reg.start('100', { ws: 'a', cmdId: 'bad' }, () => gate.promise);
  reg.attach('100', { ws: 'b', cmdId: 'good' });
  gate.resolve(OK);
  await done;
  assert.deepEqual(got, ['good']);
});

// ── control.js delivery: original socket vs. the bot's current connection ──

function fakeWs(open = true) {
  return { OPEN: 1, readyState: open ? 1 : 3, sent: [], send(m) { this.sent.push(JSON.parse(m)); } };
}

afterEach(() => botConnections.clear());

test('deliverFinalizeResult answers on the requesting socket while it is open', () => {
  const ws = fakeWs(true);
  const other = fakeWs(true);
  botConnections.add(ws);
  botConnections.add(other);
  deliverFinalizeResult({ ws, cmdId: 'c1' }, OK);
  assert.deepEqual(ws.sent, [{ ...OK, type: 'finalize_result', cmdId: 'c1' }]);
  assert.equal(other.sent.length, 0);
});

test('deliverFinalizeResult falls back to the bot’s current connection when the requesting socket closed', () => {
  const dead = fakeWs(false);
  const reconnected = fakeWs(true);
  botConnections.add(reconnected); // the dead one was removed on close
  deliverFinalizeResult({ ws: dead, cmdId: 'c1' }, OK);
  assert.equal(dead.sent.length, 0);
  assert.deepEqual(reconnected.sent, [{ ...OK, type: 'finalize_result', cmdId: 'c1' }],
    'same cmdId → matches the bot’s still-pending (resumable) request');
});
