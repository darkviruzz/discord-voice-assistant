export const DEBUG = process.env.DEBUG === '1';

export function log(...a)   { console.log('[INFO]', ...a); }
export function warn(...a)  { console.warn('[WARN]', ...a); }
export function error(...a) { console.error('[ERROR]', ...a); }
export function debug(...a) { if (DEBUG) console.log('[DEBUG]', ...a); }
