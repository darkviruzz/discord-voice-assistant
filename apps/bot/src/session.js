import fs from 'fs';
import path from 'path';
import { ensureDir, safePath, debug, log } from './logger.js';
import { nowMs, fmtTs, toInt } from './util.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve('./data');
const IDLE_HOURS = toInt(process.env.SESSION_IDLE_HOURS, 4);

// Session lifecycle: open → finalizing → finalized.
//   open       — recording target; /leave keeps it open for re-attach.
//   finalizing — finalize in progress (lock; blocks a second finalize).
//   finalized  — transcript + archive written; terminal.
export const SessionStatus = Object.freeze({
  OPEN: 'open',
  FINALIZING: 'finalizing',
  FINALIZED: 'finalized',
});

export class SessionManager {
  constructor() {
    ensureDir(DATA_DIR);
    this.active = null; // { id, dir, startedAt, lastActivity, status, timeline: [] }
  }

  static sessionsRoot() { return DATA_DIR; }

  static listOpenSessions() {
    const dirs = fs.readdirSync(DATA_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(DATA_DIR, d.name));
    return dirs.filter(d => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(d, 'session.json'), 'utf8'));
        return s.status === SessionStatus.OPEN;
      } catch { return false; }
    });
  }

  // Most-recent open session on disk whose lastActivity is within the idle
  // window — the re-attach candidate after a bot restart.
  static latestResumableSession() {
    const cutoff = nowMs() - IDLE_HOURS * 3600_000;
    let best = null;
    for (const d of SessionManager.listOpenSessions()) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(d, 'session.json'), 'utf8'));
        if (s.lastActivity >= cutoff && (!best || s.lastActivity > best.lastActivity)) best = s;
      } catch {}
    }
    return best;
  }

  startNew() {
    const id = fmtTs(nowMs());
    const dir = path.join(DATA_DIR, id);
    ensureDir(dir);
    const s = { id, dir, startedAt: nowMs(), lastActivity: nowMs(), status: SessionStatus.OPEN, timeline: [] };
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(s, null, 2));
    this.active = s;
    log('Neue Session gestartet:', id);
    return s;
  }

  // Re-attach to the in-memory or on-disk open session when possible, else
  // start a fresh one. Returns { session, resumed }.
  resumeOrStart() {
    if (this.active && this.active.status === SessionStatus.OPEN) {
      return { session: this.active, resumed: true };
    }
    const disk = SessionManager.latestResumableSession();
    if (disk) {
      // Recompute dir from DATA_DIR so a relocated data root still resolves.
      disk.dir = path.join(DATA_DIR, disk.id);
      ensureDir(disk.dir);
      if (!Array.isArray(disk.timeline)) disk.timeline = [];
      this.active = disk;
      this.touch();
      log('Session wieder aufgenommen:', disk.id);
      return { session: disk, resumed: true };
    }
    return { session: this.startNew(), resumed: false };
  }

  // Back-compat shim: callers that only need the active session object.
  loadOrStartNew() {
    return this.resumeOrStart().session;
  }

  markFinalizing() {
    if (!this.active) return;
    this.active.status = SessionStatus.FINALIZING;
    this.persist();
  }

  markFinalized() {
    if (!this.active) return;
    this.active.status = SessionStatus.FINALIZED;
    this.active.finalizedAt = nowMs();
    this.persist();
  }

  touch() {
    if (!this.active) return;
    this.active.lastActivity = nowMs();
    this.persist();
  }

  addUtterance(u) {
    // u = { userId, username, startMs, durationMs, file }
    this.active.timeline.push(u);
    this.touch();
  }

  // Numeric u64-string sessionId for the wire protocol; bot's local id is a
  // human-friendly timestamp string, but the server keys sessions by BigInt.
  wireSessionId() {
    if (!this.active) return null;
    return BigInt(this.active.startedAt).toString();
  }

  persist() {
    if (!this.active) return;
    fs.writeFileSync(path.join(this.active.dir, 'session.json'), JSON.stringify(this.active, null, 2));
  }

  static tryAutoFinalizeOld() {
    const hours = IDLE_HOURS;
    const cutoff = nowMs() - hours * 3600_000;
    const open = SessionManager.listOpenSessions();
    const toClose = [];
    for (const d of open) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(d, 'session.json'), 'utf8'));
        if (s.lastActivity < cutoff) toClose.push(s);
      } catch {}
    }
    return toClose;
  }
}