// Rolling-summary folding + resume rebuild for the live transcript.
//
// liveContext.js holds the raw per-session buffer and pure render helpers; this
// module owns everything that touches the LLM/network or the JSONL on disk:
//   • summarize(prev, segment)      — one Ollama call: fold a segment into prose
//   • maybeFold(session)            — single-flight fold when the raw buffer
//                                     outgrows LIVE_RAW_WINDOW_CHARS
//   • rebuildLiveContext(session,…) — on (re)start, reconstruct buffer+summary
//                                     from the JSONL so context survives restarts
//
// Kept separate from liveContext.js to avoid an import cycle: pipeline.js calls
// appendLive() (pure) then maybeFold() (this module) as two distinct steps.

import { log, warn, debug } from './logger.js';
import {
  liveContextEnabled, rawWindowChars, foldChars, summaryMaxChars, foldMinIntervalMs,
  windowChars, selectFoldSegment, splitForRebuild, renderForLlm, removeEntries, makeEntry,
  _internal,
} from './liveContext.js';
import { readSessionEvents } from './sessionEvents.js';
import { buildModelFromEvents } from './finalize/merge.js';
import { loadSpeakerMap } from './speakerMap.js';

const { lineFor } = _internal;

// Summarizer system prompt. German, neutral prose, name-preserving. Output is a
// plain-text running summary (NOT the JSON the answer model emits).
const SUMMARY_SYSTEM = [
  'Du fasst den bisherigen Verlauf einer Pen-and-Paper-Spielrunde zusammen.',
  'Du bekommst eine bestehende Zusammenfassung (optional) und neue Gesprächsausschnitte.',
  'Aktualisiere die Zusammenfassung, sodass sie den gesamten Verlauf abdeckt.',
  '',
  'Regeln:',
  '- Schreibe in zusammenhängender deutscher Prosa, keine Aufzählungen.',
  '- Bewahre Eigennamen (Charaktere, Orte, NSCs) exakt.',
  '- Halte fest, was beschlossen wurde, was offen ist und wo die Gruppe steht.',
  '- Lass Smalltalk und Wiederholungen weg, behalte den roten Faden.',
  '- Antworte NUR mit der Zusammenfassung, ohne Vorrede oder Formatierung.',
].join('\n');

function summaryModel() {
  const m = process.env.SUMMARY_MODEL;
  return (m && m.trim()) ? m.trim() : (process.env.OLLAMA_MODEL ?? 'llama3');
}

// Truncate a finished summary to the char budget, preferring a sentence/word cut.
function capSummary(text, limit) {
  if (!(limit > 0)) return '';
  const t = text.trim();
  if (t.length <= limit) return t;
  const head = t.slice(0, limit);
  const lastStop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('\n'));
  if (lastStop >= limit * 0.6) return head.slice(0, lastStop + 1).trimEnd();
  const lastSp = head.lastIndexOf(' ');
  return (lastSp >= limit * 0.6 ? head.slice(0, lastSp) : head).trimEnd();
}

// One Ollama call: fold `segment` (entry[]) into `prev` (string) → new summary.
// Throws on connection/HTTP error so callers can keep the segment for a retry.
export async function summarize(prev, segment) {
  const base  = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
  const model = summaryModel();
  const segmentText = segment.map(lineFor).join('\n');
  const userContent = [
    prev && prev.trim() ? `Bisherige Zusammenfassung:\n${prev.trim()}` : null,
    `Neue Gesprächsausschnitte:\n${segmentText}`,
  ].filter(Boolean).join('\n\n');

  let res;
  try {
    res = await fetch(`${base}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user',   content: userContent },
        ],
        stream: false,
      }),
    });
  } catch (e) {
    throw new Error(`summarize: connection failed: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`summarize: HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw  = (data.message?.content ?? '').trim();
  return capSummary(raw, summaryMaxChars());
}

// Fold one segment into the session's rolling summary. On success the segment is
// removed from the buffer (crash-safe: a failed call leaves the buffer intact).
async function foldIntoSummary(session, segment) {
  const lc = session.liveContext;
  const next = await summarize(lc.summary, segment);
  if (next) lc.summary = next;
  removeEntries(session, segment);
  lc.lastFoldAt = Date.now();
  debug(`rollingSummary: folded ${segment.length} entries → summary ${lc.summary.length} chars`);
}

// Trigger a fold when the raw buffer has outgrown its window. Single-flight via
// `lc.summarizing` so two overlapping STT turns never fold at once. No-op when
// disabled, under budget, throttled, or nothing safe to fold.
export async function maybeFold(session) {
  if (!liveContextEnabled()) return;
  const lc = session?.liveContext;
  if (!lc || lc.summarizing) return;
  if (windowChars(lc.buffer) <= rawWindowChars()) return;
  const minInterval = foldMinIntervalMs();
  if (minInterval > 0 && Date.now() - lc.lastFoldAt < minInterval) return;
  const segment = selectFoldSegment(lc.buffer, foldChars());
  if (segment.length === 0) return;

  lc.summarizing = true;
  try {
    await foldIntoSummary(session, segment);
  } catch (e) {
    warn('rollingSummary: fold failed (segment kept):', e.message);
  } finally {
    lc.summarizing = false;
  }
}

// (Re)build the live context from the session's JSONL on start/resume so the LLM
// keeps its context across restarts. Runs at most once per session. Reads every
// logged turn, keeps the youngest ~LIVE_RAW_WINDOW_CHARS as the raw buffer and
// folds the older remainder into the rolling summary in one pass.
export async function rebuildLiveContext(session, sessionId) {
  if (!liveContextEnabled()) return;
  const lc = session?.liveContext;
  if (!lc || lc.rebuilt) return;
  lc.rebuilt = true;
  // A live buffer that already has entries means this isn't a cold start.
  if (lc.buffer.length > 0) return;

  const { events } = readSessionEvents(sessionId);
  if (!events.length) return;

  const speakerMap = loadSpeakerMap(session.guildId);
  const model = buildModelFromEvents(events, { speakerMap });
  const entries = (model.spans || [])
    .slice()
    .sort((a, b) => a.startMs - b.startMs)
    .map((s) => makeEntry({
      label: s.label,
      text: s.text,
      startMs: s.startMs,
      kind: s.type === 'assistant' ? 'assistant' : 'user',
    }))
    .filter(Boolean);
  if (entries.length === 0) return;

  const { older, younger } = splitForRebuild(entries, rawWindowChars());
  lc.buffer = younger;
  if (older.length > 0) {
    try {
      const summary = await summarize(lc.summary, older);
      if (summary) lc.summary = summary;
    } catch (e) {
      // Folding the history failed — keep it as raw context rather than lose it.
      warn('rollingSummary: rebuild summarize failed, keeping raw:', e.message);
      lc.buffer = older.concat(younger);
    }
  }
  log(`rollingSummary: rebuilt sid=${sessionId} buffer=${lc.buffer.length} entries, summary=${lc.summary.length} chars, raw=${renderForLlm(lc.buffer, Infinity).length} chars`);
}
