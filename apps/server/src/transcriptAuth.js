// Optional HTTP Basic auth for the /transcript UI.
//
// Basic (not Bearer) on purpose: the browser's EventSource can't set custom
// headers, but it DOES send Basic credentials automatically on same-origin
// requests once the user has authenticated — so SSE keeps working behind auth.
//
// On by default with the trivial greyhawk/greyhawk credentials (mirrors the
// Obsidian-wiki style: enough to gate a soon-to-be-public page, not a secret).
// Override via env, or set TRANSCRIPT_UI_AUTH=off for an open LAN deployment.
//
//   TRANSCRIPT_UI_AUTH  basic (default) | off
//   TRANSCRIPT_UI_USER  default "greyhawk"
//   TRANSCRIPT_UI_PASS  default "greyhawk"

import { timingSafeEqual } from 'crypto';

function authEnabled() {
  const v = (process.env.TRANSCRIPT_UI_AUTH ?? 'basic').toLowerCase();
  return v !== 'off' && v !== 'none' && v !== 'false' && v !== '0';
}

// Constant-time string compare that doesn't leak length via early return.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    // Still run a comparison to keep timing uniform, then fail.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

function parseBasic(header) {
  const m = /^Basic\s+(.+)$/i.exec(header || '');
  if (!m) return null;
  let decoded;
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return null; }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

// Returns an Express middleware, or null when auth is disabled (caller then
// mounts nothing). Reads credentials at request time, like the rest of the
// server, so they can change without a code edit.
export function makeTranscriptAuth() {
  if (!authEnabled()) return null;
  return function transcriptAuth(req, res, next) {
    const user = process.env.TRANSCRIPT_UI_USER ?? 'greyhawk';
    const pass = process.env.TRANSCRIPT_UI_PASS ?? 'greyhawk';
    const creds = parseBasic(req.headers.authorization);
    if (creds && safeEqual(creds.user, user) && safeEqual(creds.pass, pass)) {
      return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Live-Transkript", charset="UTF-8"');
    res.status(401).send('Authentication required.');
  };
}
