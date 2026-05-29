import { log, debug } from '../logger.js';

// Server-side auto-finalize idle timer. The server owns the timing decision
// (it is the finalize authority) but delegates execution to the bot via
// onFire — the bot holds the WAVs and runs the upload + finalize flow.
//
// Idle definition (per the design): the countdown runs only while the bot is
// alone in the voice channel OR after an explicit /leave. Players present in
// the channel keep the session alive even if silent. Presence transitions
// arrive as voice_state events:
//   'joined' | 'occupied' → activity → cancel the timer
//   'left'   | 'alone'    → idle     → (re)arm the timer
//
// Race handling: arming/cancelling and firing all run on the single JS thread,
// so a 'joined' that arrives before the timeout cancels it cleanly. Once a
// session transitions to finalizing it is locked; later presence events for it
// are ignored (a fresh /join starts a new session id on the bot).
export class AutoFinalizeTimer {
  constructor({ idleMs, onFire } = {}) {
    const hours = Number(process.env.SESSION_IDLE_HOURS ?? 4);
    this.idleMs = Number.isFinite(idleMs) ? idleMs : hours * 3600_000;
    this.onFire = onFire || (() => {});
    this.timers = new Map();      // sessionId(string) → Timeout
    this.finalizing = new Set();  // sessionId(string) locked
  }

  notify(sessionId, state) {
    const sid = String(sessionId);
    if (this.finalizing.has(sid)) return; // locked — ignore further presence
    if (state === 'joined' || state === 'occupied') this.cancel(sid);
    else if (state === 'left' || state === 'alone') this.arm(sid);
  }

  arm(sessionId) {
    const sid = String(sessionId);
    if (this.finalizing.has(sid)) return;
    this.cancel(sid);
    const t = setTimeout(() => this._fire(sid), this.idleMs);
    t.unref?.();
    this.timers.set(sid, t);
    debug(`autoFinalize: armed ${sid} (${Math.round(this.idleMs / 60000)} min)`);
  }

  cancel(sessionId) {
    const sid = String(sessionId);
    const t = this.timers.get(sid);
    if (t) { clearTimeout(t); this.timers.delete(sid); debug(`autoFinalize: cancelled ${sid}`); }
  }

  // Lock a session against (re)arming — called when finalize begins (manual or
  // auto) so a manual /finalize and the timer never both fire.
  markFinalizing(sessionId) {
    const sid = String(sessionId);
    this.cancel(sid);
    this.finalizing.add(sid);
  }

  // Release the lock (e.g. a finalize attempt failed and may be retried).
  release(sessionId) {
    this.finalizing.delete(String(sessionId));
  }

  isFinalizing(sessionId) {
    return this.finalizing.has(String(sessionId));
  }

  _fire(sid) {
    this.timers.delete(sid);
    if (this.finalizing.has(sid)) return;
    this.finalizing.add(sid);
    log(`autoFinalize: idle timeout reached for session ${sid} — requesting finalize`);
    try { this.onFire(sid); } catch (e) { debug('autoFinalize onFire error:', e.message); }
  }
}
