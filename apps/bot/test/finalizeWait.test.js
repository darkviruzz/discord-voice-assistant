import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { ControlClient, finalizeWaitLimits } from '../src/transport/control.js';
import { TransportState, State } from '../src/transport/state.js';

// The bot's wait for a server finalize is an inactivity timeout plus an
// overall cap (FINALIZE_IDLE_TIMEOUT_MS / FINALIZE_MAX_MS). Regression for the
// 2026-10-12 live session: WAV upload done 22:38:07, the server wrote
// transcript.md at ~23:06 and kept going, but the bot's fixed 30 min timeout
// fired at 23:08:07 (`finalize_session: Timeout`) and the session stayed open.
//
// The client runs on a fake READY socket and fake timers, so the scenarios
// below cover hours of wall clock in a few milliseconds.

const MIN = 60_000;

const ENV_KEYS = ['FINALIZE_IDLE_TIMEOUT_MS', 'FINALIZE_MAX_MS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  mock.timers.reset();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

function readyClient() {
  for (const k of ENV_KEYS) delete process.env[k]; // defaults: 10 min idle, 3 h cap
  mock.timers.enable({ apis: ['setTimeout'] });
  const fsm = new TransportState();
  fsm.set(State.READY);
  const client = new ControlClient({ baseUrl: 'ws://127.0.0.1:1', botId: 'test-bot', fsm });
  const sent = [];
  client.ws = { readyState: WebSocket.OPEN, send: (s) => sent.push(JSON.parse(s)) };
  return { client, sent };
}

// Promise → observable state, so a test can assert "still waiting".
function track(promise) {
  const t = { state: 'pending', value: undefined, error: undefined };
  promise.then((v) => { t.state = 'resolved'; t.value = v; }, (e) => { t.state = 'rejected'; t.error = e; });
  return t;
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

function progress(client, sessionId, extra = {}) {
  client._onMessage({ type: 'finalize_progress', cmdId: 'run-cmd', sessionId, phase: 'stt', done: 1, total: 3208, ...extra });
}

test('defaults: 10 min without progress, 3 h overall', () => {
  for (const k of ENV_KEYS) delete process.env[k];
  assert.deepEqual(finalizeWaitLimits(), { idleMs: 10 * MIN, maxMs: 180 * MIN });
});

test('limits are read per finalize from the env, clamped, junk falls back to the default', () => {
  process.env.FINALIZE_IDLE_TIMEOUT_MS = '900000';
  process.env.FINALIZE_MAX_MS = '7200000';
  assert.deepEqual(finalizeWaitLimits(), { idleMs: 15 * MIN, maxMs: 120 * MIN });
  process.env.FINALIZE_IDLE_TIMEOUT_MS = '1000';   // below the 2 min floor
  process.env.FINALIZE_MAX_MS = 'soon';
  assert.deepEqual(finalizeWaitLimits(), { idleMs: 2 * MIN, maxMs: 180 * MIN });
});

test('progress keeps the wait alive past the old fixed 30 min (3 h session: ~40 min finalize)', async () => {
  const { client, sent } = readyClient();
  const wait = track(client.finalizeSession({ sessionId: '1760300000000', sessionName: 's-long' }));
  const cmdId = sent.find((m) => m.type === 'finalize_session').cmdId;

  // A progress tick every 5 min for 40 min (re-STT, merge, summary, audio).
  for (let t = 5; t <= 40; t += 5) {
    mock.timers.tick(5 * MIN);
    await flush();
    assert.equal(wait.state, 'pending', `still waiting at ${t} min`);
    progress(client, '1760300000000', { phase: t < 30 ? 'stt' : 'summary' });
  }
  // The result arrives 9 min after the last tick — within the idle window.
  mock.timers.tick(9 * MIN);
  client._onMessage({ type: 'finalize_result', cmdId, ok: true, transcriptPath: '/t/transcript.md' });
  await flush();
  assert.equal(wait.state, 'resolved');
  assert.equal(wait.value.transcriptPath, '/t/transcript.md');
  assert.equal(client.pending.size, 0);
});

test('progress is matched by session (a joined run reports under its own cmdId) and by cmdId', async () => {
  const { client, sent } = readyClient();
  const wait = track(client.finalizeSession({ sessionId: '42' }));
  const cmdId = sent[0].cmdId;

  mock.timers.tick(9 * MIN);
  progress(client, '42');                                       // other cmdId, same session
  mock.timers.tick(9 * MIN);
  client._onMessage({ type: 'finalize_progress', cmdId, phase: 'joined' }); // own cmdId, no sessionId
  mock.timers.tick(9 * MIN);
  await flush();
  assert.equal(wait.state, 'pending', 'both kinds of progress restart the idle timer');

  progress(client, '43');                                       // a different session's run
  mock.timers.tick(1 * MIN);
  await flush();
  assert.equal(wait.state, 'rejected', 'progress of another session does not count');
  assert.match(wait.error.message, /finalize_session: Timeout \(10 min ohne Fortschritt vom Server\)/);
});

test('silence times out after FINALIZE_IDLE_TIMEOUT_MS', async () => {
  const { client } = readyClient();
  process.env.FINALIZE_IDLE_TIMEOUT_MS = String(5 * MIN);
  const wait = track(client.finalizeSession({ sessionId: '7' }));

  mock.timers.tick(2 * MIN);
  progress(client, '7');
  mock.timers.tick(5 * MIN - 1);
  await flush();
  assert.equal(wait.state, 'pending', 'one ms before the idle deadline');
  mock.timers.tick(1);
  await flush();
  assert.equal(wait.state, 'rejected');
  assert.match(wait.error.message, /Timeout \(5 min ohne Fortschritt vom Server\)/);
  assert.equal(client.pending.size, 0);

  // A late result for the timed-out request is ignored, not a crash.
  client._onMessage({ type: 'finalize_result', cmdId: 'whatever', ok: true });
});

test('the overall cap ends the wait even while progress keeps coming', async () => {
  const { client } = readyClient();
  const wait = track(client.finalizeSession({ sessionId: '9' }));

  for (let t = 5; t < 180; t += 5) {
    mock.timers.tick(5 * MIN);
    progress(client, '9');
  }
  mock.timers.tick(5 * MIN - 1);                                // 179:59.999
  await flush();
  assert.equal(wait.state, 'pending');
  mock.timers.tick(1);                                          // 3 h
  await flush();
  assert.equal(wait.state, 'rejected');
  assert.match(wait.error.message, /finalize_session: Timeout \(Obergrenze 180 min erreicht\)/);
  assert.equal(client.pending.size, 0);
});

test('explicit per-call limits win over the env', async () => {
  const { client } = readyClient();
  const wait = track(client.finalizeSession({ sessionId: '5' }, { idleTimeoutMs: 1000, timeoutMs: 60 * MIN }));
  mock.timers.tick(1000);
  await flush();
  assert.equal(wait.state, 'rejected');
  assert.match(wait.error.message, /1 s ohne Fortschritt/);
});

test('the idle timer keeps running while the link is down; the re-send answer restarts it', async () => {
  const { client, sent } = readyClient();
  const wait = track(client.finalizeSession({ sessionId: '11' }));
  const cmdId = sent[0].cmdId;

  // Link drops: the resumable request stays pending for the re-send…
  client._suspendPending('close 1006');
  mock.timers.tick(8 * MIN);
  await flush();
  assert.equal(wait.state, 'pending');
  // …link back, re-sent with the same cmdId, the server answers 'joined'.
  client._resendPending();
  assert.equal(sent.filter((m) => m.cmdId === cmdId).length, 2);
  client._onMessage({ type: 'finalize_progress', cmdId, sessionId: '11', phase: 'joined' });
  mock.timers.tick(9 * MIN);
  await flush();
  assert.equal(wait.state, 'pending', '17 min in, but 9 min since the last sign of life');

  // A second outage that outlasts the idle window gives up.
  client._suspendPending('close 1006');
  mock.timers.tick(1 * MIN);
  await flush();
  assert.equal(wait.state, 'rejected');
  assert.match(wait.error.message, /ohne Fortschritt vom Server/);
});

test('plain requests keep their single fixed timeout', async () => {
  const { client } = readyClient();
  const wait = track(client.speakerMapGet('g1'));
  mock.timers.tick(15_000);
  await flush();
  assert.equal(wait.state, 'rejected');
  assert.equal(wait.error.message, 'speaker_map_get: Timeout');
});
