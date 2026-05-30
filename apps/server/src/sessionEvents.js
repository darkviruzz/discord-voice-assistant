// Read a session's JSONL transcript event log from disk.
//
// Extracted from control.js so both the finalize path (control.handleFinalize)
// and the live-context resume rebuild (rollingSummary.rebuildLiveContext) can
// reuse the exact same reader. Pure I/O — no LLM/network concerns.

import fs from 'fs';
import path from 'path';

function transcriptDir() {
  return (process.env.TRANSCRIPT_DIR ?? './transcripts').replace(/\/+$/, '');
}

// Returns { events: object[], jsonlPath: string|null }. Missing file → empty
// list with a null path; malformed lines are skipped silently.
export function readSessionEvents(sessionId) {
  const fp = path.join(transcriptDir(), `session_${sessionId}.jsonl`);
  if (!fs.existsSync(fp)) return { events: [], jsonlPath: null };
  const events = [];
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* skip malformed */ }
  }
  return { events, jsonlPath: fp };
}
