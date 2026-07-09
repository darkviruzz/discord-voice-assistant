import { exec } from 'child_process';
import { log, warn, debug } from './logger.js';

// Idle auto-stop for the (cloud GPU) server — the symmetric counterpart to the
// SERVER_START_CMD auto-start in serverAutoStart.js. When the bot has been idle
// (no active session) for SERVER_STOP_DELAY_MS, SERVER_STOP_CMD is run to shut
// the server down. On a cloud host that command destroys the instance so
// billing stops; a later /join provisions a fresh one via SERVER_START_CMD.
//
// The stop is a plain local exec (like the start command) — it does NOT depend
// on the control transport being connected, so it still fires after the idle
// link has already been released.

// Pending stop timer. At most one is armed at a time; null when none.
let _stopTimer = null;

// Run SERVER_STOP_CMD detached so the bot never blocks on it (fire-and-forget).
// This mirrors serverAutoStart's runStartCmd but is kept local on purpose: its
// log lines name SERVER_STOP_CMD, and importing runStartCmd would log the wrong
// ("SERVER_START_CMD") command.
function runStopCmd(cmd) {
  log('autostop: launching SERVER_STOP_CMD');
  debug('autostop: cmd=', cmd);
  const child = exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
    if (err) warn('autostop: cmd exited with error:', err.message);
    if (stdout) debug('autostop: stdout:', stdout.trim());
    if (stderr) debug('autostop: stderr:', stderr.trim());
  });
  // Don't block process exit on the (potentially long-running) SSH session.
  child.unref?.();
}

// Arm (or re-arm) the idle server-stop. No-op unless SERVER_STOP_CMD is set
// (default empty = feature off). Any previously pending timer is cleared first,
// so callers can re-arm freely on every session/voice end without stacking
// timers. After SERVER_STOP_DELAY_MS (default 900000 = 15 min) the timer fires
// and re-checks hasWork(): if a session became active again in the meantime the
// stop is skipped, otherwise SERVER_STOP_CMD is executed fire-and-forget.
//
//   hasWork()  — supplied by the caller (index.js knows about active sessions),
//                re-checked when the timer fires so a /join within the window
//                keeps the server alive.
export function scheduleServerStop({ hasWork = () => false } = {}) {
  const cmd = process.env.SERVER_STOP_CMD;
  if (!cmd) return;                                    // feature off
  const delayMs = Number(process.env.SERVER_STOP_DELAY_MS) || 900000;
  cancelServerStop();
  _stopTimer = setTimeout(() => {
    _stopTimer = null;
    if (hasWork()) {
      debug('autostop: session active again — not stopping server');
      return;
    }
    log('autostop: idle for', delayMs, 'ms with no active session — stopping server');
    runStopCmd(cmd);
  }, delayMs);
  // A pending stop must never keep the Node process alive on its own.
  _stopTimer.unref?.();
  debug('autostop: server stop scheduled in', delayMs, 'ms');
}

// Cancel a pending server-stop timer. Called when the server is needed again —
// on /join (a re-join within the window keeps the server) and at the start of a
// finalize (which needs the server alive). Safe to call when nothing is armed;
// only debug-logs when it actually cancels a pending stop.
export function cancelServerStop() {
  if (_stopTimer) {
    clearTimeout(_stopTimer);
    _stopTimer = null;
    debug('autostop: pending server stop cancelled');
  }
}
