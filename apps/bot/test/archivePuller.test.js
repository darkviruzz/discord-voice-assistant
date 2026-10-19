import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The finished archive is served by the REAL server routes (C2/C3), and the bot
// pulls it back over plain HTTP. This exercises both ends against each other.
import { registerFinalizeHttpRoutes } from '../../server/src/finalizeHttp.js';

const BEARER = 'bot-pull-bearer-xyz';
const ARCHIVE_NAME = 'pullsession-2026-07-10';
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let server, port, serverArchiveRoot, botRoot, botArchiveDir;
let pullArchive; // dynamically imported after BOT_ARCHIVE_DIR is set (captured at module load)
const files = {}; // relPath → bytes

before(async () => {
  serverArchiveRoot = mkdtempSync(join(tmpdir(), 'pull-srv-archive-'));
  process.env.ARCHIVE_DIR = serverArchiveRoot;
  process.env.CONTROL_BEARER = BEARER;
  const aDir = join(serverArchiveRoot, ARCHIVE_NAME);
  mkdirSync(join(aDir, 'audio'), { recursive: true });
  const put = (rel, buf) => { files[rel] = buf; writeFileSync(join(aDir, ...rel.split('/')), buf); };
  put('transcript.md', Buffer.from('# Transkript\nDie Party betritt die Höhle.\n'));
  put('manifest.json', Buffer.from(JSON.stringify({ sessionId: '1700000000000', utterances: [] })));
  put('speaker-map.json', Buffer.from(JSON.stringify({ '111': { label: 'Hauke' } })));
  put('session.jsonl', Buffer.from('{"type":"session_meta"}\n{"type":"stt_final"}\n'));
  put('audio/111_a.ogg', Buffer.concat([Buffer.from('OggS\x00\xff'), crypto.randomBytes(4096)]));
  put('audio/222_b.ogg', Buffer.concat([Buffer.from('OggS\x00\xff'), crypto.randomBytes(2048)]));

  // Bot destination — set BEFORE importing archivePuller so its module-level
  // DIR const (mirrors transcriptWriter.js) captures the test dir, not ~/archive.
  // Nested one level down so an escape to the parent dir is observable.
  botRoot = mkdtempSync(join(tmpdir(), 'pull-bot-'));
  botArchiveDir = join(botRoot, 'archive');
  process.env.BOT_ARCHIVE_DIR = botArchiveDir;
  process.env.BOT_ARCHIVE_RETENTION_DAYS = '60';
  delete process.env.CONTROL_WS_URL; // keep httpBaseUrl() driven purely by SERVER_BASE_URL

  const app = express();
  app.use(express.json({ limit: '32kb' }));
  registerFinalizeHttpRoutes(app);
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  process.env.SERVER_BASE_URL = `http://127.0.0.1:${port}`;

  ({ pullArchive } = await import('../src/archivePuller.js'));
});

after(() => {
  server?.close();
  rmSync(serverArchiveRoot, { recursive: true, force: true });
  rmSync(botRoot, { recursive: true, force: true });
  delete process.env.ARCHIVE_DIR;
  delete process.env.CONTROL_BEARER;
  delete process.env.BOT_ARCHIVE_DIR;
  delete process.env.BOT_ARCHIVE_RETENTION_DAYS;
  delete process.env.SERVER_BASE_URL;
});

test('pullArchive downloads every file byte-identically into BOT_ARCHIVE_DIR/<name>', async () => {
  const r = await pullArchive({ archiveName: ARCHIVE_NAME });
  assert.equal(r.ok, true);
  assert.equal(r.failed.length, 0);
  assert.equal(r.files, Object.keys(files).length);
  for (const [rel, buf] of Object.entries(files)) {
    const dest = join(botArchiveDir, ARCHIVE_NAME, ...rel.split('/'));
    assert.ok(existsSync(dest), `pulled ${rel}`);
    assert.equal(Buffer.compare(readFileSync(dest), buf), 0, `bytes identical for ${rel}`);
    assert.equal(sha256(readFileSync(dest)), sha256(buf), `sha256 identical for ${rel}`);
  }
});

test('pullArchive with no SERVER_BASE_URL → {skipped:true} (no throw)', async () => {
  const saved = process.env.SERVER_BASE_URL;
  delete process.env.SERVER_BASE_URL;
  try {
    const r = await pullArchive({ archiveName: ARCHIVE_NAME });
    assert.deepEqual(r, { skipped: true });
  } finally {
    process.env.SERVER_BASE_URL = saved;
  }
});

test('pullArchive throws only on a total failure (manifest unreachable → unknown archive)', async () => {
  // A 404 manifest (unknown archive) is a total failure → throw.
  await assert.rejects(() => pullArchive({ archiveName: 'no-such-archive' }), /manifest fetch failed: HTTP 404/);
});

test('a sha256-mismatched file lands in failed[] and its partial is deleted; good files still land', async () => {
  // Adversarial server: reports a wrong sha for one file but serves real bytes,
  // so the bot's per-file verification must catch and quarantine only that file.
  const good = {
    'transcript.md': Buffer.from('gutes Transkript\n'),
    'audio/999_c.ogg': Buffer.concat([Buffer.from('OggS'), crypto.randomBytes(1024)]),
  };
  const tamperRel = 'audio/999_c.ogg';
  const tampered = express();
  tampered.get('/finalize/archive/:n/manifest', (req, res) => {
    res.json({
      archiveName: req.params.n,
      files: Object.entries(good).map(([rel, buf]) => ({
        relPath: rel,
        sha256: rel === tamperRel ? sha256(Buffer.concat([buf, Buffer.from('X')])) : sha256(buf),
        bytes: buf.length,
      })),
    });
  });
  tampered.get('/finalize/archive/:n/file', (req, res) => {
    const buf = good[req.query.path];
    if (!buf) return res.status(404).end();
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  });
  let tsrv;
  await new Promise((r) => { tsrv = tampered.listen(0, '127.0.0.1', r); });
  const savedBase = process.env.SERVER_BASE_URL;
  process.env.SERVER_BASE_URL = `http://127.0.0.1:${tsrv.address().port}`;
  const TNAME = 'tampered-2026-07-10';
  try {
    const r = await pullArchive({ archiveName: TNAME });
    assert.equal(r.ok, false);
    assert.deepEqual(r.failed, [tamperRel]);
    assert.equal(r.files, 1, 'the one good file counted as ok');
    assert.ok(existsSync(join(botArchiveDir, TNAME, 'transcript.md')), 'good file written');
    assert.equal(existsSync(join(botArchiveDir, TNAME, 'audio', '999_c.ogg')), false, 'corrupt partial removed');
  } finally {
    process.env.SERVER_BASE_URL = savedBase;
    tsrv.close();
  }
});

// Spin up a throwaway HTTP server for the duration of `fn`, pointing
// SERVER_BASE_URL at it.
async function withServer(app, fn) {
  let srv;
  await new Promise((r) => { srv = app.listen(0, '127.0.0.1', r); });
  const savedBase = process.env.SERVER_BASE_URL;
  process.env.SERVER_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  try { return await fn(); } finally {
    process.env.SERVER_BASE_URL = savedBase;
    await new Promise((r) => srv.close(r));
  }
}

test('unsafe relPaths in a hostile manifest are refused: never fetched, never written', async () => {
  const good = Buffer.from('gutes Transkript\n');
  const unsafe = ['../escape.txt', 'audio/../../escape2.txt', '/etc/passwd', 'audio\\..\\x', 'sub/dir/deep.txt', 'other/x.txt', '..'];
  const requested = [];
  const app = express();
  app.get('/finalize/archive/:n/manifest', (req, res) => res.json({
    archiveName: req.params.n,
    files: [
      ...unsafe.map((relPath) => ({ relPath, sha256: sha256(good), bytes: good.length })),
      { relPath: 'transcript.md', sha256: sha256(good), bytes: good.length },
    ],
  }));
  app.get('/finalize/archive/:n/file', (req, res) => { requested.push(req.query.path); res.end(good); });

  const r = await withServer(app, () => pullArchive({ archiveName: 'hostile-2026-07-10' }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, unsafe);
  assert.equal(r.files, 1);
  assert.deepEqual(requested, ['transcript.md'], 'only the safe path is ever requested');
  assert.ok(existsSync(join(botArchiveDir, 'hostile-2026-07-10', 'transcript.md')));
  for (const p of [join(botRoot, 'escape.txt'), join(botRoot, 'escape2.txt'), join(botArchiveDir, 'escape.txt')]) {
    assert.equal(existsSync(p), false, `nothing written at ${p}`);
  }
});

test('an archiveName that is not a single safe directory name is refused before any request', async () => {
  // A permissive (buggy/hostile) server answers everything; the bot must not
  // turn archiveName into a destination outside BOT_ARCHIVE_DIR.
  const payload = Buffer.from('x');
  let hits = 0;
  const app = express();
  app.use((req, res) => {
    hits++;
    if (req.path.endsWith('/manifest')) {
      return res.json({ files: [{ relPath: 'transcript.md', sha256: sha256(payload), bytes: 1 }] });
    }
    res.end(payload);
  });
  await withServer(app, async () => {
    for (const name of ['..', '.', '../escape', 'a/b', 'a\\b', 'bad name']) {
      await assert.rejects(() => pullArchive({ archiveName: name }), /archiveName/, `archiveName=${name}`);
    }
  });
  assert.equal(hits, 0, 'no request made for an unsafe archiveName');
  assert.equal(existsSync(join(botRoot, 'transcript.md')), false, 'nothing written next to BOT_ARCHIVE_DIR');
  assert.equal(existsSync(join(botRoot, 'escape')), false);
});

test('startArchiveCleanup prunes archive dirs past the retention window, keeps recent dirs and loose files', async () => {
  const { startArchiveCleanup } = await import('../src/archivePuller.js');
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (d) => new Date(Date.now() - d * DAY);
  const mk = (name, days) => {
    const d = join(botArchiveDir, name);
    mkdirSync(join(d, 'audio'), { recursive: true });
    writeFileSync(join(d, 'transcript.md'), 'x');
    utimesSync(d, ago(days), ago(days));
    return d;
  };
  const old = mk('old-session', 61);
  const recent = mk('recent-session', 59);
  const looseFile = join(botArchiveDir, 'notes.txt');
  writeFileSync(looseFile, 'keep');
  utimesSync(looseFile, ago(400), ago(400));

  startArchiveCleanup();

  assert.equal(existsSync(old), false, '61-day-old archive pruned');
  assert.ok(existsSync(join(recent, 'transcript.md')), '59-day-old archive kept intact');
  assert.ok(existsSync(looseFile), 'only directories are pruned');
  assert.ok(existsSync(join(botArchiveDir, ARCHIVE_NAME, 'transcript.md')), 'freshly pulled archive kept');
});
