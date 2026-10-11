import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import {
  buildManifest, applyRetention, chunksDir, sourceChunksDir, writeManifest, uploadSession,
} from '../src/finalize.js';
// The upload is exercised against the REAL server route (C1), like archivePuller.test.js.
import { registerFinalizeHttpRoutes } from '../../server/src/finalizeHttp.js';

const roots = [];
function scratch(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
}

function makeSession() {
  // Mirror production layout: <DATA_DIR>/<id>/chunks so _archived lands under
  // the per-test root, not the shared tmp dir.
  const root = scratch('bot-finalize-');
  const startedAt = 1_700_000_000_000;
  const id = '2023-11-14T22-13-20-000Z';
  const dir = path.join(root, id);
  const chunks = path.join(dir, 'chunks');
  fs.mkdirSync(chunks, { recursive: true });
  const fileA = path.join(chunks, `111_${startedAt}.wav`);
  const fileB = path.join(chunks, `222_${startedAt + 3000}.wav`);
  fs.writeFileSync(fileA, Buffer.from('AUDIO-A'));
  fs.writeFileSync(fileB, Buffer.from('AUDIO-B'));
  return {
    id,
    dir,
    startedAt,
    status: 'open',
    timeline: [
      { userId: '111', username: 'Hauke', startMs: 0, durationMs: 2000, file: fileA },
      { userId: '222', username: 'Greta', startMs: 3000, durationMs: 1000, file: fileB },
    ],
  };
}

const UPLOAD_ENV = ['FINALIZE_UPLOAD_CMD', 'SERVER_BASE_URL', 'CONTROL_WS_URL', 'CONTROL_BEARER', 'FINALIZE_UPLOAD_DIR'];
const savedEnv = Object.fromEntries(UPLOAD_ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of UPLOAD_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});
after(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true }); });

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('buildManifest produces basenames, checksums and bot-clock timing', () => {
  const session = makeSession();
  const m = buildManifest(session, { channelName: 'Spieltisch', wakeWord: 'Rabenauge' });
  assert.equal(m.sessionId, '1700000000000');
  assert.equal(m.sessionName, session.id, 'human-readable id drives the server archive dir name');
  assert.equal(m.sessionStartMs, session.startedAt);
  assert.equal(m.channelName, 'Spieltisch');
  assert.equal(m.guildName, null);
  assert.equal(m.utterances.length, 2);

  const [a, b] = m.utterances;
  assert.equal(a.file, `111_${session.startedAt}.wav`); // basename only
  assert.equal(a.startMs, 0);
  assert.equal(a.sha256, sha(Buffer.from('AUDIO-A')));
  assert.equal(a.bytes, 7);
  assert.deepEqual([b.userId, b.username, b.startMs, b.durationMs], ['222', 'Greta', 3000, 1000]);
});

test('buildManifest skips timeline entries without a file or whose WAV is gone', () => {
  const session = makeSession();
  fs.rmSync(session.timeline[1].file);
  session.timeline.push({ userId: '333', username: 'Ohne', startMs: 5000, durationMs: 100 });
  const m = buildManifest(session);
  assert.deepEqual(m.utterances.map((u) => u.userId), ['111']);
});

test('applyRetention move relocates the WAVs, bytes intact, out of the session dir', () => {
  const session = makeSession();
  const res = applyRetention(session, { policy: 'move' });
  assert.deepEqual(res, { policy: 'move', done: true });
  assert.equal(fs.existsSync(chunksDir(session)), false);
  const moved = path.join(path.dirname(session.dir), '_archived', session.id, 'chunks');
  assert.equal(fs.readFileSync(path.join(moved, `111_${session.startedAt}.wav`), 'utf8'), 'AUDIO-A');
  assert.equal(fs.readFileSync(path.join(moved, `222_${session.startedAt + 3000}.wav`), 'utf8'), 'AUDIO-B');
});

test('applyRetention delete removes WAVs', () => {
  const session = makeSession();
  const res = applyRetention(session, { policy: 'delete' });
  assert.equal(res.policy, 'delete');
  assert.equal(fs.existsSync(chunksDir(session)), false);
  assert.equal(fs.existsSync(path.join(path.dirname(session.dir), '_archived')), false, 'delete never archives');
});

test('applyRetention is a no-op once the live chunks are gone (archived WAVs untouched)', () => {
  const session = makeSession();
  applyRetention(session, { policy: 'move' });
  const res = applyRetention(session, { policy: 'delete' });
  assert.equal(res.noop, true);
  assert.ok(fs.existsSync(path.join(sourceChunksDir(session), `111_${session.startedAt}.wav`)), 'archived copy survives');
});

test('re-finalize resolves WAVs from _archived after a retention move', () => {
  const session = makeSession();
  applyRetention(session, { policy: 'move' });
  assert.equal(fs.existsSync(chunksDir(session)), false, 'live chunks moved away');
  assert.ok(sourceChunksDir(session).includes('_archived'), 'source resolves to archive');
  const m = buildManifest(session, {});
  assert.equal(m.utterances.length, 2, 'manifest rebuilt from archived WAVs');
});

test('writeManifest writes manifest.json next to the WAVs it describes', () => {
  const session = makeSession();
  const m = buildManifest(session);
  const fp = writeManifest(session, m);
  assert.equal(fp, path.join(chunksDir(session), 'manifest.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(fp, 'utf8')), m);
});

// ── uploadSession ─────────────────────────────────────────────────────────────

let server;
let uploadRoot;
const BEARER = 'upload-bearer-123';
before(async () => {
  uploadRoot = scratch('bot-upload-srv-');
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  registerFinalizeHttpRoutes(app, { bearer: BEARER });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
});
after(() => server?.close());
const baseUrl = () => `ws://127.0.0.1:${server.address().port}`; // ws:// as documented; rewritten to http://

test('uploadSession (HTTP) PUTs every WAV + manifest.json byte-identically to the server route', async () => {
  process.env.FINALIZE_UPLOAD_DIR = uploadRoot;
  process.env.SERVER_BASE_URL = baseUrl();
  process.env.CONTROL_BEARER = BEARER;
  const session = makeSession();
  // A big-ish binary WAV to exercise the streamed body, and a non-upload file.
  const big = crypto.randomBytes(256 * 1024);
  fs.writeFileSync(session.timeline[0].file, big);
  fs.writeFileSync(path.join(chunksDir(session), 'notes.txt'), 'not uploaded');
  writeManifest(session, buildManifest(session));

  const r = await uploadSession(session);
  assert.equal(r.method, 'http');
  assert.equal(r.uploaded, true);
  assert.equal(r.files, 3, '2 WAVs + manifest.json');

  const dest = path.join(uploadRoot, String(session.startedAt));
  assert.deepEqual(fs.readdirSync(dest).sort(), ['111_1700000000000.wav', '222_1700000003000.wav', 'manifest.json']);
  for (const name of fs.readdirSync(dest)) {
    assert.equal(sha(fs.readFileSync(path.join(dest, name))), sha(fs.readFileSync(path.join(chunksDir(session), name))), name);
  }
  assert.equal(r.bytes, big.length + 7 + fs.statSync(path.join(dest, 'manifest.json')).size);
});

test('uploadSession (HTTP) rejects with the HTTP status when the server refuses (wrong bearer)', async () => {
  process.env.FINALIZE_UPLOAD_DIR = uploadRoot;
  process.env.SERVER_BASE_URL = baseUrl();
  process.env.CONTROL_BEARER = 'wrong';
  await assert.rejects(() => uploadSession(makeSession()), /HTTP 401/);
});

test('uploadSession falls back to CONTROL_WS_URL when SERVER_BASE_URL is unset', async () => {
  process.env.FINALIZE_UPLOAD_DIR = uploadRoot;
  delete process.env.SERVER_BASE_URL;
  process.env.CONTROL_WS_URL = `${baseUrl()}/control`;
  process.env.CONTROL_BEARER = BEARER;
  const r = await uploadSession(makeSession());
  assert.equal(r.method, 'http');
  assert.equal(r.files, 2);
});

test('uploadSession skips (no throw) without upload command and server URL', async () => {
  delete process.env.SERVER_BASE_URL;
  delete process.env.CONTROL_WS_URL;
  delete process.env.FINALIZE_UPLOAD_CMD;
  assert.deepEqual(await uploadSession(makeSession()), { uploaded: false, skipped: true });
});

test('uploadSession runs FINALIZE_UPLOAD_CMD with {src} and {sessionId} substituted (takes priority over HTTP)', async () => {
  process.env.SERVER_BASE_URL = baseUrl();
  const out = path.join(scratch('bot-upload-cmd-'), 'args.txt');
  process.env.FINALIZE_UPLOAD_CMD = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(process.argv[1], process.argv.slice(2).join('|'))" ${JSON.stringify(out)} "{src}" {sessionId}`;
  const session = makeSession();
  const r = await uploadSession(session);
  assert.deepEqual(r, { uploaded: true, skipped: false, method: 'cmd' });
  assert.equal(fs.readFileSync(out, 'utf8'), `${chunksDir(session)}|1700000000000`);
});

test('uploadSession propagates a failing upload command (WAVs must be kept for a retry)', async () => {
  process.env.FINALIZE_UPLOAD_CMD = `${JSON.stringify(process.execPath)} -e "console.error('scp: connection refused'); process.exit(7)"`;
  await assert.rejects(() => uploadSession(makeSession()), /exited 7: scp: connection refused/);
});
