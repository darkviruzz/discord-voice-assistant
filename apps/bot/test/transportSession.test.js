// The bot's transport (transport/index.js) against an in-process fake server:
// after a finalize the session must stop riding on the control link.
// Before, a finalized session stayed the transport's current session — the
// next on-demand link (typically /recap after the finalize) re-sent its
// session_start, the server revived it (2nd session_meta in its JSONL) and the
// typed question was logged into the finalized session.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!pred()) { if (Date.now() > end) throw new Error('waitFor: timed out'); await sleep(10); }
}

const received = []; // control messages from the bot (handshake noise filtered)
let wss;
let transport;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-session-'));
const savedEnv = { SERVER_BASE_URL: process.env.SERVER_BASE_URL, CONTROL_BEARER: process.env.CONTROL_BEARER, DATA_DIR: process.env.DATA_DIR };

before(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (ws, req) => {
    if (!req.url.startsWith('/control')) return; // uplink/downlink: just accept
    ws.send(JSON.stringify({ type: 'hello', serverId: 'fake', version: 'test', protoVersion: 1, t: Date.now() }));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'register') { ws.send(JSON.stringify({ type: 'registered', serverParams: {} })); return; }
      if (['config_state', 'clock_sync', 'ping', 'ack'].includes(msg.type)) return;
      received.push(msg);
    });
  });
  process.env.SERVER_BASE_URL = `ws://127.0.0.1:${wss.address().port}`;
  process.env.CONTROL_BEARER = '';
  process.env.DATA_DIR = tmp;
  transport = await import('../src/transport/index.js');
  transport.start({ botId: 'test-bot', isSessionActive: () => false });
});

after(() => {
  transport?.stop();
  wss?.close();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a finalized session no longer rides on the link: no revival on reconnect, typed questions carry no session', async () => {
  await transport.ensureConnected({ timeoutMs: 3000 });
  transport.sessionStart({ sessionId: '1700000000000', guildId: 'g', channelId: 'c', startedAt: 1700000000000 });
  await waitFor(() => received.some((m) => m.type === 'session_start'));

  // Finalizing some OTHER (older) session by id must not end the live one.
  assert.equal(transport.endSessionIfCurrent('1600000000000'), false);
  // The finalize of the current session ends it on the link.
  assert.equal(transport.endSessionIfCurrent('1700000000000'), true);
  await waitFor(() => received.some((m) => m.type === 'session_end' && m.sessionId === '1700000000000'));

  // Idle release, then an on-demand link for a /recap the next evening.
  received.length = 0;
  transport.disconnect();
  await transport.ensureConnected({ timeoutMs: 3000 });
  transport.textQuery({ question: 'Was war letztes Mal?', channelId: 'c', userId: 'u', source: 'slash' });
  await waitFor(() => received.some((m) => m.type === 'text_query'));
  assert.ok(!received.some((m) => m.type === 'session_start'), 'finalized session re-sent on reconnect');
  const q = received.find((m) => m.type === 'text_query');
  assert.equal(q.sessionId, undefined, 'typed question logged into the finalized session');
});
