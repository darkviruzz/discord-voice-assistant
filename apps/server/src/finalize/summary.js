import fs from 'fs';
import path from 'path';
import { warn, log, debug } from '../logger.js';
import { complete, defaultModel } from '../providers/llm.js';

// Session summary at finalize: a short German recap of the finished session,
// built from the merged transcript. It is what Rabenauge answers "Was war
// letztes Mal?" from (on request — never as a greeting), and it is the
// RAG-able digest of a session (raw transcripts are too long and noisy to
// retrieve from).
//
// Long sessions are summarised map-reduce style: the transcript is cut at
// line boundaries into ~SESSION_SUMMARY_CHUNK_CHARS pieces, each piece is
// condensed, then all partial notes are merged into one recap capped at
// SESSION_SUMMARY_MAX_CHARS. Uses the LLM provider (SUMMARY_MODEL if set).
//
// Strictly best-effort: any failure returns null and the finalize result is
// unaffected.

const PART_SYSTEM = [
  'Du protokollierst eine Pen-and-Paper-Spielrunde.',
  'Du bekommst einen Ausschnitt des Sitzungs-Transkripts (Sprecher in eckigen Klammern).',
  'Notiere knapp in deutscher Prosa, was in diesem Ausschnitt im Spiel passiert ist:',
  'Ereignisse, Entscheidungen, Orte, NSCs, Gegenstände, offene Fragen.',
  'Eigennamen exakt übernehmen. Smalltalk, Regeldiskussionen und Wiederholungen weglassen.',
  'Antworte NUR mit den Notizen, ohne Vorrede.',
].join('\n');

const FINAL_SYSTEM = [
  'Du schreibst die Zusammenfassung einer Pen-and-Paper-Sitzung für die Spielrunde.',
  'Du bekommst chronologische Notizen zur gesamten Sitzung.',
  'Schreibe daraus eine zusammenhängende deutsche Zusammenfassung:',
  'was passiert ist, was entschieden wurde, wo die Gruppe am Ende steht und welche Fragen offen sind.',
  'Eigennamen exakt übernehmen. Keine Aufzählungszeichen, keine Überschriften, keine Vorrede.',
].join('\n');

function summaryEnabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.SESSION_SUMMARY_ENABLED ?? 'true').trim());
}

function intEnv(key, def, min) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
}

function summaryModel() {
  const m = (process.env.SUMMARY_MODEL || '').trim();
  return m || defaultModel();
}

// Transcript markdown → only the spoken lines, no headers/front matter, so the
// model's budget goes to content. Falls back to the raw text if nothing matches.
// mergeTranscript writes spoken lines as "<ts> **Label:** text" and header
// facts as "- **Beginn:** …" — keep the former, drop the latter.
export function transcriptBody(md) {
  const lines = String(md || '').split(/\r?\n/);
  const spoken = lines.filter((l) => /\*\*[^*\n]+:\*\*/.test(l) && !/^\s*-\s/.test(l));
  return (spoken.length ? spoken : lines).join('\n').trim();
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

// transcriptMd → summary string, or null (disabled, empty transcript, LLM error).
export async function summarizeSession(transcriptMd, { completeFn = complete, onProgress = null } = {}) {
  if (!summaryEnabled()) return null;
  const body = transcriptBody(transcriptMd);
  if (body.length < 200) { debug('session-summary: transcript too short — skipped'); return null; }
  const chunkChars = intEnv('SESSION_SUMMARY_CHUNK_CHARS', 12000, 2000);
  const maxChars = intEnv('SESSION_SUMMARY_MAX_CHARS', 2500, 300);
  const model = summaryModel();
  const timeoutMs = 180_000;
  try {
    const chunks = chunkLines(body, chunkChars);
    let notes;
    if (chunks.length === 1) {
      notes = [chunks[0]];
    } else {
      notes = [];
      for (let i = 0; i < chunks.length; i++) {
        try { onProgress?.({ phase: 'summary', done: i, total: chunks.length }); } catch { /* reporting only */ }
        const { content } = await completeFn({
          model, timeoutMs,
          messages: [
            { role: 'system', content: PART_SYSTEM },
            { role: 'user', content: `Ausschnitt ${i + 1} von ${chunks.length}:\n${chunks[i]}` },
          ],
        });
        if (content) notes.push(`Teil ${i + 1}: ${content}`);
      }
      if (notes.length === 0) return null;
    }
    const { content } = await completeFn({
      model, timeoutMs,
      messages: [
        { role: 'system', content: FINAL_SYSTEM },
        { role: 'user', content: `${chunks.length === 1 ? 'Transkript' : 'Notizen'}:\n${notes.join('\n\n')}\n\nHöchstens ${maxChars} Zeichen.` },
      ],
    });
    const summary = capText(content, maxChars);
    return summary || null;
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
export function latestSessionSummary(archiveRoot = process.env.ARCHIVE_DIR ?? './archive', { excludeArchiveName = null } = {}) {
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
    if (!best || key > best.key) best = { file: f, archiveName: d.name, key, start };
  }
  if (!best) return null;
  try {
    const text = fs.readFileSync(best.file, 'utf8').trim();
    return text ? { text, archiveName: best.archiveName, sessionStartMs: best.start } : null;
  } catch { return null; }
}
