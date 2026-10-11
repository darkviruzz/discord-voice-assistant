import { test, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scheduleServerStop, cancelServerStop } from '../src/serverAutoStop.js';

// The idle stop destroys a (billed) cloud instance, so: it must fire after the
// configured idle delay, re-check for work at fire time, and never stack.
// Timers are mocked; the stop command itself is a real (harmless) process that
// writes a marker file, so we can observe whether it actually ran.

let dir;
let marker;
const savedEnv = { ...process.env };

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-autostop-'));
  marker = path.join(dir, 'stopped');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

afterEach(() => {
  cancelServerStop();
  mock.timers.reset();
  fs.rmSync(marker, { force: true });
  for (const k of ['SERVER_STOP_CMD', 'SERVER_STOP_DELAY_MS']) {
    if (k in savedEnv) process.env[k] = savedEnv[k]; else delete process.env[k];
  }
});

function useStopCommand(delayMs) {
  process.env.SERVER_STOP_CMD = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(process.argv[1], 'x')" ${JSON.stringify(marker)}`;
  if (delayMs === undefined) delete process.env.SERVER_STOP_DELAY_MS;
  else process.env.SERVER_STOP_DELAY_MS = String(delayMs);
}

// Real-time wait (timers must be un-mocked first) for the marker file.
async function markerAppears(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(marker)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fs.existsSync(marker);
}

test('runs SERVER_STOP_CMD once the idle delay elapses and there is no work', async () => {
  useStopCommand(60_000);
  mock.timers.enable({ apis: ['setTimeout'] });
  const hasWork = mock.fn(() => false);
  scheduleServerStop({ hasWork });
  mock.timers.tick(59_999);
  assert.equal(hasWork.mock.callCount(), 0, 'not before the delay');
  mock.timers.tick(1);
  assert.equal(hasWork.mock.callCount(), 1, 'work re-checked exactly at fire time');
  mock.timers.reset();
  assert.equal(await markerAppears(5000), true, 'stop command executed');
});

test('skips the stop when a session became active again before the timer fired', async () => {
  useStopCommand(1000);
  mock.timers.enable({ apis: ['setTimeout'] });
  const hasWork = mock.fn(() => true);
  scheduleServerStop({ hasWork });
  mock.timers.tick(1000);
  assert.equal(hasWork.mock.callCount(), 1);
  mock.timers.reset();
  assert.equal(await markerAppears(400), false, 'no stop while work is pending');
});

test('cancelServerStop disarms a pending stop', async () => {
  useStopCommand(1000);
  mock.timers.enable({ apis: ['setTimeout'] });
  const hasWork = mock.fn(() => false);
  scheduleServerStop({ hasWork });
  cancelServerStop();
  cancelServerStop(); // idempotent
  mock.timers.tick(10_000);
  assert.equal(hasWork.mock.callCount(), 0);
  mock.timers.reset();
  assert.equal(await markerAppears(400), false);
});

test('re-arming replaces the pending timer instead of stacking a second stop', () => {
  useStopCommand(1000);
  mock.timers.enable({ apis: ['setTimeout'] });
  const first = mock.fn(() => true);
  const second = mock.fn(() => true);
  scheduleServerStop({ hasWork: first });
  mock.timers.tick(600);
  scheduleServerStop({ hasWork: second }); // restarts the full delay
  mock.timers.tick(600);
  assert.equal(second.mock.callCount(), 0, 'delay restarted on re-arm');
  mock.timers.tick(400);
  assert.equal(first.mock.callCount(), 0, 'first timer was replaced, never fires');
  assert.equal(second.mock.callCount(), 1);
});

test('SERVER_STOP_DELAY_MS unset / 0 / garbage falls back to the 15 min default', () => {
  for (const v of [undefined, '0', 'soon']) {
    useStopCommand(v);
    mock.timers.enable({ apis: ['setTimeout'] });
    const hasWork = mock.fn(() => true);
    scheduleServerStop({ hasWork });
    mock.timers.tick(899_999);
    assert.equal(hasWork.mock.callCount(), 0, `delay=${v}: not before 15 min`);
    mock.timers.tick(1);
    assert.equal(hasWork.mock.callCount(), 1, `delay=${v}: fires at 15 min`);
    mock.timers.reset();
  }
});

test('feature off without SERVER_STOP_CMD: nothing is scheduled', () => {
  delete process.env.SERVER_STOP_CMD;
  mock.timers.enable({ apis: ['setTimeout'] });
  const hasWork = mock.fn(() => false);
  scheduleServerStop({ hasWork });
  mock.timers.tick(10 * 900_000);
  assert.equal(hasWork.mock.callCount(), 0);
});
