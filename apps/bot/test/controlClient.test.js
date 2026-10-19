import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

import { ControlClient } from '../src/transport/control.js';
import { TransportState, State } from '../src/transport/state.js';

// ControlClient against a real in-process ws server that speaks the server's
// handshake (apps/server/src/control.js): hello on connect → register →
// registered. Each test scripts what the fake server does with requests.
// Timings are shrunk via the constructor's `timing` option so reconnects take
// milliseconds instead of seconds.

const FAST = {
  backoffBaseMs: 10,
  backoffCapMs: 40,
  handshakeTimeoutMs: 1000,
  connectTimeoutMs: 1000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await sleep(stepMs);
  }
}

// Fake control server. onRequest(msg, ws, conn) is called for every message
// that is not part of the handshake/housekeeping; conn = 1-based connection no.
// helloDelayMs(conn) delays the handshake of a connection (keeps the client in
// REGISTERING for a while).
async function startFakeServer({ onRequest = () => {}, helloDelayMs = () => 0 } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const state = { connections: 0, requests: [], sockets: [] };
  wss.on('connection', (ws) => {
    const conn = ++state.connections;
    state.sockets.push(ws);
    const hello = () => ws.send(JSON.stringify({ type: 'hello', serverId: 'fake', version: 'test', protoVersion: 1, t: Date.now() }));
    const delay = helloDelayMs(conn);
    if (delay > 0) setTimeout(hello, delay); else hello();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'register': ws.send(JSON.stringify({ type: 'registered', serverParams: {} })); return;
        case 'config_state':
        case 'clock_sync': return;
        case 'ping': ws.send(JSON.stringify({ type: 'pong', t: msg.t, srvT: Date.now() })); return;
        default:
          state.requests.push({ conn, msg });
          onRequest(msg, ws, conn);
      }
    });
  });
  const { port } = wss.address();
  return {
    url: `ws://127.0.0.1:${port}`,
    state,
    close: () => new Promise((r) => {
      for (const ws of wss.clients) { try { ws.terminate(); } catch {} }
      wss.close(() => r());
    }),
  };
}

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) {
    try { await cleanups.pop()(); } catch {}
  }
});

async function setup(serverOpts) {
  const server = await startFakeServer(serverOpts);
  const fsm = new TransportState();
  const client = new ControlClient({ baseUrl: server.url, botId: 'test-bot', fsm, timing: FAST });
  // LIFO: stop the client first, then close the server.
  cleanups.push(() => server.close());
  cleanups.push(() => client.stop());
  return { server, client, fsm };
}

test('a plain pending request is rejected as soon as the socket closes (not after its timeout)', async () => {
  const { client, fsm } = await setup({
    // Never answer — drop the connection instead.
    onRequest: (msg, ws) => { if (msg.type === 'speaker_map_get') ws.terminate(); },
  });
  client.start();
  await waitFor(() => fsm.is(State.READY));

  const t0 = Date.now();
  await assert.rejects(client.speakerMapGet('guild-1'), /Server-Verbindung unterbrochen/);
  assert.ok(Date.now() - t0 < 2000, 'rejected promptly, long before the 15 s request timeout');
  assert.equal(client.pending.size, 0);
});

test('a resumable request (finalize) is re-sent with the SAME cmdId after a reconnect and resolves', async () => {
  const { server, client, fsm } = await setup({
    onRequest: (msg, ws, conn) => {
      if (msg.type !== 'finalize_session') return;
      // 1st connection: the link drops mid-finalize. 2nd: answer the re-send.
      if (conn === 1) { ws.terminate(); return; }
      ws.send(JSON.stringify({ type: 'finalize_result', cmdId: msg.cmdId, ok: true, sessionId: msg.sessionId, transcriptPath: '/t.md' }));
    },
  });
  client.start();
  await waitFor(() => fsm.is(State.READY));

  const result = await client.finalizeSession({ sessionId: '1700000000000', sessionName: 's1' }, { timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.transcriptPath, '/t.md');

  const sends = server.state.requests.filter((r) => r.msg.type === 'finalize_session');
  assert.equal(sends.length, 2, 'original + one re-send');
  assert.deepEqual(sends.map((r) => r.conn), [1, 2], 're-sent on the new connection');
  assert.equal(sends[0].msg.cmdId, sends[1].msg.cmdId, 're-send keeps the cmdId');
  assert.equal(sends[1].msg.sessionId, '1700000000000', 'payload preserved');
  assert.equal(client.pending.size, 0);
});

test('a resumable request issued while the link is reconnecting is sent once registered', async () => {
  const { server, client, fsm } = await setup({
    // 2nd connection: hold back the handshake so the request below is issued
    // while the client is still (re)connecting (e.g. link dropped during upload).
    helloDelayMs: (conn) => (conn === 2 ? 80 : 0),
    onRequest: (msg, ws) => {
      if (msg.type === 'finalize_session') ws.send(JSON.stringify({ type: 'finalize_result', cmdId: msg.cmdId, ok: true }));
    },
  });
  client.start();
  await waitFor(() => fsm.is(State.READY));
  server.state.sockets[0].terminate();
  await waitFor(() => !fsm.is(State.READY));

  const result = await client.finalizeSession({ sessionId: '42' }, { timeoutMs: 5000 });
  assert.equal(result.ok, true);
  const sends = server.state.requests.filter((r) => r.msg.type === 'finalize_session');
  assert.equal(sends.length, 1, 'sent exactly once, after registration');
  assert.equal(sends[0].conn, 2);
});

test('a plain request while not connected is rejected immediately', async () => {
  const fsm = new TransportState();
  const client = new ControlClient({ baseUrl: 'ws://127.0.0.1:9', botId: 'x', fsm, timing: FAST });
  cleanups.push(() => client.stop());
  await assert.rejects(client.speakerMapGet('g'), /Server nicht verbunden/);
  // Never started (DISCONNECTED) → even a resumable request cannot wait for a link.
  await assert.rejects(client.finalizeSession({ sessionId: '1' }), /Server nicht verbunden/);
});

test('stop() rejects pending resumable requests (nothing reconnects after an explicit stop)', async () => {
  const { client, fsm } = await setup({ onRequest: () => { /* never answer */ } });
  client.start();
  await waitFor(() => fsm.is(State.READY));
  const p = client.finalizeSession({ sessionId: '7' }, { timeoutMs: 5000 });
  await sleep(20);
  client.stop();
  await assert.rejects(p, /Server-Verbindung beendet/);
});

test('PROTO_MISMATCH gives up reconnecting, fails pending requests, and start() resets the give-up', async () => {
  const { server, client, fsm } = await setup({
    onRequest: (msg, ws, conn) => {
      // 1st connection: the server (e.g. mid rolling update) closes with 4002
      // while a finalize is pending. Later connections: a compatible server.
      if (conn === 1 && msg.type === 'finalize_session') ws.close(4002, 'PROTO_MISMATCH');
      if (msg.type === 'speaker_map_get') ws.send(JSON.stringify({ type: 'speaker_map', cmdId: msg.cmdId, map: { u: { player: 'P' } } }));
    },
  });
  client.start();
  await waitFor(() => fsm.is(State.READY));

  // Even a resumable request fails: the link gave up, no re-send will happen.
  await assert.rejects(client.finalizeSession({ sessionId: '1' }, { timeoutMs: 5000 }), /PROTO_MISMATCH/);
  assert.equal(client.giveUp, true);
  assert.ok(fsm.is(State.DISCONNECTED));
  await sleep(150); // several backoff periods
  assert.equal(server.state.connections, 1, 'no reconnect attempts after giving up');

  // An explicit start (e.g. /join after the rolling update finished) retries.
  client.start();
  assert.equal(client.giveUp, false);
  await waitFor(() => fsm.is(State.READY));
  assert.equal(server.state.connections, 2);
  assert.deepEqual(await client.speakerMapGet('g'), { u: { player: 'P' } });
});

test('start() during a backoff reconnects immediately instead of waiting out the backoff', async () => {
  const server = await startFakeServer();
  const fsm = new TransportState();
  const client = new ControlClient({ baseUrl: server.url, botId: 'b', fsm, timing: { ...FAST, backoffBaseMs: 60_000, backoffCapMs: 60_000 } });
  cleanups.push(() => server.close());
  cleanups.push(() => client.stop());
  client.start();
  await waitFor(() => fsm.is(State.READY));
  server.state.sockets[0].terminate();
  await waitFor(() => fsm.is(State.BACKOFF)); // next attempt only in ~60 s
  client.start();
  await waitFor(() => fsm.is(State.READY), { timeoutMs: 1000 });
  assert.equal(server.state.connections, 2);
});

test('start() while connected is a no-op (no second socket)', async () => {
  const { server, client, fsm } = await setup();
  client.start();
  await waitFor(() => fsm.is(State.READY));
  client.start();
  await sleep(50);
  assert.equal(server.state.connections, 1);
  assert.ok(fsm.is(State.READY));
});

test('the late close of a socket dropped by stop() does not disturb the next connection', async () => {
  const { server, client, fsm } = await setup({
    onRequest: (msg, ws) => {
      if (msg.type === 'speaker_map_get') setTimeout(() => ws.send(JSON.stringify({ type: 'speaker_map', cmdId: msg.cmdId, map: {} })), 30);
    },
  });
  client.start();
  await waitFor(() => fsm.is(State.READY));
  client.stop();      // idle release …
  client.start();     // … immediately followed by a /join
  await waitFor(() => fsm.is(State.READY));
  const p = client.speakerMapGet('g');
  await sleep(100);   // the old socket's close event has arrived by now
  assert.ok(fsm.is(State.READY), 'still ready');
  assert.deepEqual(await p, {}, 'request on the new socket unaffected');
  assert.equal(server.state.connections, 2, 'no extra reconnect scheduled by the stale close');
});
