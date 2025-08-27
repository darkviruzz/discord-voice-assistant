import fs from 'fs';
import path from 'path';

const DEBUG = process.env.DEBUG === '1';

export function log(...args) {
  console.log('[INFO]', ...args);
}
export function warn(...args) {
  console.warn('[WARN]', ...args);
}
export function error(...args) {
  console.error('[ERROR]', ...args);
}
export function debug(...args) {
  if (DEBUG) console.log('[DEBUG]', ...args);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function safePath(...segments) {
  const p = path.resolve(...segments);
  ensureDir(path.dirname(p));
  return p;
}