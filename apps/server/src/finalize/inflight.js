// One finalize run per session, shared by every request for it.
//
// A finalize_session can reach the server more than once for the same session:
// the bot re-sends it (same cmdId) after its control link dropped mid-finalize,
// and a manual /finalize can race the idle auto-finalize. Without this registry
// each request started its own run — two re-STTs of the same session in
// parallel, the first to finish deleting the shared upload dir under the other
// — and a re-send arriving just after completion found no manifest any more
// (NO_MANIFEST) although the transcript had been built.
//
//   attach(sid, waiter)    — a run for sid is in flight → the waiter joins it
//                            ('joined'; a waiter with the same cmdId — a re-send
//                            — replaces its earlier, now dead, socket). A
//                            recently completed run whose cmdIds include the
//                            waiter's → answered from the cache ('cached').
//                            Otherwise null: the caller starts a run.
//   start(sid, waiter, fn) — run fn() (async, returns the finalize_result
//                            payload or throws) and deliver the outcome to every
//                            waiter that attached meanwhile. Resolves with the
//                            payload, never rejects (a throw becomes
//                            { ok: false, sessionId, error }).
//
// attach() and start() must be called without an await in between, so no
// second request can slip in (control.js resolves the sources synchronously).
//
// Only successful results are cached (cacheTtlMs), and only for re-sends of a
// request that was part of that run (matching cmdId): a NEW request — e.g. a
// deliberate re-finalize from the archive after a code change — runs again.
// Failures are never cached, so a retry always runs again.
//
// Delivery is injected (`deliver(waiter, payload)`): control.js routes it to the
// waiter's socket, or to the bot's current connection when that one closed.
export class FinalizeRegistry {
  constructor({ deliver, cacheTtlMs = 15 * 60_000, now = () => Date.now() } = {}) {
    this.deliver = deliver || (() => {});
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.inflight = new Map();   // sid → { waiters: Map<cmdId, waiter> }
    this.completed = new Map();  // sid → { payload, cmdIds: Set<cmdId>, expiresAt }
  }

  isRunning(sessionId) {
    return this.inflight.has(String(sessionId));
  }

  attach(sessionId, waiter) {
    const sid = String(sessionId);
    this._sweep();
    const run = this.inflight.get(sid);
    if (run) {
      run.waiters.set(waiter.cmdId, waiter);
      return 'joined';
    }
    const done = this.completed.get(sid);
    if (done && done.cmdIds.has(waiter.cmdId)) {
      this._deliverTo(waiter, done.payload);
      return 'cached';
    }
    return null;
  }

  start(sessionId, waiter, fn) {
    const sid = String(sessionId);
    if (this.inflight.has(sid)) {
      // Contract violation (attach() first) — never start a 2nd parallel run.
      return Promise.reject(new Error(`finalize for session ${sid} already running`));
    }
    const run = { waiters: new Map([[waiter.cmdId, waiter]]) };
    this.inflight.set(sid, run);
    this.completed.delete(sid); // a new run supersedes an older cached result
    return (async () => {
      let payload;
      try {
        payload = await fn();
      } catch (e) {
        payload = { ok: false, sessionId: sid, error: e?.message || String(e) };
      }
      this.inflight.delete(sid);
      if (payload?.ok) {
        this.completed.set(sid, {
          payload,
          cmdIds: new Set(run.waiters.keys()),
          expiresAt: this.now() + this.cacheTtlMs,
        });
      }
      for (const w of run.waiters.values()) this._deliverTo(w, payload);
      return payload;
    })();
  }

  _deliverTo(waiter, payload) {
    try { this.deliver(waiter, payload); } catch { /* one bad waiter must not starve the others */ }
  }

  _sweep() {
    const t = this.now();
    for (const [sid, done] of this.completed) {
      if (done.expiresAt <= t) this.completed.delete(sid);
    }
  }
}
