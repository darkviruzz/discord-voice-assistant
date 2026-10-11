import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeaveFinalizeScheduler } from '../src/leaveFinalize.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('fires once the idle window after the last activity has passed', async () => {
  const ran = [];
  const s = new LeaveFinalizeScheduler({ idleMs: 40, run: async (id) => { ran.push(id); } });
  s.arm('a', Date.now());
  assert.ok(s.isArmed('a'));
  await sleep(15);
  assert.deepEqual(ran, []);
  await sleep(60);
  assert.deepEqual(ran, ['a']);
  assert.ok(!s.isArmed('a'));
});

test('overdue session runs after minDelayMs, not immediately', async () => {
  const ran = [];
  const s = new LeaveFinalizeScheduler({ idleMs: 10, run: async (id) => { ran.push(id); } });
  s.arm('old', Date.now() - 10_000, { minDelayMs: 30 });
  await sleep(10);
  assert.deepEqual(ran, []);
  await sleep(50);
  assert.deepEqual(ran, ['old']);
});

test('cancelAll (re-/join) prevents the run; re-arming resets the countdown', async () => {
  const ran = [];
  const s = new LeaveFinalizeScheduler({ idleMs: 30, run: async (id) => { ran.push(id); } });
  s.arm('a', Date.now());
  s.cancelAll();
  s.arm('b', Date.now());
  await sleep(15);
  s.arm('b', Date.now()); // fresh activity → countdown restarts
  await sleep(20);
  assert.deepEqual(ran, []);
  await sleep(40);
  assert.deepEqual(ran, ['b']);
});

test('isBlocked (session live again) skips the run', async () => {
  const ran = [];
  const s = new LeaveFinalizeScheduler({ idleMs: 5, run: async (id) => { ran.push(id); }, isBlocked: (id) => id === 'live' });
  s.arm('live', Date.now());
  s.arm('idle', Date.now());
  await sleep(40);
  assert.deepEqual(ran, ['idle']);
});

test('runs are serialised and a failing run does not block the next one', async () => {
  const log = [];
  let active = 0;
  const s = new LeaveFinalizeScheduler({
    idleMs: 0,
    run: async (id) => {
      active++;
      assert.equal(active, 1, 'two finalizes overlapped');
      log.push(`start ${id}`);
      await sleep(15);
      log.push(`end ${id}`);
      active--;
      if (id === 'x') throw new Error('server down');
    },
  });
  const now = Date.now();
  s.arm('x', now);
  s.arm('y', now);
  s.arm('z', now);
  await sleep(100);
  assert.deepEqual(log, ['start x', 'end x', 'start y', 'end y', 'start z', 'end z']);
});

test('disabled scheduler never arms', async () => {
  const ran = [];
  const s = new LeaveFinalizeScheduler({ idleMs: 0, enabled: false, run: async (id) => { ran.push(id); } });
  s.arm('a', Date.now());
  assert.ok(!s.isArmed('a'));
  await sleep(10);
  assert.deepEqual(ran, []);
});
