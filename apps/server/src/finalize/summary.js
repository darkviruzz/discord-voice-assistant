import fs from 'fs';
import path from 'path';
import { warn, log, debug } from '../logger.js';
import { complete, summaryModel } from '../providers/llm.js';
import { currentVocabulary, vocabularyPrompt } from '../sttVocabulary.js';
import { promptText } from '../promptFiles.js';
import { campaignFileText } from '../campaignContext.js';

// Session summary at finalize: a short German recap of the finished session,
// built from the merged transcript. It is what Rabenauge answers "Was war
// letztes Mal?" from (on request — never as a greeting), and it is the
// RAG-able digest of a session (raw transcripts are too long and noisy to
// retrieve from).
//
// Long sessions are summarised map-reduce style: the players' lines are
// compacted (no timestamps or markup, see compactTranscript), cut at line
// boundaries into ~SESSION_SUMMARY_CHUNK_CHARS pieces, each piece is condensed
// into a note, then the notes are merged into one recap capped at
// SESSION_SUMMARY_MAX_CHARS (notes that do not fit one merge call are merged
// in batches first). Uses the summary endpoint of the LLM provider
// (SUMMARY_PROVIDER/SUMMARY_BASE_URL/SUMMARY_MODEL, each falling back to the
// answer LLM). Every prompt carries the STT vocabulary (STT_VOCABULARY/_FILE)
// as the spelling reference for names, and as background the campaign context
// file (CAMPAIGN.md: who is who) and the previous session's summary
// (backgroundHint) — with the rule that neither describes this session. The
// part and final prompts can come from vault notes (see PART_SYSTEM below);
// both hints are appended to whichever text is used.
//
// Sizing (measured 2026-10-19, gemma4:12b on Ollama with its 8192-token
// context, 3 h session): the raw transcript lines cost 2.5 chars/token, so a
// 12000-char chunk was ~5000 tokens and the session took 21 map calls + a
// 7.5k-token merge (9.6 min, the merge nearly at num_ctx). Compacted lines
// cost 3.2-3.3 chars/token at 69 % of the length, prose notes 4.3: an
// 18000-char chunk is ~5.6k tokens, which leaves room for the system prompt
// and the reply within 8k. The same session now: 10 map calls of ≤ 6.0k
// prompt tokens (system prompt and vocabulary included) + a 3.7k merge, 5.2 min.
//
// Strictly best-effort: the finalize result never depends on it. Out of time
// or a failing call does not throw the notes away — the summary is built from
// what was condensed so far and ends with a note that it is incomplete
// (partialNote). Only with no note at all is the result null.

// The built-in prompts. PART and FINAL can be replaced by a file (vault note)
// via SESSION_SUMMARY_PART_PROMPT_FILE / SESSION_SUMMARY_FINAL_PROMPT_FILE
// (promptFiles.js; starters in docs/prompts/); the batch merge, needed only
// when the notes do not fit one final call, always uses MERGE_SYSTEM. The
// spelling hint is appended to whichever text is used.
//
// The rules target what round 3 (2026-10-12, gemma4:12b) got wrong: the
// players' scheduling talk ("Terminorganisation aufgrund Schichtdienste") and
// character building ("für Droga noch ein Druide") ended up as open questions,
// and an allied NPC whose turn a player took in combat became "von Gaglath
// besiegt".
const NAME_RULE = 'Eigennamen exakt übernehmen. Ist unklar, ob ein Name eine Person, ein Ort oder ein Gegenstand ist, nenne ihn ohne Einordnung.';
const IN_GAME_RULE = 'Nur das Spielgeschehen zählt: was die Figuren in der Spielwelt erleben, tun und entscheiden. '
  + 'Weglassen, was am realen Spieltisch besprochen wird: Termine und Terminplanung, Arbeit, Schichtdienste und Privates, '
  + 'Technikprobleme, Smalltalk, Regeldiskussionen, Würfelwürfe und Schadenswerte, das Erstellen, Benennen oder Verwalten von Spielfiguren.';
const ROLE_RULE = 'NSCs behalten ihre Rolle: Begleiter und Verbündete der Gruppe nicht zu Gegnern machen, Personen nicht zu Gegenständen. '
  + 'Wer wen angreift, besiegt, heilt oder rettet, nur nennen, wenn es eindeutig gesagt wird — sonst ohne Täter und Opfer formulieren. Nichts dazuerfinden.';

export const PART_SYSTEM = [
  'Du protokollierst eine Pen-and-Paper-Spielrunde.',
  'Du bekommst einen Ausschnitt des Sitzungs-Transkripts (eine Zeile pro Wortbeitrag, "Spieler (Figur): Text").',
  'Die Spielleitung beschreibt die Welt und spricht für die NSCs. Im Kampf führen Spieler oft auch die Züge von NSC-Begleitern; "X ist dran" heißt nur, dass X an der Reihe ist.',
  'Notiere knapp in deutscher Prosa (Fließtext, kein Markdown, keine Aufzählungszeichen), was in diesem Ausschnitt im Spiel passiert ist:',
  'Ereignisse, Entscheidungen, Orte, NSCs, Gegenstände, offene Fragen.',
  'Nennt jemand ein Datum oder eine Tageszeit der Spielwelt oder wechselt die Gruppe den Ort, notiere es.',
  IN_GAME_RULE,
  ROLE_RULE,
  NAME_RULE,
  'Antworte NUR mit den Notizen, ohne Vorrede. Enthält der Ausschnitt kein Spielgeschehen, antworte nur: "Kein Spielgeschehen."',
].join('\n');

// Batch merge (only when the notes do not fit one final call).
const MERGE_SYSTEM = [
  'Du protokollierst eine Pen-and-Paper-Spielrunde.',
  'Du bekommst chronologische Notizen zu einem Teil der Sitzung.',
  'Fasse sie zu kürzeren chronologischen Notizen in deutscher Prosa zusammen (Fließtext, kein Markdown). Behalte',
  'Ereignisse, Entscheidungen, Orte, NSCs, Gegenstände, offene Fragen und genannte Daten der Spielwelt.',
  IN_GAME_RULE,
  ROLE_RULE,
  NAME_RULE,
  'Antworte NUR mit den Notizen, ohne Vorrede.',
].join('\n');

export const FINAL_SYSTEM = [
  'Du schreibst die Zusammenfassung einer Pen-and-Paper-Sitzung für die Spielrunde.',
  'Du bekommst chronologische Notizen zur gesamten Sitzung (bei kurzen Sitzungen direkt das Transkript, eine Zeile pro Wortbeitrag, "Spieler (Figur): Text").',
  'Schreibe daraus eine zusammenhängende deutsche Zusammenfassung:',
  'was in der Spielwelt passiert ist, was entschieden wurde, wo die Gruppe am Ende steht und welche Fragen im Spiel offen sind.',
  IN_GAME_RULE,
  ROLE_RULE,
  NAME_RULE,
  'Keine Aufzählungszeichen, keine Überschriften, keine Vorrede.',
  'Letzte Zeile, nur mit dem, was genannt wurde: "Ort: … · Ingame-Datum: …" — eine fehlende Angabe weglassen, nichts schätzen; das reale Datum der Sitzung ist kein Ingame-Datum. Ist beides unbekannt, entfällt die Zeile.',
].join('\n');

// The STT vocabulary as a spelling reference. Whisper only reads ~224 prompt
// tokens, the LLM has room for the whole list (cut at this many chars, order
// = priority as for STT).
const VOCAB_MAX_CHARS = 1500;

export function spellingHint() {
  let names = [];
  try { names = currentVocabulary().names; } catch (e) { debug('session-summary: vocabulary unavailable —', e.message); }
  const { text } = vocabularyPrompt(names, VOCAB_MAX_CHARS);
  if (!text) return '';
  return `Korrekte Schreibweisen von Namen und Begriffen der Kampagne: ${text}\n`
    + 'Das Transkript stammt aus einer Spracherkennung, die solche Namen oft ähnlich klingend, '
    + 'aber falsch schreibt: falsch erkannte Varianten stillschweigend korrigieren. Die Liste '
    + 'sagt nichts darüber, wer oder was ein Name ist.';
}

// Background knowledge for every prompt, '' when there is none:
// - the campaign context file (CAMPAIGN.md, the same one the answers use), cut
//   to SESSION_SUMMARY_CAMPAIGN_CHARS, so the model knows who is a player
//   character, an NSC or a place;
// - the previous session's summary, cut to SESSION_SUMMARY_PREVIOUS_CHARS, so
//   references to it make sense.
// The rule matters: without it a model "summarises" the background as if it
// had happened in this session. 0 switches a part off.
export function backgroundHint({ campaign = '', previous = '' } = {}) {
  const parts = [];
  const c = capText(campaign, intEnv('SESSION_SUMMARY_CAMPAIGN_CHARS', 4000, 0));
  if (c) {
    parts.push('Hintergrundwissen zur Kampagne — nur, um Namen, Figuren, Orte und Beziehungen richtig einzuordnen. '
      + 'Es beschreibt nicht diese Sitzung: übernimm daraus nichts, was im Transkript bzw. in den Notizen nicht vorkommt.\n'
      + c);
  }
  const p = capText(previous, intEnv('SESSION_SUMMARY_PREVIOUS_CHARS', 1500, 0));
  if (p) parts.push(`Kurzfassung der vorigen Sitzung — nur, damit Bezüge darauf verständlich sind; nicht wiederholen:\n${p}`);
  return parts.join('\n\n');
}

const withHint = (system, hint) => (hint ? `${system}\n${hint}` : system);

function summaryEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.SESSION_SUMMARY_ENABLED ?? 'true').trim());
}

function intEnv(key, def, min) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
}

// Transcript markdown → only the players' spoken lines, no headers/front
// matter, so the model's budget goes to content. Falls back to the raw text if
// no spoken line matches. mergeTranscript writes spoken lines as
// "<ts> **Label:** text" and header facts as "- **Beginn:** …" — keep the
// former, drop the latter. The assistant's own replies (label = assistantName,
// the wake word) are dropped too: a reply built from stale campaign context
// ended up in summary.md as if it had happened in the game.
export function transcriptBody(md, { assistantName = 'Rabenauge' } = {}) {
  const lines = String(md || '').split(/\r?\n/);
  const spoken = lines.filter((l) => /\*\*[^*\n]+:\*\*/.test(l) && !/^\s*-\s/.test(l));
  if (!spoken.length) return lines.join('\n').trim();
  const asst = String(assistantName || '').trim().toLowerCase();
  const label = (l) => l.match(/\*\*([^*\n]+):\*\*/)[1].trim().toLowerCase();
  return spoken.filter((l) => !asst || label(l) !== asst).join('\n').trim();
}

// Spoken lines → [{ ts, line }] in the compact form the LLM reads: the
// "[20:41:07] **Benny (Gaglath):** _[unterbricht]_ …" decoration cost about a
// third of the tokens (digits tokenize one by one), so per line only
// "Benny (Gaglath): text" stays — interruption/typed markers and **emphasis**
// go, consecutive lines of one speaker are joined (up to JOIN_MAX_CHARS, so a
// long monologue still breaks into lines a chunk can be cut between). `ts`
// (HH:MM of the line's first part, or null) only labels the chunks. Lines in
// another shape are kept as they are.
const SPOKEN_RE = /^\s*(?:\[([^\]\n]*)\]|`([^`\n]*)`)?\s*\*\*([^*\n]+):\*\*\s*(.*)$/;
const MARKERS_RE = /^(?:\s*_(?:\[[^\]\n]*\]|\([^)\n]*\))_)+\s*/;
const JOIN_MAX_CHARS = 800;

export function compactTranscript(body) {
  const out = [];
  let prevLabel = null;
  for (const raw of String(body || '').split('\n')) {
    if (!raw.trim()) continue;
    const m = raw.match(SPOKEN_RE);
    if (!m) { out.push({ ts: null, line: raw.trim() }); prevLabel = null; continue; }
    const label = m[3].trim();
    const text = m[4].replace(MARKERS_RE, '').replace(/\*\*/g, '').trim();
    if (!text) continue;
    const prev = out.at(-1);
    if (prev && prevLabel === label && prev.line.length + 1 + text.length <= JOIN_MAX_CHARS) {
      prev.line += ` ${text}`;
      continue;
    }
    const clock = String(m[1] ?? m[2] ?? '').match(/\b(\d{1,2}:\d{2})/);
    out.push({ ts: clock ? clock[1] : null, line: `${label}: ${text}` });
    prevLabel = label;
  }
  return out;
}

// [{ ts, line }] → [{ text, from, to }] of at most maxChars, cut at line
// boundaries (an overlong line is hard-split). from/to: HH:MM of the first and
// last line that carries one.
export function chunkRecords(records, maxChars) {
  const chunks = [];
  let cur = null;
  for (const { ts, line } of records) {
    for (const piece of line.length > maxChars ? chunkLines(line, maxChars) : [line]) {
      if (cur && cur.text.length + 1 + piece.length > maxChars) { chunks.push(cur); cur = null; }
      if (!cur) cur = { text: piece, from: ts, to: ts };
      else cur = { text: `${cur.text}\n${piece}`, from: cur.from ?? ts, to: ts ?? cur.to };
    }
  }
  if (cur && cur.text.trim()) chunks.push(cur);
  return chunks;
}

// Cut at line boundaries into pieces of at most maxChars (a single overlong
// line is hard-split).
export function chunkLines(text, maxChars) {
  const chunks = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if (line.length > maxChars) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
      continue;
    }
    if (cur && cur.length + 1 + line.length > maxChars) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

export function capText(text, limit) {
  const t = String(text || '').trim();
  if (t.length <= limit) return t;
  // Prefer a sentence end, else a word boundary — never cut mid-word.
  const head = t.slice(0, limit);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('\n'), head.endsWith('.') ? head.length - 1 : -1);
  if (stop >= limit * 0.4) return head.slice(0, stop + 1).trimEnd();
  const sp = head.lastIndexOf(' ');
  return (sp > 0 ? head.slice(0, sp) : head).trimEnd();
}

// capText for the finished summary: its closing "Ort: … · Ingame-Datum: …"
// line (FINAL_SYSTEM) is kept and the text before it is shortened — a plain
// cut keeps the front and would drop exactly that line.
const CLOSING_LINE_RE = /\n[ \t]*((?:Ort|Ingame-Datum)[ \t]*:[^\n]{1,200}?)[ \t]*$/i;

export function capSummary(text, limit) {
  const t = String(text || '').trim();
  const m = t.length > limit ? t.match(CLOSING_LINE_RE) : null;
  if (!m || m[1].length + 2 > limit / 2) return capText(t, limit);
  const head = capText(t.slice(0, m.index), limit - m[1].length - 2);
  return head ? `${head}\n\n${m[1]}` : capText(t, limit);
}

// Total time budget for one summary (all LLM calls). The summary runs inside
// the finalize the bot waits for: the bot gives up after FINALIZE_IDLE_TIMEOUT_MS
// without progress (every LLM call sends a tick, the server's keepalive covers
// a slow one) or at FINALIZE_MAX_MS (3 h). The budget keeps a slow model from
// holding the finished transcript back for that long. 30 min: the 3 h session
// above takes 5.2 min with the compacted input.
function summaryBudgetMs() {
  return intEnv('SESSION_SUMMARY_TIMEOUT_MS', 1_800_000, 10_000);
}

const CALL_MAX_MS = 180_000; // one LLM call
const MIN_CALL_MS = 1000;
// Notes are prose (4.3 chars/token measured, the compacted transcript 3.2-3.3),
// so a merge call takes this much more text for about the tokens of a map call.
const MERGE_FACTOR = 1.25;
// Target length of one note: the notes of all parts should fit one final merge
// call, within these bounds.
const NOTE_MIN_CHARS = 400;
const NOTE_MAX_CHARS = 2000;
const MAX_MERGE_ROUNDS = 3;

const clockRange = (n) => (n.from && n.to ? (n.from === n.to ? `${n.from} Uhr` : `${n.from}–${n.to} Uhr`) : '');
const noteForLlm = (n) => {
  const when = clockRange(n);
  return `${n.first === n.last ? `Teil ${n.first}` : `Teile ${n.first}–${n.last}`}${when ? ` (${when})` : ''}: ${n.text}`;
};
const joinedLength = (notes) => notes.reduce((len, n, i) => len + (i ? 2 : 0) + noteForLlm(n).length, 0);

// Consecutive notes → batches of at most maxChars joined. Always at least
// two notes per batch where possible, so every merge round shrinks the list.
function batchNotes(notes, maxChars) {
  const batches = [];
  let cur = [];
  for (const n of notes) {
    if (cur.length && joinedLength([...cur, n]) > maxChars) { batches.push(cur); cur = []; }
    cur.push(n);
  }
  if (cur.length) batches.push(cur);
  if (batches.length < notes.length) return batches;
  const pairs = [];
  for (let i = 0; i < notes.length; i += 2) pairs.push(notes.slice(i, i + 2));
  return pairs;
}

// No time or no LLM for the final merge: the notes themselves, one paragraph
// each (Markdown a model used anyway flattened), shortened to its share of the
// room, in order.
const flatten = (text) => String(text)
  .replace(/\*\*|__/g, '')
  .replace(/^\s*(?:[*+-]|\d+[.)])\s+/gm, '')
  .replace(/\s*\n\s*/g, ' ')
  .trim();

function condenseNotes(notes, room) {
  const per = Math.max(60, Math.floor((room - 2 * (notes.length - 1)) / notes.length));
  const text = notes.map((n) => {
    const when = clockRange(n);
    return capText(`${when ? `${when}: ` : ''}${flatten(n.text)}`, per);
  }).join('\n\n');
  return capText(text, room);
}

// The closing line of an incomplete summary — read by the players (/recap)
// and by the LLM (last-session context), so it says how far the summary goes.
export function partialNote({ covered, total, until = null, timeUp = false, failed = false, unmerged = false }) {
  const why = [timeUp && 'Zeitbudget aufgebraucht', failed && 'LLM-Fehler'].filter(Boolean).join(', ');
  let s = `(Unvollständig${why ? ` — ${why}` : ''}: `;
  s += covered < total ? `${covered} von ${total} Abschnitten berücksichtigt` : `alle ${total} Abschnitte verdichtet`;
  if (until) s += `, reicht bis etwa ${until} Uhr`;
  if (unmerged) s += '; die Notizen wurden nicht mehr zusammengeführt';
  return `${s}.)`;
}

// transcriptMd → summary string, or null (disabled, empty transcript, no part
// condensed). A summary that misses parts ends with partialNote().
// `previousSummary`: the summary of the session before this one (finalize
// passes it); `campaign`: the background text, default the CAMPAIGN.md file.
export async function summarizeSession(transcriptMd, {
  completeFn = complete, onProgress = null, now = () => Date.now(), assistantName,
  previousSummary = '', campaign = campaignFileText(),
} = {}) {
  if (!summaryEnabled()) return null;
  const records = compactTranscript(transcriptBody(transcriptMd, { assistantName }));
  if (records.reduce((len, r) => len + r.line.length + 1, 0) < 200) {
    debug('session-summary: transcript too short — skipped');
    return null;
  }
  const background = backgroundHint({ campaign, previous: previousSummary });
  // The background sits in every call's prompt. It is prose (~4.3 chars/token)
  // against the compacted transcript's ~3.2, so 3/4 of its length comes off the
  // chunk to keep a call within the same context window (8k on Ollama here).
  const chunkChars = Math.max(2000, intEnv('SESSION_SUMMARY_CHUNK_CHARS', 18000, 2000) - Math.ceil(background.length * 0.75));
  const maxChars = intEnv('SESSION_SUMMARY_MAX_CHARS', 2500, 300);
  const budgetMs = summaryBudgetMs();
  const model = summaryModel();
  const hint = [spellingHint(), background].filter(Boolean).join('\n\n');
  // Read once per summary, so all calls of one run use the same text.
  const partSystem = promptText('SESSION_SUMMARY_PART_PROMPT_FILE', PART_SYSTEM);
  const finalSystem = promptText('SESSION_SUMMARY_FINAL_PROMPT_FILE', FINAL_SYSTEM);
  const started = now();
  const deadline = started + budgetMs;
  const chunks = chunkRecords(records, chunkChars);
  const mergeChars = Math.round(chunkChars * MERGE_FACTOR);
  const noteChars = Math.min(NOTE_MAX_CHARS, Math.max(NOTE_MIN_CHARS, Math.floor(mergeChars / chunks.length)));

  let calls = 0;
  let callMs = 0;
  let planned = chunks.length + (chunks.length > 1 ? 1 : 0);
  const avgMs = () => (calls ? callMs / calls : 0);
  // Time held back for merging while condensing parts: about two calls (a
  // merge reads as much as a part and writes more), at least 30 s, at most a
  // quarter of the budget.
  const reserveMs = () => Math.min(budgetMs / 4, Math.max(30_000, 2 * avgMs()));
  const roomMs = (reserve) => deadline - now() - reserve;
  // No room for another call of the usual length.
  const outOfTime = () => roomMs(reserveMs()) < Math.max(MIN_CALL_MS, avgMs());

  // One LLM call, at most CALL_MAX_MS and never into `reserve`. Every call
  // sends a progress tick (the bot's finalize wait restarts on each).
  const ask = async (system, user, reserve = 0) => {
    const left = roomMs(reserve);
    if (left < MIN_CALL_MS) throw new Error(`time budget (${budgetMs} ms) exhausted`);
    try { onProgress?.({ phase: 'summary', done: calls, total: planned }); } catch { /* reporting only */ }
    const t = now();
    try {
      const { content } = await completeFn({
        model, role: 'summary', timeoutMs: Math.min(CALL_MAX_MS, left),
        messages: [{ role: 'system', content: withHint(system, hint) }, { role: 'user', content: user }],
      });
      const text = String(content ?? '').trim();
      if (!text) throw new Error('empty reply');
      return text;
    } finally {
      calls++;
      callMs += now() - t;
    }
  };

  try {
    if (chunks.length === 1) {
      const content = await ask(finalSystem, `Transkript:\n${chunks[0].text}\n\nHöchstens ${maxChars} Zeichen.`);
      return capSummary(content, maxChars) || null;
    }

    // Map: one note per part, until time runs short or the LLM looks down.
    const notes = [];
    let failed = false;
    let timeUp = false;
    let streak = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (outOfTime()) { timeUp = true; break; }
      const c = chunks[i];
      const when = clockRange(c);
      try {
        const content = await ask(partSystem,
          `Ausschnitt ${i + 1} von ${chunks.length}${when ? ` (${when})` : ''}:\n${c.text}\n\nHöchstens etwa ${noteChars} Zeichen.`,
          reserveMs());
        notes.push({ first: i + 1, last: i + 1, from: c.from, to: c.to, text: capText(content, 2 * noteChars) });
        streak = 0;
      } catch (e) {
        warn(`session-summary: part ${i + 1}/${chunks.length} failed — ${e.message}`);
        if (outOfTime()) { timeUp = true; break; } // cut at the budget, not an LLM error
        failed = true;
        if (++streak >= 2) break; // two in a row: keep what there is
      }
    }
    if (notes.length === 0) {
      warn('session-summary: no part could be condensed — no summary');
      return null;
    }

    // Reduce: batches until the notes fit one final call.
    let level = notes;
    let unmerged = false;
    for (let round = 0; joinedLength(level) > mergeChars && level.length > 1 && !unmerged; round++) {
      if (round >= MAX_MERGE_ROUNDS || outOfTime()) { unmerged = true; timeUp ||= outOfTime(); break; }
      const batches = batchNotes(level, mergeChars);
      planned += batches.filter((b) => b.length > 1).length;
      const target = Math.max(NOTE_MIN_CHARS, Math.floor(mergeChars / batches.length));
      const next = [];
      for (const batch of batches) {
        if (batch.length === 1 || unmerged) { next.push(...batch); continue; }
        try {
          const content = await ask(MERGE_SYSTEM,
            `Notizen:\n${batch.map(noteForLlm).join('\n\n')}\n\nHöchstens etwa ${target} Zeichen.`, reserveMs());
          next.push({ first: batch[0].first, last: batch.at(-1).last, from: batch[0].from, to: batch.at(-1).to, text: capText(content, 2 * target) });
        } catch (e) {
          warn(`session-summary: merging parts ${batch[0].first}–${batch.at(-1).last} failed — ${e.message}`);
          unmerged = true;
          next.push(...batch);
        }
      }
      level = next;
    }

    let text = null;
    if (!unmerged && joinedLength(level) <= mergeChars) {
      try {
        text = await ask(finalSystem, `Notizen:\n${level.map(noteForLlm).join('\n\n')}\n\nHöchstens ${maxChars} Zeichen.`);
      } catch (e) {
        warn('session-summary: final merge failed —', e.message);
        if (roomMs(0) < MIN_CALL_MS) timeUp = true;
        else failed = true;
      }
    }

    const partial = notes.length < chunks.length || failed || timeUp || !text;
    const marker = partial ? partialNote({
      covered: notes.length,
      total: chunks.length,
      until: notes.at(-1).last < chunks.length ? notes.at(-1).to : null,
      timeUp, failed, unmerged: !text,
    }) : '';
    const room = maxChars - (marker ? marker.length + 2 : 0);
    const body = text ? capSummary(text, room) : condenseNotes(level, room);
    const secs = Math.round((now() - started) / 1000);
    if (marker) warn(`session-summary: ${calls} LLM calls in ${secs} s — incomplete: ${marker} (budget SESSION_SUMMARY_TIMEOUT_MS=${budgetMs})`);
    else log(`session-summary: ${calls} LLM calls in ${secs} s for ${chunks.length} parts`);
    return (marker ? `${body}\n\n${marker}` : body).trim() || null;
  } catch (e) {
    warn('session-summary: failed —', e.message);
    return null;
  }
}

// Optional copy into the Obsidian vault (SESSION_SUMMARY_VAULT_DIR, relative to
// OBSIDIAN_VAULT_PATH; empty = off, the default — nothing is written into the
// user's vault unasked). The vault RAG index picks the note up on its next sync.
export function writeSummaryToVault(summary, { title, dateLabel }) {
  const rel = (process.env.SESSION_SUMMARY_VAULT_DIR || '').trim();
  const vault = (process.env.OBSIDIAN_VAULT_PATH || '').trim();
  if (!rel || !vault || !summary) return null;
  const dir = path.resolve(vault, rel);
  // Must stay inside the vault (rel comes from config, '..' would escape it).
  if (path.relative(path.resolve(vault), dir).startsWith('..')) {
    warn('session-summary: SESSION_SUMMARY_VAULT_DIR points outside the vault — not written');
    return null;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(title).replace(/[^\p{L}\p{N} ._-]+/gu, '_').slice(0, 80);
    const file = path.join(dir, `${safe}.md`);
    const front = ['---', 'type: session-summary', `date: ${dateLabel}`, 'source: rabenauge-finalize', '---', ''].join('\n');
    fs.writeFileSync(file, `${front}# ${title}\n\n${summary}\n`);
    log('session-summary: written to vault', file);
    return file;
  } catch (e) {
    warn('session-summary: vault write failed —', e.message);
    return null;
  }
}

// Summary of the most recent finalized session in the archive (for "what
// happened last time"). Ordered by the session's start (manifest.json
// sessionStartMs), not file mtime — a re-finalize of an old session must not
// make it "the last session". Returns { text, archiveName, sessionStartMs } or null.
// `beforeMs`: only sessions that started before it (the previous session of a
// re-finalized old one, not the newest).
export function latestSessionSummary(archiveRoot = process.env.ARCHIVE_DIR ?? './archive', { excludeArchiveName = null, beforeMs = null } = {}) {
  let best = null;
  let dirs;
  try { dirs = fs.readdirSync(archiveRoot, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory() || d.name === excludeArchiveName) continue;
    const dir = path.join(archiveRoot, d.name);
    const f = path.join(dir, 'summary.md');
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    let start = null;
    try { start = Number(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).sessionStartMs); } catch { /* no manifest */ }
    const key = Number.isFinite(start) && start > 0 ? start : st.mtimeMs;
    if (Number.isFinite(beforeMs) && key >= beforeMs) continue;
    if (!best || key > best.key) best = { file: f, archiveName: d.name, key, start };
  }
  if (!best) return null;
  try {
    const text = fs.readFileSync(best.file, 'utf8').trim();
    return text ? { text, archiveName: best.archiveName, sessionStartMs: best.start } : null;
  } catch { return null; }
}
