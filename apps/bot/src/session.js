import fs from 'fs';
import path from 'path';
import { ensureDir, safePath, debug, log } from './logger.js';
import { nowMs, fmtTs, toInt } from './util.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve('./data');
const IDLE_HOURS = toInt(process.env.SESSION_IDLE_HOURS, 4);

export class SessionManager {
  constructor() {
    ensureDir(DATA_DIR);
    this.active = null; // { id, dir, startedAt, lastActivity, timeline: [] }
  }

  static sessionsRoot() { return DATA_DIR; }

  static listOpenSessions() {
    const dirs = fs.readdirSync(DATA_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(DATA_DIR, d.name));
    return dirs.filter(d => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(d, 'session.json'), 'utf8'));
        return s.status === 'open';
      } catch { return false; }
    });
  }

  loadOrStartNew() {
    if (this.active) return this.active;
    const id = fmtTs(nowMs());
    const dir = path.join(DATA_DIR, id);
    ensureDir(dir);
    const s = { id, dir, startedAt: nowMs(), lastActivity: nowMs(), status: 'open', timeline: [] };
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(s, null, 2));
    this.active = s;
    log('Neue Session gestartet:', id);
    return s;
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