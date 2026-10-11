import { debug } from '../logger.js';

// Decides WHEN the on-demand control link may be dropped. The link is opened
// lazily (/join, /ask, finalize) and released after a grace period once nobody
// needs it any more, so an idle bot keeps no server connection.
//
// Two things keep the link up:
//   - hasWork()  — supplied by the caller (index.js: an active voice session),
//                  re-checked when the grace timer fires, so a /join during the
//                  grace window keeps the connection.
//   - holds      — long-running operations that need the link although no
//                  session is active (finalize after /leave, the server's idle
//                  auto-finalize). A finalize can outlive the grace period by
//                  far (re-STT of hours of audio); before holds existed the
//                  grace timer armed by /leave tore the socket down mid-finalize.
//
// While any hold is active a firing grace timer does nothing; when the LAST
// hold is released the normal idle policy is re-applied (grace timer re-armed
// unless hasWork()), so a finalize after /leave still ends with the link
// released instead of leaving it open forever.
//
// Pure timer/bookkeeping logic (no sockets) so it is unit-testable; the
// transport wires `release` to its disconnect().
export class LinkKeeper {
  constructor({ release, hasWork = () => false, graceMs = 60_000 } = {}) {
    this.release = release || (() => {});
    this.hasWork = hasWork;
    this.graceMs = graceMs;
    this.timer = null;
    // token → reason; a Map (not a counter) so a double release() of the same
    // hold can't steal another holder's count, and reasons show up in logs.
    this.holds = new Map();
    this._nextToken = 1;
  }

  // Acquire a hold. Returns an idempotent release function.
  hold(reason = 'hold') {
    const token = this._nextToken++;
    this.holds.set(token, reason);
    // Nothing may drop the link while held; a pending grace timer would only
    // fire to do nothing, so drop it now (re-armed on the last release).
    this.cancelRelease();
    debug(`link: hold +${reason} (${this.holds.size} active)`);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds.delete(token);
      debug(`link: hold -${reason} (${this.holds.size} active)`);
      if (this.holds.size === 0 && !this.hasWork()) this.scheduleRelease();
    };
  }

  isHeld() { return this.holds.size > 0; }

  // Arm (or re-arm) the grace timer. On fire: kept while held or hasWork().
  scheduleRelease({ delayMs = this.graceMs, hasWork = this.hasWork } = {}) {
    this.cancelRelease();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.isHeld()) {
        debug('link: idle release skipped — held by', [...this.holds.values()].join(', '));
        return;
      }
      if (hasWork()) return;
      this.release();
    }, delayMs);
    this.timer.unref?.();
  }

  cancelRelease() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
