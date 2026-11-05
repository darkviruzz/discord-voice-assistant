import fs from 'fs';
import os from 'os';
import path from 'path';

// Free space on the bot host, measured where the recordings go (DATA_DIR).
//
// Recording runs at roughly 370 MB per session hour (48 kHz mono WAV per
// utterance; measured on the 5.2 h session of 2026-11-03: 2.0 GB). The bot
// warns only when space gets tight — at /join when the planned session length
// will not fit, and during recording when less than an hour (then a quarter
// hour) is left. All good → no message at all.

function num(raw, def) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Read per call so a change in the settings panel applies at the next check.
export function diskConfig(env = process.env) {
  return {
    planHours: num(env.SESSION_PLAN_HOURS, 5),
    bytesPerHour: num(env.DISK_MB_PER_HOUR, 400) * 1e6,
    reserveBytes: num(env.DISK_RESERVE_MB, 300) * 1e6,
    checkIntervalMs: num(env.DISK_CHECK_INTERVAL_MIN, 10) * 60_000,
  };
}

function existingAncestor(dir) {
  let d = path.resolve(dir);
  while (!fs.existsSync(d)) {
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return d;
}

// Bytes available to this (unprivileged) process on the filesystem holding
// `dir` — the directory itself need not exist yet. In an LXC on ZFS this is
// what is left under the refquota, i.e. what `df` inside the container shows.
export function freeBytes(dir) {
  const s = fs.statfsSync(existingAncestor(dir));
  return Number(s.bavail) * Number(s.bsize);
}

// How many hours of recording still fit. The reserve stays free for finalize
// bookkeeping (session.json, manifest.json) so a full disk can never block it.
export function assessRecording({ free, bytesPerHour, reserveBytes, planHours }) {
  const usable = Math.max(0, free - reserveBytes);
  const hoursLeft = usable / bytesPerHour;
  const level = hoursLeft >= planHours ? 'ok' : hoursLeft >= 1 ? 'low' : 'critical';
  return { free, hoursLeft, planHours, level };
}

// Measure DATA_DIR now. Returns null when it cannot be measured (statfs
// unavailable or failing) — callers then simply stay silent.
export function measureRecording(dataDir, env = process.env, freeFn = freeBytes) {
  try {
    const cfg = diskConfig(env);
    return assessRecording({ free: freeFn(dataDir), ...cfg });
  } catch {
    return null;
  }
}

export function formatBytes(b) {
  const gb = b / 1e9;
  if (gb >= 1) return `${gb.toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB`;
  return `${Math.max(0, Math.round(b / 1e6))} MB`;
}

export function formatDuration(hours) {
  const min = Math.max(0, Math.floor(hours * 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m >= 10 && h < 10 ? `${h} h ${m} min` : `${h} h`;
}

// Is DATA_DIR on a tmp filesystem path? /tmp is emptied on every boot of the
// bot host (Debian: tmpfiles rule `D /tmp`) — unfinalized recordings, the
// _archived WAVs and config.overrides.json would be gone.
export function isTmpPath(dir) {
  const under = (p, root) => p === root || p.startsWith(`${root}/`);
  const raw = String(dir).replace(/\\/g, '/');
  const resolved = path.resolve(String(dir)).replace(/\\/g, '/');
  const tmp = path.resolve(os.tmpdir()).replace(/\\/g, '/');
  return under(raw, '/tmp') || under(resolved, '/tmp') || under(resolved, tmp);
}

// Lines for the /join reply — empty when everything is fine.
export function joinDiskLines(assessment, { dataDir } = {}) {
  const lines = [];
  if (assessment && assessment.level !== 'ok') {
    const left = formatDuration(assessment.hoursLeft);
    lines.push(assessment.level === 'critical'
      ? `🛑 Bot-Speicher fast voll: ${formatBytes(assessment.free)} frei — reicht nur noch für ca. ${left} Aufnahme. Bitte Platz schaffen.`
      : `⚠️ Bot-Speicher knapp: ${formatBytes(assessment.free)} frei — reicht für ca. ${left} Aufnahme (geplant ${assessment.planHours} h).`);
  }
  if (dataDir && isTmpPath(dataDir)) {
    lines.push(`⚠️ DATA_DIR liegt unter /tmp (\`${dataDir}\`) — wird beim Neustart des Bot-Hosts geleert. Bis zum Finalize nicht neu starten.`);
  }
  return lines;
}

// Always-on line for /server status (asked for explicitly, so not noise).
export function statusDiskLine(assessment) {
  if (!assessment) return null;
  const icon = assessment.level === 'ok' ? '💾' : assessment.level === 'low' ? '⚠️' : '🛑';
  return `${icon} Bot-Speicher: ${formatBytes(assessment.free)} frei — reicht für ca. ${formatDuration(assessment.hoursLeft)} Aufnahme.`;
}

// Periodic check while recording. Each threshold (minutes of recording left)
// is reported at most once per session; falling straight below the lowest one
// reports only that one.
export class DiskWatch {
  constructor({ measure, notify, intervalMs, thresholdsMin = [60, 15], timers = { setInterval, clearInterval } } = {}) {
    this.measure = measure;            // () => assessment | null
    this.notify = notify;              // (text) => void
    this.intervalMs = intervalMs;      // number | () => number
    this.thresholds = [...thresholdsMin].sort((a, b) => b - a);
    this.timers = timers;
    this.timer = null;
    this.fired = new Set();
  }

  start() {
    this.stop();
    this.fired = new Set();
    const ms = typeof this.intervalMs === 'function' ? this.intervalMs() : this.intervalMs;
    this.timer = this.timers.setInterval(() => this.check(), ms);
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = null;
  }

  isRunning() { return !!this.timer; }

  // Returns the message sent, or null.
  check() {
    const a = this.measure();
    if (!a) return null;
    const minLeft = a.hoursLeft * 60;
    const crossed = this.thresholds.filter((t) => minLeft < t && !this.fired.has(t));
    if (crossed.length === 0) return null;
    for (const t of this.thresholds) if (minLeft < t) this.fired.add(t);
    const lowest = crossed[crossed.length - 1];
    const left = formatDuration(a.hoursLeft);
    const text = lowest === this.thresholds[this.thresholds.length - 1]
      ? `🛑 Bot-Speicher fast voll: noch ca. ${left} Aufnahme möglich (${formatBytes(a.free)} frei) — danach gehen Aufnahmen verloren. Bitte jetzt Platz schaffen.`
      : `⚠️ Bot-Speicher wird knapp: noch ca. ${left} Aufnahme möglich (${formatBytes(a.free)} frei).`;
    try { this.notify(text); } catch { /* notify is best effort */ }
    return text;
  }
}
