import net from 'net';
import { exec } from 'child_process';
import { log, warn, debug } from './logger.js';

// Extract { host, port } from a WebSocket URL like "ws://192.168.20.101:7440".
// Returns null if no host or no port can be derived.
export function parseHostPort(url) {
  if (!url) return null;
  try {
    // Replace ws/wss with http/https so URL parser is happy.
    const normalized = url.replace(/^wss?:/i, 'http:');
    const u = new URL(normalized);
    if (!u.hostname) return null;
    const port = u.port ? Number(u.port) : (url.startsWith('wss') ? 443 : 80);
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

// Resolves true if a TCP connection to host:port is established within
// timeoutMs, false otherwise. Never throws.
export function probeTcp(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error',   () => finish(false));
    try {
      sock.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

function lastNonEmptyLine(text) {
  if (!text) return '';
  const lines = text.trim().split('\n').filter(Boolean);
  return lines[lines.length - 1] || '';
}

// Run SERVER_START_CMD detached so the bot does not block on it (fire-and-
// forget). onStatus, if given, is called once the command exits with
// { ok, message } — message is the last non-empty output line (e.g.
// cloud-start.sh's own `[cloud-start] ...` log lines), so callers can surface
// *why* a launch attempt failed instead of just a bare countdown.
function runStartCmd(cmd, onStatus) {
  log('autostart: launching SERVER_START_CMD');
  debug('autostart: cmd=', cmd);
  const child = exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
    if (err) warn('autostart: cmd exited with error:', err.message);
    if (stdout) debug('autostart: stdout:', stdout.trim());
    if (stderr) debug('autostart: stderr:', stderr.trim());
    const message = lastNonEmptyLine(stderr) || lastNonEmptyLine(stdout);
    onStatus?.({ ok: !err, message });
  });
  // Don't block process exit on the (potentially long-running) SSH session.
  child.unref?.();
}

// Top-level: ensure the LAN server is reachable.
//   onProgress({ phase, elapsedMs, deadlineMs, cmdStatus })
//                              — called on state changes / each poll for Discord feedback.
//                              — phase is 'starting' | 'waiting'.
//                              — cmdStatus is null until SERVER_START_CMD exits, then
//                                { ok, message } — message is its last output line (e.g.
//                                cloud-start.sh's own log), so callers can show *why*
//                                it's still waiting instead of a bare countdown.
//   probeTimeoutMs             — initial reachability probe per attempt (default 1000)
//   startTimeoutMs             — total time we wait for the server after launching (default 30000)
//   pollIntervalMs             — gap between reachability re-probes (default 2000)
//
// Returns one of:
//   'already-online'  — server was reachable immediately
//   'started'         — server was offline, we ran SERVER_START_CMD, then reached it
//   'no-cmd'          — server was offline and no SERVER_START_CMD configured
//   'timeout'         — we ran the cmd but server never became reachable in time
//   'no-base-url'     — SERVER_BASE_URL not set; nothing to do
export async function ensureServerReachable({
  onProgress = () => {},
  probeTimeoutMs = 1000,
  startTimeoutMs = Number(process.env.SERVER_START_TIMEOUT_MS) || 30000,
  pollIntervalMs = 2000,
} = {}) {
  const baseUrl = process.env.SERVER_BASE_URL;
  if (!baseUrl) return 'no-base-url';

  const target = parseHostPort(baseUrl);
  if (!target) {
    warn('autostart: cannot parse SERVER_BASE_URL=', baseUrl);
    return 'no-base-url';
  }

  // 1. Initial probe.
  if (await probeTcp(target.host, target.port, probeTimeoutMs)) {
    return 'already-online';
  }

  // 2. Offline. Run start command if configured.
  const cmd = process.env.SERVER_START_CMD;
  if (!cmd) {
    log('autostart: server offline and no SERVER_START_CMD set — continuing offline');
    return 'no-cmd';
  }

  const startedAt = Date.now();
  onProgress({ phase: 'starting', elapsedMs: 0, deadlineMs: startTimeoutMs });
  let cmdStatus = null;
  runStartCmd(cmd, (status) => { cmdStatus = status; });

  // 3. Poll until reachable or timeout.
  const deadline = startedAt + startTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (await probeTcp(target.host, target.port, probeTimeoutMs)) {
      log('autostart: server reachable');
      return 'started';
    }
    onProgress({ phase: 'waiting', elapsedMs: Date.now() - startedAt, deadlineMs: startTimeoutMs, cmdStatus });
  }

  warn('autostart: server did not come up within', startTimeoutMs, 'ms');
  return 'timeout';
}
