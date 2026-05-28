import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoFinalizeTimer } from '../src/finalize/autoTimer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('arms on idle (left/alone) and fires after the idle window', async () => {
  const fired = [];
  const t = new AutoFinalizeTimer({ idleMs: 40, onFire: (sid) => fired.push(sid) });
  t.notify('s1', 'left');
  await sleep(80);
  assert.deepEqual(fired, ['s1']);
  assert.ok(t.isFinalizing('s1'));
});

test('activity (joined/occupied) cancels a pending timer', async () => {
  const fired = [];
  const t = new AutoFinalizeTimer({ idleMs: 60, onFire: (sid) => fired.push(sid) });
  t.notify('s1', 'left');     // arm
  await sleep(20);
  t.notify('s1', 'occupied'); // someone present → cancel
  await sleep(80);
  assert.deepEqual(fired, []);
  assert.ok(!t.isFinalizing('s1'));
});

test('re-arms on a later idle after activity', async () => {
  const fired = [];
  const t = new AutoFinalizeTimer({ idleMs: 40, onFire: (sid) => fired.push(sid) });
  t.notify('s1', 'left');
  t.notify('s1', 'joined');   // cancel
  await sleep(50);
  t.notify('s1', 'alone');    // arm again
  await sleep(70);
  assert.deepEqual(fired, ['s1']);
});

test('markFinalizing locks the session against arming and double-fire', async () => {
  const fired = [];
  const t = new AutoFinalizeTimer({ idleMs: 30, onFire: (sid) => fired.push(sid) });
  t.markFinalizing('s1');     // manual finalize started
  t.notify('s1', 'left');     // must be ignored
  await sleep(60);
  assert.deepEqual(fired, []);
  assert.ok(t.isFinalizing('s1'));
});

test('release allows a session to be re-armed after a failed finalize', async () => {
  const fired = [];
  const t = new AutoFinalizeTimer({ idleMs: 30, onFire: (sid) => fired.push(sid) });
  t.markFinalizing('s1');
  t.release('s1');
  t.notify('s1', 'left');
  await sleep(60);
  assert.deepEqual(fired, ['s1']);
});
