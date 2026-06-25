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

// Collapse STT/segment newlines and runs of whitespace into single spaces so a
// transcript line stays on one line.
export function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// True when the text consists only of bracketed tokens like "[Musik]",
// "[BLANK_AUDIO]" with no real words outside brackets → drop from the transcript.
export function isBracketOnly(text) {
  const stripped = String(text || '').replace(/\[[^\]]*\]/g, '').trim();
  return stripped.length === 0 && /\[[^\]]*\]/.test(String(text || ''));
}

// Mark user spans where a wake word / stop command was actually detected, so
// emphasis is applied only on real triggers (not on every mention of the word).
// Each detection event is attributed to the most recent user span of the same
// speaker that started at/just before the (clock-normalized) event time.
export function markDetections(spans, events, clockOffsetMs = 0) {
  const userSpans = spans.filter((s) => s.type === 'user' && s.userId != null);
  const assign = (evType, flag) => {
    for (const e of events) {
      if (!e || e.type !== evType) continue;
      const uid = e.userId != null ? String(e.userId) : null;
      if (!uid) continue;
      const t = Number.isFinite(e.tsMs) ? e.tsMs - clockOffsetMs : null;
      if (t == null) continue;
      let best = null;
      for (const s of userSpans) {
        if (String(s.userId) !== uid) continue;
        if (s.startMs <= t + 1000 && (!best || s.startMs > best.startMs)) best = s;
      }
      if (best) best[flag] = true;
    }
  };
  assign('wakeword_query', 'wakeDetected');
  assign('stop_command', 'stopDetected');
  return spans;
}

// Participant join/leave times. Prefers voice_member events (clock-normalized);
// falls back to first/last utterance per speaker.
export function computeParticipants(spans, events, clockOffsetMs = 0, speakerMap = {}) {
  const byUser = new Map();
  const get = (uid) => byUser.get(uid) || { label: null, joinMs: null, leftMs: null };

  for (const e of events) {
    if (!e || e.type !== 'voice_member' || e.userId == null) continue;
    const uid = String(e.userId);
    const t = Number.isFinite(e.tsMs) ? e.tsMs - clockOffsetMs : null;
    if (t == null) continue;
    const rec = get(uid);
    if (e.state === 'join') rec.joinMs = rec.joinMs == null ? t : Math.min(rec.joinMs, t);
    else if (e.state === 'leave') rec.leftMs = rec.leftMs == null ? t : Math.max(rec.leftMs, t);
    rec.label = speakerLabel(uid, e.displayName, speakerMap);
    byUser.set(uid, rec);
  }

  for (const s of spans) {
    if (s.type !== 'user' || s.userId == null) continue;
    const uid = String(s.userId);
    const rec = get(uid);
    if (rec.joinMs == null) rec.joinMs = s.startMs;
    rec.leftMs = rec.leftMs == null ? s.endMs : Math.max(rec.leftMs, s.endMs);
    rec.label = rec.label || s.label;
    byUser.set(uid, rec);
  }

  return [...byUser.values()].sort((a, b) => (a.joinMs ?? 0) - (b.joinMs ?? 0));
}

// Map an audio position (ms into the TTS) to a character offset in the text via
// linear interpolation, snapped forward to the next word boundary.
function charCutter(full, durationMs) {
  return (ms) => {
    if (!(durationMs > 0)) return full.length;
    const ratio = Math.max(0, Math.min(1, ms / durationMs));
    let c = Math.floor(full.length * ratio);
    if (c <= 0) return 0;
    if (c >= full.length) return full.length;
    const ws = full.slice(c).search(/\s/);
    if (ws >= 0) c += ws;
    return c;
  };
}

// Reconstruct assistant (LLM/TTS) turns, split at playback interruptions.
// We have no per-word TTS timing, so character positions are interpolated from
// playback_paused.msPlayed / tts_done.durationMs and snapped to word boundaries;
// playback_resumed.rewoundMs is honored so the replayed overlap after each
// interruption is not dropped. Ordering within a turn follows the playback
// event sequence (robust against clock-sync jitter), with the interrupting user
// utterance (interruptedByUserId) woven in between segments.
// Returns { spans, consumed } where `consumed` are user spans pulled into the
// woven sequence (so callers drop them from the standalone span list).
export function weaveAssistantTurns(events, { clockOffsetMs = 0, assistantName = DEFAULT_ASSISTANT_NAME, userSpans = [] } = {}) {
  const norm = (ms) => (Number.isFinite(ms) ? ms - clockOffsetMs : null);
  const TYPES = ['assistant_response', 'tts_start', 'tts_done', 'assistant_response_played', 'playback_paused', 'playback_resumed'];
  // playback_paused/resumed carry the TTS `id`, not the turnId — map id→turnId
  // via tts_start so they can be correlated to their turn.
  const idToTurn = new Map();
  for (const e of events) {
    if (e && e.type === 'tts_start' && e.id && e.turnId) idToTurn.set(e.id, e.turnId);
  }

  const turns = new Map(); // turnId → { ..., pauses[], resumes[] }
  let solo = 0;
  for (const e of events) {
    if (!e || !TYPES.includes(e.type)) continue;
    let key = e.turnId || (e.id ? idToTurn.get(e.id) : null);
    if (!key) {
      // assistant_response without a turnId (e.g. text replies) → standalone turn;
      // other event types can't be correlated, so skip them.
      if (e.type === 'assistant_response') key = `__solo_${solo++}`;
      else continue;
    }
    const rec = turns.get(key) || { pauses: [], resumes: [], turnId: key };
    if (e.type === 'playback_paused') rec.pauses.push(e);
    else if (e.type === 'playback_resumed') rec.resumes.push(e);
    else rec[e.type] = e;
    turns.set(key, rec);
  }

  const out = [];
  const consumed = new Set();
  // Process turns in playback-start order.
  const ordered = [...turns.values()].filter((r) => r.assistant_response)
    .sort((a, b) => (a.tts_start?.tsMs ?? a.assistant_response.tsMs ?? 0) - (b.tts_start?.tsMs ?? b.assistant_response.tsMs ?? 0));

  for (const rec of ordered) {
    const full = String(rec.assistant_response.text || '').trim();
    if (!full) continue;
    // Real turnId for debug correlation (null for synthetic text-reply turns).
    const turnId = (rec.turnId && !String(rec.turnId).startsWith('__solo_')) ? rec.turnId : null;
    const startWall = norm(rec.tts_start?.tsMs ?? rec.assistant_response.tsMs) ?? 0;
    const durationMs = rec.tts_done?.durationMs || estimateSpeechMs(full);
    const cut = charCutter(full, durationMs);
    const pauses = rec.pauses.slice().sort((a, b) => a.tsMs - b.tsMs);
    const resumes = rec.resumes.slice().sort((a, b) => a.tsMs - b.tsMs);

    // Uninterrupted (or stopped-only) turn → single span.
    if (pauses.length === 0) {
      const played = rec.assistant_response_played;
      const text = (played && played.truncated && played.text) ? String(played.text).trim() : full;
      out.push({ type: 'assistant', label: assistantName, startMs: startWall, endMs: startWall + estimateSpeechMs(text), text, words: null, forceMarker: null, interrupted: !!(played && played.truncated), turnId });
      continue;
    }

    let segStartPos = 0;        // audio ms position where the current segment begins
    let segStartWall = startWall;
    let lastWall = startWall - 1;
    const push = (it) => { it.startMs = Math.max(it.startMs, lastWall + 1); lastWall = it.startMs; out.push(it); };

    for (let k = 0; k < pauses.length; k++) {
      const pausePos = Number(pauses[k].msPlayed) || 0;
      const text = full.slice(cut(segStartPos), cut(pausePos)).trim();
      const endWall = norm(pauses[k].tsMs) ?? (segStartWall + (pausePos - segStartPos));
      if (text) push({ type: 'assistant', label: assistantName, startMs: segStartWall, endMs: endWall, text, words: null, forceMarker: k > 0 ? 'weiter' : null, turnId });

      // Weave in the interrupting user utterance.
      const interrupterId = pauses[k].interruptedByUserId != null ? String(pauses[k].interruptedByUserId) : null;
      if (interrupterId) {
        const pauseBot = norm(pauses[k].tsMs);
        let best = null, bestD = Infinity;
        for (const s of userSpans) {
          if (consumed.has(s) || String(s.userId) !== interrupterId) continue;
          const d = Math.abs(s.startMs - (pauseBot ?? s.startMs));
          if (d < bestD && d < 8000) { best = s; bestD = d; }
        }
        if (best) { consumed.add(best); push({ ...best, words: null, forceMarker: 'unterbricht' }); }
      }

      const resume = resumes[k];
      if (!resume) { segStartPos = pausePos; segStartWall = endWall; break; } // terminal stop
      segStartPos = Math.max(0, pausePos - (Number(resume.rewoundMs) || 0));
      segStartWall = norm(resume.tsMs) ?? endWall;
    }

    // Final segment to the end, when playback resumed after the last pause.
    if (resumes.length >= pauses.length) {
      const text = full.slice(cut(segStartPos)).trim();
      if (text) push({ type: 'assistant', label: assistantName, startMs: segStartWall, endMs: segStartWall + estimateSpeechMs(text), text, words: null, forceMarker: 'weiter', turnId });
    }
  }

  return { spans: out, consumed };
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

  // User + typed-query spans (voice assistant turns are woven in afterwards).
  const spans = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    switch (e.type) {
      case 'user_transcript': {
        const text = String(e.text || '').trim();
        if (!text || isBracketOnly(text)) continue; // empty/bracket-only STT result
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
        if (!text || isBracketOnly(text)) continue;
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
      case 'assistant_response':
        // Handled by weaveAssistantTurns() below (segmented by interruptions).
        break;
      default:
        break;
    }
  }

  const { spans: assistantSpans, consumed } = weaveAssistantTurns(list, {
    clockOffsetMs, assistantName, userSpans: spans,
  });
  const finalSpans = spans.filter((s) => !consumed.has(s)).concat(assistantSpans);

  markDetections(finalSpans, list, clockOffsetMs);
  const participants = computeParticipants(finalSpans, list, clockOffsetMs, speakerMap);
  return { spans: finalSpans, sessionStartMs, clockOffsetMs, participants };
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
      let marker;
      if (f.isContinuation) marker = 'weiter';
      else if ('forceMarker' in span) marker = span.forceMarker; // woven assistant/interrupter
      else if (idx === 0 && span._interrupter) marker = 'unterbricht';
      else marker = null;
      items.push({
        type: span.type,
        label: span.label,
        startMs: f.startMs,
        endMs: f.endMs,
        text: f.text,
        marker,
        typed: !!span.typed,
        wakeDetected: !!span.wakeDetected,
        stopDetected: !!span.stopDetected,
      });
    });
  }
  // Continuations sort after the interrupter that caused them at equal times.
  items.sort((a, b) => (a.startMs - b.startMs) || ((a.marker === 'weiter' ? 1 : 0) - (b.marker === 'weiter' ? 1 : 0)));

  // ── header ──
  const lastEnd = spans.reduce((m, s) => Math.max(m, s.endMs), sessionStartMs);
  // Participants with join/leave times: from the model (voice_member-derived)
  // when available, else first/last utterance per speaker.
  const participants = (model.participants && model.participants.length)
    ? model.participants
    : [...new Map(spans.filter((s) => s.type === 'user').map((s) => [s.label, { label: s.label, joinMs: null, leftMs: null }])).values()];
  const participantLine = participants.map((p) => {
    if (p.joinMs == null && p.leftMs == null) return p.label;
    const j = p.joinMs != null ? fmtClock(p.joinMs, timeZone, false) : '?';
    const l = p.leftMs != null ? fmtClock(p.leftMs, timeZone, false) : '?';
    return `${p.label} (${j}–${l})`;
  });
  const lines = [];
  const title = opts.channelName ? `Session ${fmtDate(sessionStartMs, timeZone)} — ${opts.channelName}`
    : `Session ${fmtDate(sessionStartMs, timeZone)}`;
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`- **Beginn:** ${fmtClock(sessionStartMs, timeZone)} · **Dauer:** ${fmtDurationMs(lastEnd - sessionStartMs)}`);
  if (participantLine.length) lines.push(`- **Teilnehmer:** ${participantLine.join(', ')}`);
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
    let body = normalizeText(it.text);
    if (it.type !== 'assistant') {
      // Emphasize only on real detections (wakeword_query / stop_command).
      body = emphasizeKeywords(body, {
        wakeWord: it.wakeDetected ? wakeWord : null,
        stopPhrases: it.stopDetected ? stopPhrases : [],
      });
    }
    lines.push(`${ts} **${it.label}:**${marker}${typed} ${body}`.trimEnd());
    prevEnd = Math.max(prevEnd ?? it.endMs, it.endMs);
  }

  if (items.length === 0) {
    lines.push('_Keine transkribierten Äußerungen in dieser Session._');
  }

  return lines.join('\n') + '\n';
}

export const _internal = {
  estimateSpeechMs, emphasizeKeywords, fragmentsFor, resolveClockOffset, fmtClock,
  normalizeText, isBracketOnly, markDetections, computeParticipants,
};
