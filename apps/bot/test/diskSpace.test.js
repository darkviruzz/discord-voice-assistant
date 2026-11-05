import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  diskConfig, freeBytes, assessRecording, measureRecording, formatBytes, formatDuration,
  isTmpPath, joinDiskLines, statusDiskLine, DiskWatch,
} from '../src/diskSpace.js';

const GB = 1e9;
const MB = 1e6;
const cfg = { bytesPerHour: 400 * MB, reserveBytes: 300 * MB, planHours: 5 };

test('diskConfig: defaults and env overrides (invalid values fall back)', () => {
  const d = diskConfig({});
  assert.deepEqual(d, { planHours: 5, bytesPerHour: 400 * MB, reserveBytes: 300 * MB, checkIntervalMs: 600_000 });
  const o = diskConfig({ SESSION_PLAN_HOURS: '6', DISK_MB_PER_HOUR: '370', DISK_RESERVE_MB: 'abc', DISK_CHECK_INTERVAL_MIN: '0' });
  assert.equal(o.planHours, 6);
  assert.equal(o.bytesPerHour, 370 * MB);
  assert.equal(o.reserveBytes, 300 * MB);
  assert.equal(o.checkIntervalMs, 600_000);
});

test('freeBytes measures the filesystem of a directory that does not exist yet', () => {
  const free = freeBytes(path.join(os.tmpdir(), 'does-not-exist-yet', 'deeper'));
  assert.ok(Number.isFinite(free) && free > 0);
});

test('assessRecording: hours that still fit after the finalize reserve', () => {
  const ok = assessRecording({ free: 10 * GB, ...cfg });
  assert.equal(ok.level, 'ok');
  assert.ok(Math.abs(ok.hoursLeft - 24.25) < 1e-9);
  assert.equal(assessRecording({ free: 1.5 * GB, ...cfg }).level, 'low'); // 3 h < 5 h planned
  assert.equal(assessRecording({ free: 500 * MB, ...cfg }).level, 'critical'); // 0.5 h
  const none = assessRecording({ free: 100 * MB, ...cfg });
  assert.equal(none.hoursLeft, 0, 'below the reserve nothing is left');
  assert.equal(none.level, 'critical');
});

test('measureRecording uses the env config and stays silent (null) when measuring fails', () => {
  const a = measureRecording('/data', { SESSION_PLAN_HOURS: '5' }, () => 2.1 * GB); // 4.5 h
  assert.equal(a.level, 'low');
  assert.equal(a.planHours, 5);
  assert.equal(measureRecording('/data', {}, () => { throw new Error('statfs unavailable'); }), null);
});

test('formatBytes / formatDuration', () => {
  assert.equal(formatBytes(3.14 * GB), '3,1 GB');
  assert.equal(formatBytes(400 * MB), '400 MB');
  assert.equal(formatBytes(-5), '0 MB');
  assert.equal(formatDuration(0.5), '30 min');
  assert.equal(formatDuration(3), '3 h');
  assert.equal(formatDuration(3.75), '3 h 45 min');
  assert.equal(formatDuration(24.25), '24 h');
  assert.equal(formatDuration(0), '0 min');
});

test('isTmpPath flags /tmp paths only', () => {
  assert.equal(isTmpPath('/tmp/voice-sessions'), true);
  assert.equal(isTmpPath('/tmp'), true);
  assert.equal(isTmpPath(path.join(os.tmpdir(), 'x')), true);
  assert.equal(isTmpPath('/home/discordbot/voice-sessions'), false);
  assert.equal(isTmpPath('/tmpfoo/x'), false);
});

test('joinDiskLines: no line when everything is fine', () => {
  const ok = assessRecording({ free: 20 * GB, ...cfg });
  assert.deepEqual(joinDiskLines(ok, { dataDir: '/home/discordbot/voice-sessions' }), []);
  assert.deepEqual(joinDiskLines(null, { dataDir: '/home/discordbot/voice-sessions' }), []);
});

test('joinDiskLines: warns when the planned session will not fit, and when DATA_DIR is under /tmp', () => {
  const low = joinDiskLines(assessRecording({ free: 1.5 * GB, ...cfg }), { dataDir: '/home/discordbot/voice-sessions' });
  assert.equal(low.length, 1);
  assert.match(low[0], /^⚠️ Bot-Speicher knapp: 1,5 GB frei — reicht für ca\. 3 h Aufnahme \(geplant 5 h\)\.$/);
  const crit = joinDiskLines(assessRecording({ free: 500 * MB, ...cfg }), {});
  assert.match(crit[0], /^🛑 Bot-Speicher fast voll: 500 MB frei — reicht nur noch für ca\. 30 min/);
  const tmp = joinDiskLines(assessRecording({ free: 20 * GB, ...cfg }), { dataDir: '/tmp/voice-sessions' });
  assert.equal(tmp.length, 1);
  assert.match(tmp[0], /DATA_DIR liegt unter \/tmp/);
});

test('statusDiskLine always reports (asked for explicitly)', () => {
  assert.equal(statusDiskLine(null), null);
  assert.match(statusDiskLine(assessRecording({ free: 18.4 * GB, ...cfg })), /^💾 Bot-Speicher: 18,4 GB frei — reicht für ca\. 45 h Aufnahme\.$/);
  assert.match(statusDiskLine(assessRecording({ free: 500 * MB, ...cfg })), /^🛑/);
});

function fakeTimers() {
  const t = { started: [], cleared: 0 };
  t.setInterval = (fn, ms) => { const h = { fn, ms, unref() {} }; t.started.push(h); return h; };
  t.clearInterval = () => { t.cleared++; };
  return t;
}

test('DiskWatch: silent while there is room, then one message per threshold', () => {
  let hours = 3;
  const sent = [];
  const timers = fakeTimers();
  const w = new DiskWatch({
    measure: () => ({ free: hours * 400 * MB, hoursLeft: hours, level: 'x' }),
    notify: (t) => sent.push(t),
    intervalMs: () => 600_000,
    timers,
  });
  w.start();
  assert.equal(timers.started[0].ms, 600_000);
  assert.equal(w.check(), null);
  hours = 0.9;
  assert.match(w.check(), /^⚠️ Bot-Speicher wird knapp: noch ca\. 54 min/);
  hours = 0.5;
  assert.equal(w.check(), null, 'the 1-h warning comes once');
  hours = 0.2;
  assert.match(w.check(), /^🛑 Bot-Speicher fast voll: noch ca\. 12 min/);
  hours = 0.1;
  assert.equal(w.check(), null);
  assert.equal(sent.length, 2);
  // A new session starts from scratch.
  w.start();
  hours = 0.1;
  assert.match(w.check(), /^🛑/, 'straight below 15 min → only the last warning');
  hours = 0.9;
  assert.equal(w.check(), null, 'the higher threshold is not reported afterwards');
  w.stop();
  assert.equal(w.isRunning(), false);
});

test('DiskWatch: an unmeasurable disk or a failing notify never throws', () => {
  const w = new DiskWatch({ measure: () => null, notify: () => { throw new Error('discord down'); }, intervalMs: 1, timers: fakeTimers() });
  assert.equal(w.check(), null);
  const w2 = new DiskWatch({ measure: () => ({ free: 0, hoursLeft: 0 }), notify: () => { throw new Error('discord down'); }, intervalMs: 1, timers: fakeTimers() });
  assert.match(w2.check(), /^🛑/);
});
