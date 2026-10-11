import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { parseHostPort, probeTcp, ensureServerReachable } from '../src/serverAutoStart.js';

// ── parseHostPort ────────────────────────────────────────────────────────────

test('parseHostPort: explicit ports and the documented ws:// form', () => {
  assert.deepEqual(parseHostPort('ws://192.168.20.101:7440'), { host: '192.168.20.101', port: 7440 });
  assert.deepEqual(parseHostPort('ws://10.10.0.2:7440/control'), { host: '10.10.0.2', port: 7440 });
  assert.deepEqual(parseHostPort('http://server.lan:8080/'), { host: 'server.lan', port: 8080 });
});

test('parseHostPort: scheme default ports (ws/http → 80, wss/https → 443)', () => {
  assert.deepEqual(parseHostPort('ws://server.lan'), { host: 'server.lan', port: 80 });
  assert.deepEqual(parseHostPort('http://server.lan'), { host: 'server.lan', port: 80 });
  assert.deepEqual(parseHostPort('wss://server.lan'), { host: 'server.lan', port: 443 });
  assert.deepEqual(parseHostPort('https://server.lan'), { host: 'server.lan', port: 443 });
  assert.deepEqual(parseHostPort('WSS://server.lan'), { host: 'server.lan', port: 443 }, 'scheme is case-insensitive');
});

test('parseHostPort: an explicit port equal to the other scheme\'s default is kept', () => {
  assert.deepEqual(parseHostPort('wss://server.lan:80'), { host: 'server.lan', port: 80 });
  assert.deepEqual(parseHostPort('ws://server.lan:443'), { host: 'server.lan', port: 443 });
});

test('parseHostPort: IPv6 literals come back without brackets (connectable host)', () => {
  assert.deepEqual(parseHostPort('ws://[::1]:7440'), { host: '::1', port: 7440 });
});

test('parseHostPort: empty / unparsable input → null', () => {
  for (const bad of [undefined, null, '', 'not a url', 'ws://:7440']) {
    assert.equal(parseHostPort(bad), null, `input ${JSON.stringify(bad)}`);
  }
});

// ── probeTcp / ensureServerReachable (loopback only) ──────────────────────────

const servers = [];
function listen(port = 0) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => sock.destroy());
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => { servers.push(srv); resolve(srv.address().port); });
  });
}
// A loopback port with nothing listening on it (bound once, then released).
// A port that is free right now — only for tests that then bind it
// themselves. NOT for "nothing ever listens here": `node --test` runs the
// other test files in parallel processes, and any of their listen(0) calls can
// be handed exactly this ephemeral port seconds later (seen in CI: the
// "never comes up" test got 'started').
async function closedPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

const savedEnv = { ...process.env };
afterEach(async () => {
  for (const k of ['SERVER_BASE_URL', 'SERVER_START_CMD', 'SERVER_START_TIMEOUT_MS']) {
    if (k in savedEnv) process.env[k] = savedEnv[k]; else delete process.env[k];
  }
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const node = JSON.stringify(process.execPath);
const FAST = { probeTimeoutMs: 300, pollIntervalMs: 20 };

// Port 1 (tcpmux) is below the ephemeral range, so no listen(0) anywhere in
// the suite can ever be assigned it, and nothing listens there on dev/CI
// hosts → a connect is refused deterministically.
const NEVER_OPEN_PORT = 1;

test('probeTcp: true for a listening port, false for a closed one (never throws)', async () => {
  const open = await listen();
  assert.equal(await probeTcp('127.0.0.1', open, 500), true);
  assert.equal(await probeTcp('127.0.0.1', NEVER_OPEN_PORT, 500), false);
  assert.equal(await probeTcp('127.0.0.1', 70000, 200), false, 'invalid port (sync throw) resolves false');
});

test('ensureServerReachable: no / unparsable SERVER_BASE_URL → "no-base-url"', async () => {
  delete process.env.SERVER_BASE_URL;
  assert.equal(await ensureServerReachable(FAST), 'no-base-url');
  process.env.SERVER_BASE_URL = 'not a url';
  assert.equal(await ensureServerReachable(FAST), 'no-base-url');
});

test('ensureServerReachable: reachable server → "already-online" without running the start command', async () => {
  const port = await listen();
  process.env.SERVER_BASE_URL = `ws://127.0.0.1:${port}`;
  process.env.SERVER_START_CMD = `${node} -e "process.exit(9)"`;
  const progress = [];
  assert.equal(await ensureServerReachable({ ...FAST, onProgress: (p) => progress.push(p) }), 'already-online');
  assert.deepEqual(progress, [], 'no start phase reported');
});

test('ensureServerReachable: offline and no SERVER_START_CMD → "no-cmd"', async () => {
  process.env.SERVER_BASE_URL = `ws://127.0.0.1:${NEVER_OPEN_PORT}`;
  delete process.env.SERVER_START_CMD;
  assert.equal(await ensureServerReachable(FAST), 'no-cmd');
});

test('ensureServerReachable: offline → runs the start command and returns "started" once the port opens', async () => {
  const port = await closedPort();
  process.env.SERVER_BASE_URL = `ws://127.0.0.1:${port}`;
  process.env.SERVER_START_CMD = `${node} -e "0"`;
  const phases = [];
  const r = await ensureServerReachable({
    ...FAST,
    startTimeoutMs: 5000,
    onProgress: (p) => {
      phases.push(p.phase);
      // Simulate the launched server coming up right after the launch.
      if (p.phase === 'starting') listen(port);
    },
  });
  assert.equal(r, 'started');
  assert.equal(phases[0], 'starting');
});

test('ensureServerReachable: "timeout" when the server never comes up; progress carries the command\'s last output line', async () => {
  process.env.SERVER_BASE_URL = `ws://127.0.0.1:${NEVER_OPEN_PORT}`;
  process.env.SERVER_START_CMD = `${node} -e "console.log('stdout line'); console.error('[cloud-start] no capacity'); process.exit(3)"`;
  const waiting = [];
  const r = await ensureServerReachable({
    ...FAST,
    startTimeoutMs: 1500,
    onProgress: (p) => { if (p.phase === 'waiting') waiting.push(p); },
  });
  assert.equal(r, 'timeout');
  assert.ok(waiting.length > 0, 'waiting progress reported while polling');
  assert.ok(waiting.every((p) => p.deadlineMs === 1500));
  const status = waiting.map((p) => p.cmdStatus).filter(Boolean).at(-1);
  assert.deepEqual(status, { ok: false, message: '[cloud-start] no capacity' }, 'stderr line preferred, exit code → ok:false');
});
