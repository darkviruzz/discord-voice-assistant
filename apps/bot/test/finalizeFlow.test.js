import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runFinalizeFlow, withFinalizeLock } from '../src/finalizeFlow.js';

// The status rules of a finalize, with the steps faked. The two regressions
// are the ones from 2026-11-04 (bot host disk full).

function edquot() {
  return Object.assign(new Error('Unknown system error -122: Unknown system error -122, write'), {
    errno: -122, code: 'Unknown system error -122', syscall: 'write',
  });
}

const session = () => ({ id: '2026-11-03T18-19-50-276Z', startedAt: 1793729990279, status: 'open', dir: '/x' });

function makeDeps(over = {}) {
  const calls = { saves: [], upload: 0, finalize: [], pull: 0, retention: [], warns: [] };
  const deps = {
    saveSession: (s) => { calls.saves.push(s.status); },
    buildManifest: () => ({ sessionId: '1793729990279', utterances: [{}, {}] }),
    writeManifest: () => {},
    prepare: async () => {},
    upload: async () => { calls.upload++; },
    finalizeSession: async (p) => {
      calls.finalize.push(p);
      return { ok: true, transcriptPath: 't.md', archiveDir: 'a', userCount: 2, archiveName: 'arch', missing: [], mismatched: [] };
    },
    pullArchive: async () => { calls.pull++; return { ok: true, files: 7, failed: [] }; },
    applyRetention: (_s, o) => { calls.retention.push(o); return { policy: 'move', done: true }; },
    warn: (...a) => calls.warns.push(a.join(' ')),
    now: () => 4242,
    ...over,
  };
  return { deps, calls };
}

test('success: finalized, archive pulled, WAVs retained with the pull result', async () => {
  const { deps, calls } = makeDeps();
  const s = session();
  const out = await runFinalizeFlow(s, {}, deps);
  assert.equal(s.status, 'finalized');
  assert.equal(s.finalizedAt, 4242);
  assert.deepEqual(s.finalize, { transcriptPath: 't.md', archiveDir: 'a', userCount: 2 });
  assert.deepEqual(calls.saves, ['finalizing', 'finalized']);
  assert.deepEqual(calls.retention, [{ pulled: true }]);
  assert.equal(out.fullyVerified, true);
  assert.match(out.retentionNote, /_archived/);
  assert.match(out.retentionNote, /📦 Archiv lokal gesichert \(7 Dateien\)/);
});

test('regression 2026-11-04 (2nd run): the FINALIZING save fails → the in-memory status goes back, no lock-in', async () => {
  let n = 0;
  const { deps, calls } = makeDeps({ saveSession: (st) => { n++; calls.saves.push(st.status); if (n === 1) throw edquot(); } });
  const s = session();
  await assert.rejects(() => runFinalizeFlow(s, {}, deps), (e) => e.errno === -122);
  assert.equal(s.status, 'open', 'not stuck in finalizing (was: "wird bereits finalisiert" forever)');
  assert.equal(calls.upload, 0, 'nothing uploaded');
});

test('a failing step before the server result reverts the status, also on disk', async () => {
  const { deps, calls } = makeDeps({ upload: async () => { throw new Error('finalize upload of x failed: HTTP 500'); } });
  const s = session();
  await assert.rejects(() => runFinalizeFlow(s, {}, deps), /HTTP 500/);
  assert.equal(s.status, 'open');
  assert.deepEqual(calls.saves, ['finalizing', 'open']);
});

test('a failing revert save never hides the original error', async () => {
  let n = 0;
  const { deps, calls } = makeDeps({
    saveSession: () => { n++; if (n === 2) throw edquot(); },
    upload: async () => { throw new Error('upload kaputt'); },
  });
  const s = session();
  await assert.rejects(() => runFinalizeFlow(s, {}, deps), /upload kaputt/);
  assert.equal(s.status, 'open');
  assert.ok(calls.warns.some((w) => /status revert/.test(w) && /Speicher auf dem Bot-Host voll/.test(w)));
});

test('a server result with ok:false reverts and reports the server error', async () => {
  const { deps } = makeDeps({ finalizeSession: async () => ({ ok: false, error: 'STT nicht erreichbar' }) });
  const s = { ...session(), status: 'finalized' }; // re-finalize of a finished session
  await assert.rejects(() => runFinalizeFlow(s, { fromArchive: true }, deps), /STT nicht erreichbar/);
  assert.equal(s.status, 'finalized', 'back to the previous status, whatever it was');
});

test('an empty session is refused and left as it was', async () => {
  const { deps, calls } = makeDeps({ buildManifest: () => ({ sessionId: '1', utterances: [] }) });
  const s = session();
  await assert.rejects(() => runFinalizeFlow(s, {}, deps), /keine aufgenommenen Äußerungen/);
  assert.equal(s.status, 'open');
  assert.equal(calls.upload, 0);
});

test('regression 2026-11-04 (1st run): retention failing after the server finished keeps the session finalized', async () => {
  const { deps, calls } = makeDeps({
    pullArchive: async () => ({ ok: false, diskFull: true, files: 1200, failed: ['a', 'b'] }),
    applyRetention: () => { throw Object.assign(new Error("Unknown system error -122: Unknown system error -122, mkdir '/tmp/voice-sessions/_archived/x'"), { errno: -122, path: '/tmp/voice-sessions/_archived/x' }); },
  });
  const s = session();
  const out = await runFinalizeFlow(s, {}, deps);
  assert.equal(s.status, 'finalized', 'was reverted to open → auto-finalize started over');
  assert.deepEqual(calls.saves, ['finalizing', 'finalized'], 'never saved back to open');
  assert.match(out.retentionNote, /Lokale WAVs konnten nicht aufgeräumt werden/);
  assert.match(out.retentionNote, /Archiv-Pull abgebrochen: Bot-Speicher voll/);
});

test('saving "finalized" failing still reports success, with a note', async () => {
  let n = 0;
  const { deps } = makeDeps({ saveSession: () => { n++; if (n === 2) throw edquot(); } });
  const s = session();
  const out = await runFinalizeFlow(s, {}, deps);
  assert.equal(s.status, 'finalized');
  assert.match(out.retentionNote, /konnte auf dem Bot nicht gespeichert werden/);
});

test('archive that does not fit: pull skipped with a note, WAVs kept (moved, not deleted)', async () => {
  const { deps, calls } = makeDeps({ pullArchive: async () => ({ ok: false, noSpace: { need: 2.1e9, free: 1.2e9 }, files: 0, failed: [] }) });
  const out = await runFinalizeFlow(session(), {}, deps);
  assert.match(out.retentionNote, /Archiv-Pull übersprungen: nur 1,2 GB frei, Archiv braucht 2,1 GB/);
  assert.deepEqual(calls.retention, [{ pulled: false }]);
});

test('a throwing pull is only a note; retention still runs', async () => {
  const { deps, calls } = makeDeps({ pullArchive: async () => { throw new Error('archive manifest fetch failed: HTTP 404'); } });
  const s = session();
  const out = await runFinalizeFlow(s, {}, deps);
  assert.equal(s.status, 'finalized');
  assert.match(out.retentionNote, /Archiv-Pull fehlgeschlagen/);
  assert.deepEqual(calls.retention, [{ pulled: false }]);
});

test('missing uploads: WAVs are kept for a retry (no retention)', async () => {
  const { deps, calls } = makeDeps({
    finalizeSession: async () => ({ ok: true, transcriptPath: 't', archiveDir: 'a', missing: ['x.wav'], mismatched: [] }),
  });
  const out = await runFinalizeFlow(session(), {}, deps);
  assert.equal(out.fullyVerified, false);
  assert.deepEqual(calls.retention, []);
  assert.match(out.retentionNote, /1 fehlende \/ 0 fehlerhafte Uploads/);
});

test('re-finalize from the archive: no upload, no retention', async () => {
  const { deps, calls } = makeDeps();
  const s = { ...session(), status: 'finalized' };
  await runFinalizeFlow(s, { fromArchive: true }, deps);
  assert.equal(calls.upload, 0);
  assert.deepEqual(calls.retention, []);
  assert.deepEqual(calls.finalize, [{ sessionId: '1793729990279', sessionName: s.id }]);
});

test('withFinalizeLock: one finalize per session; the lock is always released', async () => {
  const locks = new Set();
  let release;
  const first = withFinalizeLock(locks, 'S', () => new Promise((r) => { release = r; }));
  await assert.rejects(() => withFinalizeLock(locks, 'S', async () => 'x'), /bereits finalisiert/);
  assert.equal(await withFinalizeLock(locks, 'other', async () => 'ok'), 'ok', 'other sessions are not blocked');
  release('done');
  assert.equal(await first, 'done');
  assert.equal(locks.size, 0);

  await assert.rejects(() => withFinalizeLock(locks, 'S', () => { throw new Error('setup failed'); }), /setup failed/);
  assert.equal(locks.has('S'), false, 'released after a synchronous throw too');
  await assert.rejects(() => withFinalizeLock(locks, 'S', async () => { throw edquot(); }), (e) => e.errno === -122);
  assert.equal(locks.has('S'), false);
});
