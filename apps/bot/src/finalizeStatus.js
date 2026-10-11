import { warn, debug } from './logger.js';

// One live status message per finalize in a Discord text channel.
//
// Why a channel message and not the slash-command reply: interaction tokens
// expire after 15 minutes, a long session's finalize (re-STT of hours of
// audio, 30 min budget) outlives that — editReply then fails silently and the
// result/error never shows up. A normal message can be edited for as long as
// it exists, and auto-finalizes (no interaction at all) get the same view.
//
// Edits are throttled (Discord rate-limits message edits; progress can tick
// several times a second) and serialised; the latest text always wins and the
// final done()/fail() text is never dropped. All Discord errors are swallowed
// (logged) — status reporting must never break the finalize itself.
export class FinalizeStatus {
  constructor({ resolveChannel, header = '', minIntervalMs = 4000, now = () => Date.now() } = {}) {
    this.resolveChannel = resolveChannel || (async () => null);
    this.header = header;
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.message = null;
    this.lastEditAt = 0;
    this.pending = null;   // latest text not yet shown
    this.timer = null;
    this.closed = false;
    this.chain = Promise.resolve();
  }

  _render(text) {
    return this.header ? `${this.header}\n${text}` : text;
  }

  _enqueue(fn) {
    this.chain = this.chain.then(fn).catch((e) => warn('finalize-status:', e.message));
    return this.chain;
  }

  // Post the message (first call) — later calls behave like update().
  start(text) {
    return this._enqueue(async () => {
      if (this.message) return this._edit(text);
      const ch = await this.resolveChannel();
      if (!ch?.send) { debug('finalize-status: no text channel — status stays in the log'); return; }
      this.message = await ch.send(this._render(text));
      this.lastEditAt = this.now();
    });
  }

  // Throttled progress line. Returns immediately.
  update(text) {
    if (this.closed) return;
    this.pending = text;
    const wait = this.minIntervalMs - (this.now() - this.lastEditAt);
    if (wait <= 0) { this._flush(); return; }
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this._flush(); }, wait);
      this.timer.unref?.();
    }
  }

  _flush() {
    const text = this.pending;
    this.pending = null;
    if (text == null || this.closed) return;
    this._enqueue(() => (this.message ? this._edit(text) : this._postLate(text)));
  }

  // A progress tick before start() had a channel (or start() was skipped).
  async _postLate(text) {
    const ch = await this.resolveChannel();
    if (!ch?.send) return;
    this.message = await ch.send(this._render(text));
    this.lastEditAt = this.now();
  }

  async _edit(text) {
    if (!this.message?.edit) return;
    await this.message.edit(this._render(text));
    this.lastEditAt = this.now();
  }

  // Final state — shown regardless of throttling; later updates are ignored.
  done(text) { return this._final(text); }
  fail(text) { return this._final(text); }

  _final(text) {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pending = null;
    return this._enqueue(() => (this.message ? this._edit(text) : this._postLate(text)));
  }
}

const PHASE_TEXT = {
  joined: '⏳ Finalize läuft bereits auf dem Server — warte auf das Ergebnis …',
  started: null,       // rendered with the utterance count below
  rebuilding: '⏳ Server baut das Transkript aus dem Archiv neu …',
  merge: '⏳ Transkript wird zusammengesetzt …',
  audio: '⏳ Audio-Archiv wird geschrieben …',
  summary: '⏳ Zusammenfassung der Session wird erstellt …',
};

// Server finalize_progress → one German status line.
export function formatProgress(msg = {}) {
  const { phase, done, total, utterances } = msg;
  if (phase === 'stt' && Number(total) > 0) {
    const pct = Math.floor((Number(done) / Number(total)) * 100);
    return `⏳ Transkribiere ${done}/${total} Äußerungen (${pct} %) …`;
  }
  if (phase === 'started') {
    return utterances ? `⏳ Server transkribiert ${utterances} Äußerungen …` : '⏳ Server transkribiert …';
  }
  return PHASE_TEXT[phase] || `⏳ ${phase ?? 'läuft'} …`;
}
