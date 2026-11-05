import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeFileAtomic, isDiskFullError, describeError } from '../src/fsSafe.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fssafe-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// What Node throws on a full Proxmox LXC (ZFS refquota): errno -122 without a name.
function edquot(p) {
  return Object.assign(new Error(`Unknown system error -122: Unknown system error -122, write`), {
    errno: -122, code: 'Unknown system error -122', syscall: 'write', path: p,
  });
}

test('writeFileAtomic writes and replaces a file and leaves no temp files', () => {
  const fp = path.join(root, 'a.json');
  writeFileAtomic(fp, '{"v":1}');
  writeFileAtomic(fp, '{"v":2}');
  assert.equal(fs.readFileSync(fp, 'utf8'), '{"v":2}');
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes('.tmp-')), []);
});

test('a write that fails half-way (disk full) leaves the old file exactly as it was', () => {
  const fp = path.join(root, 'session.json');
  const old = JSON.stringify({ status: 'open', timeline: [1, 2, 3] }, null, 2);
  fs.writeFileSync(fp, old);
  const orig = fs.writeFileSync;
  // Like 2026-11-04: the first bytes land, then EDQUOT.
  fs.writeFileSync = (p, data) => { orig(p, String(data).slice(0, 10)); throw edquot(p); };
  try {
    assert.throws(() => writeFileAtomic(fp, JSON.stringify({ status: 'finalizing', timeline: [1, 2, 3, 4] })), (e) => e.errno === -122);
  } finally {
    fs.writeFileSync = orig;
  }
  assert.equal(fs.readFileSync(fp, 'utf8'), old, 'old content intact (plain writeFileSync left it truncated)');
  assert.deepEqual(JSON.parse(fs.readFileSync(fp, 'utf8')).status, 'open');
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes('.tmp-')), [], 'temp file removed');
});

test('isDiskFullError recognises ENOSPC, EDQUOT and Node\'s nameless -122', () => {
  assert.equal(isDiskFullError(edquot('/x')), true);
  assert.equal(isDiskFullError(Object.assign(new Error('no space'), { code: 'ENOSPC', errno: -28 })), true);
  assert.equal(isDiskFullError(Object.assign(new Error('quota'), { code: 'EDQUOT' })), true);
  assert.equal(isDiskFullError(new Error('Unknown system error -122: Unknown system error -122, write')), true, 'message only (e.g. relayed)');
  assert.equal(isDiskFullError(Object.assign(new Error('gone'), { code: 'ENOENT', errno: -2 })), false);
  assert.equal(isDiskFullError(new Error('Server nicht erreichbar')), false);
  assert.equal(isDiskFullError(null), false);
});

test('describeError turns a full disk into a readable German message, other errors pass through', () => {
  const t = describeError(edquot('/tmp/voice-sessions/x/session.json'));
  assert.match(t, /Speicher auf dem Bot-Host voll/);
  assert.match(t, /session\.json/);
  assert.doesNotMatch(t, /-122/);
  assert.equal(describeError(new Error('Server nicht erreichbar.')), 'Server nicht erreichbar.');
  assert.equal(describeError('plain'), 'plain');
});
