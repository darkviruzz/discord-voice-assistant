import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { warn, debug } from './logger.js';

// Where the bot keeps its own (persistent-host) copy of transcript events,
// pushed live by the server over the control WS — see
// apps/server/src/transcript.js. Independent of the server's own TRANSCRIPT_DIR
// (which lives on the ephemeral GPU instance and is only pulled off manually).
const DIR = process.env.BOT_TRANSCRIPT_DIR || join(homedir(), 'transcripts');
const RETENTION_DAYS = Number(process.env.BOT_TRANSCRIPT_RETENTION_DAYS) || 30;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function writeTranscriptEvent(sessionId, event) {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(join(DIR, `session_${sessionId}.jsonl`), JSON.stringify(event) + '\n');
  } catch (e) {
    warn('transcriptWriter: write error:', e.message);
  }
}

function pruneOldFiles() {
  try {
    mkdirSync(DIR, { recursive: true });
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(DIR)) {
      const path = join(DIR, name);
      try {
        if (statSync(path).mtimeMs < cutoff) {
          unlinkSync(path);
          debug('transcriptWriter: pruned', name);
        }
      } catch { /* file vanished or unreadable — skip */ }
    }
  } catch (e) {
    warn('transcriptWriter: cleanup error:', e.message);
  }
}

let cleanupTimer = null;
// Call once at bot startup. Prunes immediately, then daily thereafter, so
// BOT_TRANSCRIPT_DIR doesn't grow unbounded over many sessions.
export function startTranscriptCleanup() {
  if (cleanupTimer) return;
  pruneOldFiles();
  cleanupTimer = setInterval(pruneOldFiles, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}
