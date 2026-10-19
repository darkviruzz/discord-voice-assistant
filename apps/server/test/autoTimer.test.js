import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { AutoFinalizeTimer } from '../src/finalize/autoTimer.js';

// Timers are mocked: the old real-time version slept 20–80 ms around 30–60 ms
// windows, which only held as long as the event loop never stalled.
beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

function make(idleMs = 1000) {
  const fired = [];
  const t = new AutoFinalizeTimer({ idleMs, onFire: (sid) => fired.push(sid) });
  return { t, fired };
}

test('arms on idle (left/alone) and fires exactly at the idle window', () => {
  const { t, fired } = make(1000);
  t.notify('s1', 'left');
  mock.timers.tick(999);
  assert.deepEqual(fired, []);
  mock.timers.tick(1);
  assert.deepEqual(fired, ['s1']);
  assert.ok(t.isFinalizing('s1'), 'locked once fired');
  mock.timers.tick(10_000);
  assert.deepEqual(fired, ['s1'], 'fires once');
});

test('activity (joined/occupied) cancels a pending timer', () => {
  const { t, fired } = make(1000);
  t.notify('s1', 'left');      // arm
  mock.timers.tick(500);
  t.notify('s1', 'occupied');  // someone present → cancel
  mock.timers.tick(5000);
  assert.deepEqual(fired, []);
  assert.ok(!t.isFinalizing('s1'));
});

test('re-arming restarts the full idle window (no early fire from the first arm)', () => {
  const { t, fired } = make(1000);
  t.notify('s1', 'left');
  mock.timers.tick(600);
  t.notify('s1', 'alone');     // re-arm resets the countdown
  mock.timers.tick(600);
  assert.deepEqual(fired, [], 'first timer was replaced');
  mock.timers.tick(400);
  assert.deepEqual(fired, ['s1']);
});

test('re-arms on a later idle after activity', () => {
  const { t, fired } = make(1000);
  t.notify('s1', 'left');
  t.notify('s1', 'joined');    // cancel
  mock.timers.tick(2000);
  assert.deepEqual(fired, []);
  t.notify('s1', 'alone');     // arm again
  mock.timers.tick(1000);
  assert.deepEqual(fired, ['s1']);
});

test('sessions are independent; numeric and string ids address the same session', () => {
  const { t, fired } = make(1000);
  t.notify(1700000000000n, 'left');
  t.notify('1700000000001', 'left');
  mock.timers.tick(500);
  t.notify(1700000000000, 'occupied'); // number form cancels the BigInt-armed timer
  mock.timers.tick(500);
  assert.deepEqual(fired, ['1700000000001']);
});

test('markFinalizing locks the session against arming and double-fire', () => {
  const { t, fired } = make(1000);
  t.notify('s1', 'left');      // armed
  t.markFinalizing('s1');      // manual finalize started → cancels + locks
  t.notify('s1', 'left');      // must be ignored
  mock.timers.tick(5000);
  assert.deepEqual(fired, []);
  assert.ok(t.isFinalizing('s1'));
});

test('release allows a session to be re-armed after a failed finalize', () => {
  const { t, fired } = make(1000);
  t.markFinalizing('s1');
  t.release('s1');
  t.notify('s1', 'left');
  mock.timers.tick(1000);
  assert.deepEqual(fired, ['s1']);
});

test('a throwing onFire is contained; unknown states are ignored', () => {
  const t = new AutoFinalizeTimer({ idleMs: 10, onFire: () => { throw new Error('bot gone'); } });
  t.notify('s1', 'speaking');  // not a presence transition → no-op
  mock.timers.tick(100);
  assert.ok(!t.isFinalizing('s1'));
  t.notify('s1', 'left');
  assert.doesNotThrow(() => mock.timers.tick(10));
  assert.ok(t.isFinalizing('s1'));
});

test('default idle window comes from SESSION_IDLE_HOURS (4 h)', () => {
  const saved = process.env.SESSION_IDLE_HOURS;
  try {
    delete process.env.SESSION_IDLE_HOURS;
    assert.equal(new AutoFinalizeTimer().idleMs, 4 * 3600_000);
    process.env.SESSION_IDLE_HOURS = '0.5';
    assert.equal(new AutoFinalizeTimer().idleMs, 1_800_000);
  } finally {
    if (saved === undefined) delete process.env.SESSION_IDLE_HOURS; else process.env.SESSION_IDLE_HOURS = saved;
  }
});
