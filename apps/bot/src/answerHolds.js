// Keeps the on-demand control link up until a typed question is answered.
//
// /ask, /recap or an @mention outside a voice session open the link on
// demand and arm the idle release (60 s grace). The answer comes back as a
// chat_message only when the LLM is done — a cold or large model, and the
// server allows LLM_TIMEOUT_MS = 120 s — and a link released meanwhile meant
// the server broadcast the answer to nobody: it was lost.
//
// add(channelId) takes a link hold per question; settle(channelId) — called
// for each chat_message — releases the oldest hold for that channel; a hold
// that never gets an answer (server gone) is released after `timeoutMs`.
// Pure bookkeeping around an injected hold() (transport.holdLink) so it is
// unit-testable.
export class AnswerHolds {
  constructor({ hold, timeoutMs = 150_000 } = {}) {
    this.hold = hold || (() => () => {});
    this.timeoutMs = timeoutMs;
    this.pending = new Map(); // channelId → [done, …] oldest first
  }

  add(channelId) {
    const key = String(channelId ?? '');
    const release = this.hold(`answer ${key}`);
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      const list = this.pending.get(key);
      const i = list ? list.indexOf(done) : -1;
      if (i >= 0) list.splice(i, 1);
      if (list && list.length === 0) this.pending.delete(key);
      release();
    };
    timer = setTimeout(done, this.timeoutMs);
    timer.unref?.();
    if (!this.pending.has(key)) this.pending.set(key, []);
    this.pending.get(key).push(done);
  }

  settle(channelId) {
    this.pending.get(String(channelId ?? ''))?.[0]?.();
  }

  get size() {
    let n = 0;
    for (const list of this.pending.values()) n += list.length;
    return n;
  }
}
