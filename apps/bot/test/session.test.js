import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// session.js freezes DATA_DIR and SESSION_IDLE_HOURS at import time, so the env
// must point at a scratch dir BEFORE the module is loaded.
let root;
let SessionManager;
let SessionStatus;
const HOUR = 3600_000;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-session-'));
  process.env.DATA_DIR = root;
  process.env.SESSION_IDLE_HOURS = '4';
  ({ SessionManager, SessionStatus } = await import('../src/session.js'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.SESSION_IDLE_HOURS;
});

beforeEach(() => {
  for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
});

// Persist a session.json the way SessionManager does. `dir` deliberately points
// somewhere else: a relocated data root must still resolve from DATA_DIR.
function seed(id, fields = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const s = {
    id,
    dir: `/old/data/root/${id}`,
    startedAt: Date.now() - HOUR,
    lastActivity: Date.now() - HOUR,
    status: 'open',
    timeline: [],
    ...fields,
  };
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(s));
  return s;
}

function onDisk(id) {
  return JSON.parse(fs.readFileSync(path.join(root, id, 'session.json'), 'utf8'));
}

test('startNew persists an open session whose wire id is its startedAt', () => {
  const sm = new SessionManager();
  const s = sm.startNew();
  assert.equal(s.status, SessionStatus.OPEN);
  assert.equal(s.dir, path.join(root, s.id));
  assert.match(s.id, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/, 'filesystem-safe ISO id');
  assert.deepEqual(onDisk(s.id), JSON.parse(JSON.stringify(s)));
  assert.equal(sm.wireSessionId(), String(s.startedAt));
});

test('wireSessionId is null without an active session', () => {
  assert.equal(new SessionManager().wireSessionId(), null);
});

test('addUtterance appends to the timeline and persists it across a reload', () => {
  const sm = new SessionManager();
  const s = sm.startNew();
  const u = { userId: '111', username: 'Hauke', startMs: 1200, durationMs: 800, file: '/x/111_1.wav' };
  sm.addUtterance(u);
  const reloaded = SessionManager.loadById(s.id);
  assert.deepEqual(reloaded.timeline, [u]);
  assert.ok(reloaded.lastActivity >= s.startedAt);
});

test('resumeOrStart re-attaches the most recently active open session within the idle window', () => {
  seed('A-open-1h', { lastActivity: Date.now() - 1 * HOUR });
  const best = seed('B-open-10m', { lastActivity: Date.now() - 10 * 60_000 });
  seed('C-finalized-1m', { lastActivity: Date.now() - 60_000, status: 'finalized' });
  seed('D-open-stale', { lastActivity: Date.now() - 5 * HOUR });
  fs.mkdirSync(path.join(root, 'E-corrupt'));
  fs.writeFileSync(path.join(root, 'E-corrupt', 'session.json'), '{not json');

  const before = Date.now();
  const { session, resumed } = new SessionManager().resumeOrStart();
  assert.equal(resumed, true);
  assert.equal(session.id, best.id, 'newest open session inside the window wins; finalized/stale ignored');
  assert.equal(session.dir, path.join(root, best.id), 'dir recomputed from DATA_DIR, not the stale stored one');
  assert.ok(session.lastActivity >= before, 'touch() on resume');
  assert.equal(onDisk(best.id).lastActivity, session.lastActivity, 'touch persisted');
});

test('resumeOrStart starts a fresh session when only stale or finalized sessions exist', () => {
  seed('old-open', { lastActivity: Date.now() - 5 * HOUR });
  seed('done', { lastActivity: Date.now(), status: 'finalized' });
  const { session, resumed } = new SessionManager().resumeOrStart();
  assert.equal(resumed, false);
  assert.notEqual(session.id, 'old-open');
  assert.notEqual(session.id, 'done');
  assert.equal(session.status, SessionStatus.OPEN);
  assert.equal(onDisk('done').status, 'finalized', 'finalized session left untouched');
});

test('resumeOrStart keeps the in-memory session while open, but never resumes a finalized one', () => {
  const sm = new SessionManager();
  const s = sm.startNew();
  assert.equal(sm.resumeOrStart().session, s, 'same object while open');

  sm.markFinalized();
  // Session ids are millisecond timestamps: make sure the follow-up session
  // can't land in the same millisecond (and thus the same directory).
  const t0 = Date.now();
  while (Date.now() === t0) { /* spin ≤1 ms */ }
  const { session, resumed } = sm.resumeOrStart();
  assert.equal(resumed, false);
  assert.equal(session.status, SessionStatus.OPEN);
  assert.equal(onDisk(s.id).status, SessionStatus.FINALIZED);
});

test('markFinalizing / markFinalized persist the lifecycle on disk', () => {
  const sm = new SessionManager();
  const s = sm.startNew();
  sm.markFinalizing();
  assert.equal(onDisk(s.id).status, 'finalizing');
  sm.markFinalized();
  const d = onDisk(s.id);
  assert.equal(d.status, 'finalized');
  assert.equal(typeof d.finalizedAt, 'number');
});

test('tryAutoFinalizeOld returns only OPEN sessions past the idle window', () => {
  seed('fresh-open', { lastActivity: Date.now() - 1 * HOUR });
  seed('stale-open', { lastActivity: Date.now() - 5 * HOUR });
  seed('stale-finalized', { lastActivity: Date.now() - 50 * HOUR, status: 'finalized' });
  seed('stale-finalizing', { lastActivity: Date.now() - 50 * HOUR, status: 'finalizing' });
  const ids = SessionManager.tryAutoFinalizeOld().map((s) => s.id);
  assert.deepEqual(ids, ['stale-open']);
});

test('listAll lists sessions newest-first and skips _archived and unreadable dirs', () => {
  seed('s1', { startedAt: 1000, timeline: [{}, {}] });
  seed('s3', { startedAt: 3000, status: 'finalized', finalize: { userCount: 2 } });
  seed('s2', { startedAt: 2000, timeline: undefined });
  // A retention-moved session under _archived must never be listed.
  fs.mkdirSync(path.join(root, '_archived', 's0'), { recursive: true });
  fs.writeFileSync(path.join(root, '_archived', 'session.json'), JSON.stringify({ id: '_archived', startedAt: 9999 }));
  fs.mkdirSync(path.join(root, 'broken'));

  const list = SessionManager.listAll();
  assert.deepEqual(list.map((s) => s.id), ['s3', 's2', 's1']);
  assert.equal(list.find((s) => s.id === 's1').utterances, 2);
  assert.equal(list.find((s) => s.id === 's2').utterances, 0);
  assert.deepEqual(list.find((s) => s.id === 's3').finalize, { userCount: 2 });
});

test('findByWireId resolves a server-side numeric id back to the local session', () => {
  seed('2023-11-14T22-13-20-000Z', { startedAt: 1_700_000_000_000, timeline: undefined });
  seed('other', { startedAt: 1_700_000_999_000 });
  for (const wire of ['1700000000000', 1_700_000_000_000]) {
    const s = SessionManager.findByWireId(wire);
    assert.equal(s.id, '2023-11-14T22-13-20-000Z');
    assert.equal(s.dir, path.join(root, s.id));
    assert.deepEqual(s.timeline, [], 'missing timeline normalized to []');
  }
  assert.equal(SessionManager.findByWireId('42'), null);
});

test('loadById returns null for unknown or corrupt sessions; save() ignores dir-less objects', () => {
  assert.equal(SessionManager.loadById('nope'), null);
  fs.mkdirSync(path.join(root, 'bad'));
  fs.writeFileSync(path.join(root, 'bad', 'session.json'), '');
  assert.equal(SessionManager.loadById('bad'), null);
  assert.doesNotThrow(() => SessionManager.save({ id: 'x' }));
  assert.doesNotThrow(() => SessionManager.save(null));
});
