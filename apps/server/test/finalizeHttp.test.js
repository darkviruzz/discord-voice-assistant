import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { registerFinalizeHttpRoutes } from '../src/finalizeHttp.js';

const BEARER = 'test-bearer-abc123';
const SID = '1700000000000';

let server, port, uploadRoot;

before(async () => {
  uploadRoot = mkdtempSync(join(tmpdir(), 'finalize-http-'));
  process.env.FINALIZE_UPLOAD_DIR = uploadRoot;
  process.env.CONTROL_BEARER = BEARER;
  const app = express();
  // Mirror production index.js: the global json parser only fires on
  // application/json, so it must not touch our octet-stream upload bodies.
  app.use(express.json({ limit: '32kb' }));
  registerFinalizeHttpRoutes(app);
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
});

after(() => {
  server?.close();
  rmSync(uploadRoot, { recursive: true, force: true });
  delete process.env.FINALIZE_UPLOAD_DIR;
  delete process.env.CONTROL_BEARER;
});

function url(p) { return `http://127.0.0.1:${port}${p}`; }

// Raw PUT with a verbatim path (no URL re-encoding / dot-segment normalization)
// and caller-controlled framing. Omitting a Content-Length header makes Node
// use chunked transfer-encoding (used for the 411 case). Returns {status, body}.
function putRaw({ path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'PUT', headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    const t = setTimeout(() => { req.destroy(); reject(new Error('putRaw timeout')); }, 4000);
    t.unref?.();
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// PUT that flushes only the headers (no body) and reports the first response —
// for a Content-Length the server must reject on the header alone, before any
// body is read. Tears the request down once the status arrives.
function putHeadersOnly({ path, headers }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'PUT', headers });
    const t = setTimeout(() => { req.destroy(); reject(new Error('putHeadersOnly timeout')); }, 4000);
    t.unref?.();
    req.on('response', (res) => { res.resume(); clearTimeout(t); resolve(res.statusCode); req.destroy(); });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') { clearTimeout(t); reject(e); } });
    req.flushHeaders();
  });
}

const auth = (b = BEARER) => ({ Authorization: `Bearer ${b}` });

test('valid PUT stores the body byte-for-byte and returns {ok,bytes}', async () => {
  // Binary payload with NULs / high bytes / CR-LF to catch any text mangling.
  const wav = Buffer.concat([Buffer.from('RIFF\x00\x01\x02\xff\xfe\r\n'), crypto.randomBytes(4096)]);
  const name = `111_${SID}.wav`;
  const res = await fetch(url(`/finalize/upload/${SID}/${encodeURIComponent(name)}`), {
    method: 'PUT',
    headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
    body: wav,
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.bytes, wav.length);

  const dest = join(uploadRoot, SID, name);
  assert.ok(existsSync(dest), 'file written to <root>/<sessionId>/<filename>');
  assert.equal(Buffer.compare(readFileSync(dest), wav), 0, 'stored bytes identical to sent bytes');

  // A non-.wav basename (manifest.json) is equally accepted.
  const manifest = Buffer.from(JSON.stringify({ sessionId: SID, utterances: [] }));
  const mRes = await fetch(url(`/finalize/upload/${SID}/${encodeURIComponent('manifest.json')}`), {
    method: 'PUT',
    headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
    body: manifest,
  });
  assert.equal(mRes.status, 200);
  assert.equal(Buffer.compare(readFileSync(join(uploadRoot, SID, 'manifest.json')), manifest), 0);
});

test('missing bearer → 401', async () => {
  const res = await fetch(url(`/finalize/upload/${SID}/x.wav`), {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('x'),
  });
  assert.equal(res.status, 401);
  assert.equal(existsSync(join(uploadRoot, SID, 'x.wav')), false);
});

test('wrong bearer → 401', async () => {
  const res = await fetch(url(`/finalize/upload/${SID}/x.wav`), {
    method: 'PUT', headers: { ...auth('nope'), 'Content-Type': 'application/octet-stream' }, body: Buffer.from('x'),
  });
  assert.equal(res.status, 401);
  assert.equal(existsSync(join(uploadRoot, SID, 'x.wav')), false);
});

test('non-numeric sessionId → 400', async () => {
  const { status } = await putRaw({ path: '/finalize/upload/not-a-number/x.wav', headers: auth(), body: Buffer.from('x') });
  assert.equal(status, 400);
});

test('filename ".." (percent-encoded) → 400, nothing written', async () => {
  const { status, body } = await putRaw({ path: `/finalize/upload/${SID}/%2E%2E`, headers: auth(), body: Buffer.from('x') });
  assert.equal(status, 400);
  assert.match(body, /bad filename/);
});

test('filename with an encoded path separator → 400, no file escapes the root', async () => {
  // Decodes to `../../escape.wav`; the validator rejects any separator / traversal.
  const { status } = await putRaw({ path: `/finalize/upload/${SID}/..%2F..%2Fescape.wav`, headers: auth(), body: Buffer.from('x') });
  assert.equal(status, 400);
  assert.equal(existsSync(join(uploadRoot, 'escape.wav')), false, 'no file one level up');
  assert.equal(existsSync(join(uploadRoot, SID, 'escape.wav')), false, 'no file inside session dir');
});

test('missing Content-Length (chunked) → 411', async () => {
  // No Content-Length header → Node streams chunked → the server cannot bound it.
  const { status } = await putRaw({
    path: `/finalize/upload/${SID}/chunky.wav`,
    headers: { ...auth(), 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('some-bytes'),
  });
  assert.equal(status, 411);
  assert.equal(existsSync(join(uploadRoot, SID, 'chunky.wav')), false);
});

test('Content-Length over the 200MB cap → 413', async () => {
  const status = await putHeadersOnly({
    path: `/finalize/upload/${SID}/huge.wav`,
    headers: { ...auth(), 'Content-Type': 'application/octet-stream', 'Content-Length': String(300 * 1024 * 1024) },
  });
  assert.equal(status, 413);
  assert.equal(existsSync(join(uploadRoot, SID, 'huge.wav')), false);
});
