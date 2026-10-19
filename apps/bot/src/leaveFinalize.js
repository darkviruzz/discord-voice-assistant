import { log, warn, debug } from './logger.js';

// Bot-side idle auto-finalize for sessions that were LEFT (/leave, or open
// sessions found on disk at bot start).
//
// The server's AutoFinalizeTimer also arms on voice_state 'left', but it fires
// hours later (SESSION_IDLE_HOURS) by sending finalize_request over the
// control link — and the bot drops that link 60 s after /leave (idle release),
// so the request reached no bot and the session silently stayed open (on a
// cloud instance the timer usually dies with the auto-stopped box anyway). The
// bot owns the WAVs and the link lifecycle, so it schedules this case itself;
// performFinalize() brings the link (and, via SERVER_START_CMD, the server) up
// on its own. The server timer still covers the "bot alone in the channel"
// case, where the link stays up.
//
// Runs are serialised (one finalize at a time) so a bot restart with several
// stale sessions doesn't fan out parallel re-STT jobs onto one GPU.
export class LeaveFinalizeScheduler {
  constructor({ idleMs, run, isBlocked = () => false, enabled = true, minDelayMs = 0, now = () => Date.now() } = {}) {
    this.idleMs = idleMs;
    this.run = run;                 // async (sessionId) => void
    this.isBlocked = isBlocked;     // (sessionId) => true if it must not run now (re-joined)
    this.enabled = enabled;
    this.minDelayMs = minDelayMs;
    this.now = now;
    this.timers = new Map();        // sessionId → Timeout
    this.chain = Promise.resolve();
  }

  // Arm (or re-arm) the countdown for a session whose last activity was at
  // lastActivityMs. Already overdue → runs after minDelayMs.
  arm(sessionId, lastActivityMs, { minDelayMs = this.minDelayMs } = {}) {
    if (!this.enabled || !sessionId) return;
    this.cancel(sessionId);
    const due = (Number(lastActivityMs) || this.now()) + this.idleMs;
    const delay = Math.max(minDelayMs, due - this.now());
    const t = setTimeout(() => this._fire(sessionId), delay);
    t.unref?.();
    this.timers.set(sessionId, t);
    debug(`leave-finalize: armed ${sessionId} in ${Math.round(delay / 60000)} min`);
  }

  cancel(sessionId) {
    const t = this.timers.get(sessionId);
    if (t) { clearTimeout(t); this.timers.delete(sessionId); debug(`leave-finalize: cancelled ${sessionId}`); }
  }

  cancelAll() {
    for (const id of [...this.timers.keys()]) this.cancel(id);
  }

  isArmed(sessionId) { return this.timers.has(sessionId); }

  _fire(sessionId) {
    this.timers.delete(sessionId);
    const job = this.chain.then(async () => {
      if (this.isBlocked(sessionId)) { log(`leave-finalize: ${sessionId} is active again — skipped`); return; }
      log(`leave-finalize: idle limit reached for ${sessionId} — finalizing`);
      try { await this.run(sessionId); }
      catch (e) { warn(`leave-finalize: ${sessionId} failed — ${e.message} (bleibt offen, /finalize run)`); }
    });
    this.chain = job;
    return job;
  }
}
