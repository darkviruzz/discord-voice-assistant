// Live-transcript buffer + serializer for LLM context.
//
// The live STT path already produces every utterance (user_transcript) and
// every reply (assistant_response); historically those were discarded for the
// LLM once no wake word matched. This module keeps them in a small in-RAM,
// per-session buffer, orders them, and renders a compact plain-text view that
// is fed to the LLM as a `system` block on wake-word queries.
//
// Split into pure helpers (renderForLlm / windowChars / selectFoldSegment —
// fully unit-testable) and thin stateful ops over `session.liveContext`.
// The async folding into a rolling summary lives in rollingSummary.js to keep
// this module free of LLM/network concerns (and avoid an import cycle).

import { normalizeText, isBracketOnly } from './finalize/merge.js';

// ── config (read at call-time, like the rest of the server) ──────────────────

function numberEnv(name, fallback, min = 0) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

export function liveContextEnabled() {
  return (process.env.LIVE_CONTEXT_ENABLED ?? 'true') !== 'false';
}
export function rawWindowChars() { return numberEnv('LIVE_RAW_WINDOW_CHARS', 6000, 0); }
export function foldChars()       { return numberEnv('LIVE_FOLD_CHARS', 3000, 0); }
export function renderMaxChars()  { return numberEnv('LIVE_RENDER_MAX_CHARS', 6000, 0); }
export function summaryMaxChars() { return numberEnv('SUMMARY_MAX_CHARS', 2000, 0); }
export function foldMinIntervalMs() { return numberEnv('LIVE_FOLD_MIN_INTERVAL_MS', 0, 0); }

// ── pure helpers ─────────────────────────────────────────────────────────────

// One rendered line, no trailing newline: "[Label] text".
function lineFor(entry) {
  return `[${entry.label}] ${entry.text}`;
}

// Total characters the buffer would render to (incl. one newline per line).
export function windowChars(entries) {
  let n = 0;
  for (const e of entries) n += lineFor(e).length + 1;
  return n;
}

// Compact plain-text view, newest lines preferred: when the rendered text would
// exceed `maxChars`, the OLDEST lines are dropped (the recent conversation is
// the most relevant context). No timestamps, no interrupt markers.
export function renderForLlm(entries, maxChars = Infinity) {
  const lines = entries.map(lineFor);
  if (!(maxChars > 0)) return '';
  // Keep as many trailing lines as fit within the budget.
  let total = 0;
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1; // +1 for the joining newline
    if (total + cost > maxChars) break;
    total += cost;
    start = i;
  }
  return lines.slice(start).join('\n');
}

// Select the OLDEST entries whose cumulative rendered size reaches ~`foldChars`.
// Returns the array of entry references (so callers can remove them by identity
// after a successful summarize). Always returns at least one entry when the
// buffer is non-empty; never returns the entire buffer (leaves the newest one).
export function selectFoldSegment(entries, targetChars) {
  if (entries.length <= 1) return [];
  const seg = [];
  let total = 0;
  for (let i = 0; i < entries.length - 1; i++) {
    seg.push(entries[i]);
    total += lineFor(entries[i]).length + 1;
    if (total >= targetChars) break;
  }
  return seg;
}

// Split a (sorted) entry list into the oldest part to fold and the newest part
// to keep as the raw window (≤ keepChars). Used by the resume rebuild.
export function splitForRebuild(entries, keepChars) {
  let total = 0;
  let start = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = lineFor(entries[i]).length + 1;
    if (total + cost > keepChars && entries.length - i > 0) break;
    total += cost;
    start = i;
  }
  return { older: entries.slice(0, start), younger: entries.slice(start) };
}

// ── stateful ops over session.liveContext ────────────────────────────────────

// Normalize + validate an entry, return null when it should be dropped.
export function makeEntry({ label, text, startMs, kind }) {
  const clean = normalizeText(text);
  if (!clean || isBracketOnly(clean)) return null;
  return {
    label: String(label || 'Spieler'),
    text: clean,
    startMs: Number.isFinite(startMs) ? startMs : Date.now(),
    kind: kind === 'assistant' ? 'assistant' : 'user',
  };
}

// Append one entry to the session buffer, keeping it sorted by startMs.
// Returns the stored entry, or null when dropped / disabled / no buffer.
export function appendLive(session, fields) {
  if (!liveContextEnabled()) return null;
  const lc = session?.liveContext;
  if (!lc) return null;
  const entry = makeEntry(fields);
  if (!entry) return null;
  const buf = lc.buffer;
  buf.push(entry);
  // Async STT can deliver slightly out of order — cheap fix-up only when needed.
  if (buf.length > 1 && buf[buf.length - 1].startMs < buf[buf.length - 2].startMs) {
    buf.sort((a, b) => a.startMs - b.startMs);
  }
  return entry;
}

// Render the current buffer for prompt injection (capped from the back).
export function renderLiveContext(session) {
  const lc = session?.liveContext;
  if (!lc || lc.buffer.length === 0) return '';
  return renderForLlm(lc.buffer, renderMaxChars());
}

// Remove the given entries (by identity) from the session buffer.
export function removeEntries(session, segment) {
  const lc = session?.liveContext;
  if (!lc || !segment || segment.length === 0) return;
  const set = new Set(segment);
  lc.buffer = lc.buffer.filter((e) => !set.has(e));
}

export const _internal = { lineFor };
