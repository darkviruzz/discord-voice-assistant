import { warn, debug } from './logger.js';
import { DISCORD_MAX_CHARS, clampDiscordText } from './discordText.js';

// One live status message per finalize in a Discord text channel.
//
// Why a channel message and not the slash-command reply: interaction tokens
// expire after 15 minutes, a long session's finalize (re-STT of hours of
// audio plus the LLM summary, half an hour and more) outlives that — editReply
// then fails silently and the result/error never shows up. A normal message
// can be edited for as long as
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

  // Discord rejects a message over 2000 chars — an oversized final edit would
  // leave the status stuck on its last progress line, so never send one.
  _render(text) {
    return clampDiscordText(this.header ? `${this.header}\n${text}` : text);
  }

  // Characters left for the body below the header (finalizeResultText budget).
  textRoom() {
    return DISCORD_MAX_CHARS - (this.header ? this.header.length + 1 : 0);
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

const SUMMARY_PREFIX = '📝 **Zusammenfassung:** ';
const SUMMARY_MORE = ' … (vollständig: summary.md im Archiv)';
const SUMMARY_MAX_CHARS = 1100;

// Final status of a successful finalize. Fits `maxChars` (one Discord message,
// minus the status header): the session recap is shortened to the room the
// other lines leave — long archive paths plus retention/pull notes plus an
// 1100-char recap could otherwise pass the limit and the edit was rejected.
export function finalizeResultText(result, retentionNote = '', { reFinalize = false, maxChars = DISCORD_MAX_CHARS } = {}) {
  const lines = [
    `✅ ${reFinalize ? 'Neu finalisiert' : 'Finalisiert'}.`,
    `Sprecher-Äußerungen: ${result.userCount}, Einträge gesamt: ${result.spanCount}`,
    `Transkript: \`${result.transcriptPath}\``,
    `Audio-Archiv: ${result.audioOk ? `\`${result.archiveDir}\` (${result.audioCount} Spuren)` : '⚠️ nicht erzeugt'}`,
    retentionNote.trim(),
  ].filter(Boolean);
  const summary = String(result.summary ?? '').trim();
  if (summary) {
    const room = maxChars - lines.join('\n').length - 1 - SUMMARY_PREFIX.length;
    if (summary.length <= Math.min(room, SUMMARY_MAX_CHARS)) {
      lines.push(SUMMARY_PREFIX + summary);
    } else {
      const cut = Math.min(room - SUMMARY_MORE.length, SUMMARY_MAX_CHARS);
      lines.push(cut >= 100
        ? `${SUMMARY_PREFIX}${summary.slice(0, cut).trimEnd()}${SUMMARY_MORE}`
        : '📝 Zusammenfassung: summary.md im Archiv');
    }
  }
  return clampDiscordText(lines.join('\n'), maxChars);
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
