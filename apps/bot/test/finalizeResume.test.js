import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ControlClient } from '../src/transport/control.js';
import { TransportState, State } from '../src/transport/state.js';

// End to end: the bot's ControlClient against the REAL server control socket
// (apps/server/src/control.js) running a real finalize, with the control link
// dropped in the middle of the re-STT. A fake whisper server holds the STT
// request until the test releases it, so "mid-finalize" is deterministic.
// Before the fix the bot's finalize promise hung until its 30 min timeout and
// the result went to the dead socket.

const FAST = { backoffBaseMs: 10, backoffCapMs: 40, handshakeTimeoutMs: 2000, connectTimeoutMs: 2000 };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-resume-'));
const dirs = {
  upload: path.join(tmp, 'uploads'),
  archive: path.join(tmp, 'archive'),
  transcripts: path.join(tmp, 'transcripts'),
  data: path.join(tmp, 'data'),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, { timeoutMs = 5000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await sleep(stepMs);
  }
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// 48 kHz mono 16-bit PCM WAV (what the bot records), a 0.6 s tone.
function makeWav() {
  const sr = 48000;
  const n = Math.round(sr * 0.6);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / sr)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// What the bot's upload leaves on the server: <upload>/<sessionId>/{manifest.json, *.wav}.
function stageUpload(sessionId) {
  const dir = path.join(dirs.upload, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const wav = makeWav();
  fs.writeFileSync(path.join(dir, 'u1.wav'), wav);
  const manifest = {
    sessionId,
    sessionName: `resume-${sessionId}`,
    sessionStartMs: Number(sessionId),
    utterances: [{
      userId: '111', username: 'Hauke', file: 'u1.wav', startMs: 0, durationMs: 600,
      sha256: crypto.createHash('sha256').update(wav).digest('hex'),
    }],
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

let whisper, server, botConnections;
const stt = { calls: 0, started: null, release: null };

before(async () => {
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

  // Fake whisper.cpp: every /inference request waits for the test's go.
  whisper = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      stt.calls++;
      stt.started?.resolve();
      await stt.release?.promise;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'Die Tür öffnet sich.', segments: [] }));
    });
  });
  await new Promise((r) => whisper.listen(0, '127.0.0.1', r));

  Object.assign(process.env, {
    FINALIZE_UPLOAD_DIR: dirs.upload,
    ARCHIVE_DIR: dirs.archive,
    TRANSCRIPT_DIR: dirs.transcripts,
    DATA_DIR: dirs.data,        // no stray config/speaker-map files from the cwd
    WHISPER_URL: `http://127.0.0.1:${whisper.address().port}`,
  });

  const { initControlWSS } = await import('../../server/src/control.js');
  ({ botConnections } = await import('../../server/src/broadcast.js'));
  const wss = initControlWSS({ bearer: null });
  server = http.createServer();
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.wss = wss;
});

after(async () => {
  for (const ws of server.wss.clients) { try { ws.terminate(); } catch {} }
  await new Promise((r) => server.wss.close(() => r()));
  await new Promise((r) => server.close(() => r()));
  await new Promise((r) => whisper.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function connectBot(timing = FAST) {
  const fsm = new TransportState();
  const client = new ControlClient({ baseUrl: `ws://127.0.0.1:${server.address().port}`, botId: 'e2e-bot', fsm, timing });
  client.start();
  return { client, fsm };
}

test('link drops mid-finalize → bot re-sends, server joins the running finalize, result reaches the new socket', async () => {
  const sessionId = '1700000000001';
  const uploadDir = stageUpload(sessionId);
  stt.calls = 0;
  stt.started = deferred();
  stt.release = deferred();

  const { client, fsm } = connectBot();
  try {
    await waitFor(() => fsm.is(State.READY));
    const joined = new Promise((r) => client.on('finalizeProgress', (m) => { if (m.phase === 'joined') r(m); }));

    const finalizing = client.finalizeSession({ sessionId, sessionName: `resume-${sessionId}` }, { timeoutMs: 15_000 });
    await stt.started.promise;          // server is in the re-STT now
    client.ws.terminate();              // network blip: control link lost mid-finalize

    await joined;                       // reconnected + re-sent; server attached it to the run
    stt.release.resolve();              // let the re-STT finish

    const result = await finalizing;
    assert.equal(result.ok, true, result.error);
    assert.equal(result.sessionId, sessionId);
    assert.ok(fs.existsSync(result.transcriptPath), 'transcript written');
    assert.match(fs.readFileSync(result.transcriptPath, 'utf8'), /Die Tür öffnet sich/);
    assert.equal(stt.calls, 1, 'one finalize run — the re-send did not start a second re-STT');
    assert.equal(fs.existsSync(uploadDir), false, 'upload dir cleaned up once, by the single run');
  } finally {
    client.stop();
  }
});

test('finalize completes while the bot is disconnected → the re-send is answered from the result cache', async () => {
  const sessionId = '1700000000002';
  stageUpload(sessionId);
  stt.calls = 0;
  stt.started = deferred();
  stt.release = deferred();

  // Slow reconnect so the run completes while the bot is still away.
  const { client, fsm } = connectBot({ ...FAST, backoffBaseMs: 300, backoffCapMs: 300 });
  try {
    await waitFor(() => fsm.is(State.READY));
    const finalizing = client.finalizeSession({ sessionId, sessionName: `resume-${sessionId}` }, { timeoutMs: 15_000 });
    await stt.started.promise;
    client.ws.terminate();
    await waitFor(() => botConnections.size === 0); // server noticed the drop
    stt.release.resolve();                          // run finishes with nobody connected

    const result = await finalizing;                // bot reconnects, re-sends → cache
    assert.equal(result.ok, true, result.error);
    assert.ok(fs.existsSync(result.transcriptPath));
    assert.equal(stt.calls, 1, 'answered from cache, no second run (the upload dir is gone by now)');
  } finally {
    client.stop();
  }
});
