// Chronological transcript merge with monolog interrupt-splitting.
//
// Pure module (no I/O) so it is fully unit-testable. Two layers:
//   1. buildModelFromEvents(events, opts) — turn raw JSONL events into a
//      normalized { spans, sessionStartMs } model. Used for the live/fallback
//      path. The finalize re-STT path (M4) builds `spans` itself from the
//      re-transcribed WAVs and calls mergeTranscript() directly.
//   2. mergeTranscript(model, opts) — render the model to Markdown, splitting
//      interrupted monologues at word boundaries when word timestamps exist,
//      falling back to whole-utterance ordering otherwise.
//
// All times are absolute epoch milliseconds on the BOT clock (the authoritative
// timeline). user_transcript carries bot-clock startTsMs/endTsMs directly;
// server-stamped events (assistant_response, text_query) are normalized with
// the measured clock offset (serverClock − botClock).

const DEFAULT_PAUSE_THRESHOLD_S = 30;
const DEFAULT_ASSISTANT_NAME = 'Rabenauge';
const DEFAULT_WAKE_WORD = 'Rabenauge';
const DEFAULT_TIMEZONE = 'Europe/Berlin';

// ── small helpers ────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Rough spoken duration estimate for assistant/typed spans (ordering + pauses
// only, never rendered). ~165 wpm ≈ 360 ms/word, floor 1.5 s.
function estimateSpeechMs(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1500, words * 360);
}

function fmtClock(absMs, timeZone, withSeconds = true) {
  const fmt = new Intl.DateTimeFormat('de-DE', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hour12: false,
  });
  return fmt.format(new Date(absMs));
}

function fmtDate(absMs, timeZone) {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(absMs));
}

function fmtDurationMs(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}h ${m}min` : m > 0 ? `${m}min ${s}s` : `${s}s`;
}

// Speaker label from the mapping: "Player (Character)" › "Player" › displayName › id.
export function speakerLabel(userId, displayName, speakerMap = {}) {
  const m = speakerMap[String(userId)] || {};
  const player = m.player || displayName || (userId != null ? String(userId) : 'Spieler');
  return m.character ? `${player} (${m.character})` : player;
}

// Bold whole-word occurrences of the wake word and stop phrases in user text.
function emphasizeKeywords(text, { wakeWord, stopPhrases }) {
  let out = String(text || '');
  const terms = [];
  if (wakeWord) terms.push(wakeWord);
  if (Array.isArray(stopPhrases)) terms.push(...stopPhrases);
  // Longest first so multi-word phrases win over their prefixes.
  const uniq = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const term of uniq) {
    const body = term.split(/\s+/).map(escapeRegex).join('\\s+');
    const re = new RegExp(`(?<![\\p{L}\\p{N}*])(${body})(?![\\p{L}\\p{N}*])`, 'giu');
    out = out.replace(re, '**$1**');
  }
  return out;
}

// ── model building (live / fallback path) ────────────────────────────────────

// Convert parsed JSONL events for ONE session into a render model.
//   { spans: Span[], sessionStartMs }
// Span: { type:'user'|'assistant', userId?, label, startMs, endMs, text, words? }
export function buildModelFromEvents(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const speakerMap = opts.speakerMap || {};
  const assistantName = opts.assistantName || DEFAULT_ASSISTANT_NAME;

  // Session start = wire sessionId = bot startedAt (epoch ms).
  let sessionStartMs = Number(opts.sessionStartMs ?? NaN);
  if (!Number.isFinite(sessionStartMs)) {
    const sid = list.find((e) => e && e.sessionId != null)?.sessionId;
    sessionStartMs = sid != null ? Number(sid) : 0;
  }

  // Clock offset (serverClock − botClock): median of clock_sync, else
  // session_meta.clockOffsetMs, else 0.
  const clockOffsetMs = resolveClockOffset(list, opts.clockOffsetMs);

  const spans = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    switch (e.type) {
      case 'user_transcript': {
        const text = String(e.text || '').trim();
        if (!text) continue; // empty STT result — keep diagnostics out of the read view
        const startMs = Number.isFinite(e.startTsMs) ? e.startTsMs
          : Number.isFinite(e.tsMs) ? e.tsMs - clockOffsetMs : sessionStartMs;
        const endMs = Number.isFinite(e.endTsMs) ? e.endTsMs
          : Number.isFinite(e.durationMs) ? startMs + e.durationMs : startMs;
        spans.push({
          type: 'user',
          userId: e.userId != null ? String(e.userId) : null,
          label: speakerLabel(e.userId, e.userDisplayName, speakerMap),
          startMs, endMs,
          text,
          words: Array.isArray(e.words) ? e.words : null,
        });
        break;
      }
      case 'text_query': {
        const text = String(e.text || '').trim();
        if (!text) continue;
        const startMs = Number.isFinite(e.tsMs) ? e.tsMs - clockOffsetMs : sessionStartMs;
        spans.push({
          type: 'user',
          userId: e.userId != null ? String(e.userId) : null,
          label: speakerLabel(e.userId, e.userDisplayName, speakerMap),
          startMs,
          endMs: startMs + estimateSpeechMs(text),
          text,
          words: null,
          typed: true,
        });
        break;
      }
      case 'assistant_response': {
        const text = String(e.text || '').trim();
        if (!text) continue;
        const startMs = Number.isFinite(e.tsMs) ? e.tsMs - clockOffsetMs : sessionStartMs;
        spans.push({
          type: 'assistant',
          label: assistantName,
          startMs,
          endMs: startMs + estimateSpeechMs(text),
          text,
          words: null,
        });
        break;
      }
      default:
        break;
    }
  }

  return { spans, sessionStartMs, clockOffsetMs };
}

function resolveClockOffset(events, override) {
  if (Number.isFinite(override)) return override;
  const samples = events
    .filter((e) => e && e.type === 'clock_sync' && Number.isFinite(e.offsetMs))
    .map((e) => e.offsetMs)
    .sort((a, b) => a - b);
  if (samples.length > 0) return samples[Math.floor(samples.length / 2)];
  const meta = events.find((e) => e && e.type === 'session_meta');
  if (meta && Number.isFinite(meta.clockOffsetMs)) return meta.clockOffsetMs;
  return 0;
}

// ── rendering ─────────────────────────────────────────────────────────────────

// Split a user span into fragments at the start times of any OTHER span that
// begins strictly within (startMs, endMs). Requires word timestamps; without
// them the span stays a single (verbatim) fragment.
function fragmentsFor(span, cutTimes) {
  if (span.type !== 'user' || !span.words || span.words.length === 0 || cutTimes.length === 0) {
    return [{
      startMs: span.startMs,
      endMs: span.endMs,
      text: span.text,
      isContinuation: false,
    }];
  }
  const cuts = cutTimes.slice().sort((a, b) => a - b);
  const frags = [];
  let cur = [];
  let ci = 0;
  for (const w of span.words) {
    const abs0 = span.startMs + w.t0;
    while (ci < cuts.length && abs0 >= cuts[ci]) {
      if (cur.length) { frags.push(cur); cur = []; }
      ci++;
    }
    cur.push(w);
  }
  if (cur.length) frags.push(cur);
  if (frags.length === 0) {
    return [{ startMs: span.startMs, endMs: span.endMs, text: span.text, isContinuation: false }];
  }
  return frags.map((words, i) => ({
    startMs: span.startMs + words[0].t0,
    endMs: span.startMs + words[words.length - 1].t1,
    text: words.map((w) => w.w).join(' '),
    isContinuation: i > 0,
  }));
}

// Render the model to Markdown.
export function mergeTranscript(model, opts = {}) {
  const spans = (model.spans || []).slice().sort((a, b) => a.startMs - b.startMs);
  const sessionStartMs = Number(model.sessionStartMs ?? (spans[0]?.startMs ?? 0));
  const timeZone = opts.timeZone || DEFAULT_TIMEZONE;
  const pauseThresholdMs = (opts.pauseThresholdS ?? DEFAULT_PAUSE_THRESHOLD_S) * 1000;
  const wakeWord = opts.wakeWord ?? DEFAULT_WAKE_WORD;
  const stopPhrases = opts.stopPhrases ?? [];
  const assistantName = opts.assistantName || DEFAULT_ASSISTANT_NAME;
  const speakerMap = opts.speakerMap || {};

  // Flag interrupters: a span that began strictly inside another span's [start,end).
  for (const s of spans) {
    s._interrupter = spans.some((o) => o !== s && o.startMs < s.startMs && s.startMs < o.endMs);
  }

  // Build a flat, ordered list of rendered items (fragments + markers).
  const items = [];
  for (const span of spans) {
    const cutTimes = spans
      .filter((o) => o !== span && o.startMs > span.startMs && o.startMs < span.endMs)
      .map((o) => o.startMs);
    const frags = fragmentsFor(span, cutTimes);
    frags.forEach((f, idx) => {
      items.push({
        type: span.type,
        label: span.label,
        startMs: f.startMs,
        endMs: f.endMs,
        text: f.text,
        marker: f.isContinuation ? 'weiter' : (idx === 0 && span._interrupter ? 'unterbricht' : null),
        typed: !!span.typed,
      });
    });
  }
  // Continuations sort after the interrupter that caused them at equal times.
  items.sort((a, b) => (a.startMs - b.startMs) || ((a.marker === 'weiter' ? 1 : 0) - (b.marker === 'weiter' ? 1 : 0)));

  // ── header ──
  const lastEnd = spans.reduce((m, s) => Math.max(m, s.endMs), sessionStartMs);
  const participants = [...new Map(
    spans.filter((s) => s.type === 'user').map((s) => [s.label, true]),
  ).keys()];
  const lines = [];
  const title = opts.channelName ? `Session ${fmtDate(sessionStartMs, timeZone)} — ${opts.channelName}`
    : `Session ${fmtDate(sessionStartMs, timeZone)}`;
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`- **Beginn:** ${fmtClock(sessionStartMs, timeZone)} · **Dauer:** ${fmtDurationMs(lastEnd - sessionStartMs)}`);
  if (participants.length) lines.push(`- **Teilnehmer:** ${participants.join(', ')}`);
  if (opts.guildName) lines.push(`- **Server:** ${opts.guildName}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── body ──
  let prevEnd = null;
  for (const it of items) {
    if (prevEnd != null && it.startMs - prevEnd > pauseThresholdMs) {
      const mins = Math.max(1, Math.round((it.startMs - prevEnd) / 60000));
      lines.push('');
      lines.push(`## ${fmtClock(it.startMs, timeZone, false)} — Pause (${mins} min)`);
      lines.push('');
    }
    const ts = `[${fmtClock(it.startMs, timeZone)}]`;
    const marker = it.marker ? ` _[${it.marker}]_` : '';
    const typed = it.typed ? ' _(getippt)_' : '';
    const body = it.type === 'assistant'
      ? it.text
      : emphasizeKeywords(it.text, { wakeWord, stopPhrases });
    lines.push(`${ts} **${it.label}:**${marker}${typed} ${body}`.trimEnd());
    prevEnd = Math.max(prevEnd ?? it.endMs, it.endMs);
  }

  if (items.length === 0) {
    lines.push('_Keine transkribierten Äußerungen in dieser Session._');
  }

  return lines.join('\n') + '\n';
}

export const _internal = { estimateSpeechMs, emphasizeKeywords, fragmentsFor, resolveClockOffset, fmtClock };
