export function nowMs() { return Date.now(); }
export function fmtTs(ts) { return new Date(ts).toISOString().replace(/[:.]/g, '-'); }
export function relMs(tsStart, ts) { return Math.max(0, ts - tsStart); }
export function toInt(v, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; }