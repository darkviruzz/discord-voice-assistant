// Strict Bearer auth for ws upgrade. Accepts the token via either:
//   Authorization: Bearer <token>
//   Sec-WebSocket-Protocol: <token>   (exact entry, not substring)
// `checkBearer(req, bearer)` returns true if the request is authorized.
// `pickProtocolFor(bearer)` returns a handleProtocols function that echoes
// the bearer when offered as a subprotocol.

import { timingSafeEqual } from 'crypto';

// Constant-time string compare (a plain === leaks the matching prefix length
// through timing). Length mismatch returns early — that only reveals the length.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function checkBearer(req, bearer) {
  // No CONTROL_BEARER configured → auth disabled (LAN dev setups). index.js
  // warns loudly at startup; Setup-VoiceAssistant.ps1 flags it as an error.
  if (!bearer) return true;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && safeEqual(auth, `Bearer ${bearer}`)) return true;
  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string') {
    const tokens = proto.split(',').map(s => s.trim());
    if (tokens.some((t) => safeEqual(t, bearer))) return true;
  }
  return false;
}

// Request from this machine itself (launcher scripts: Start-VoiceAssistant.ps1
// stops the server via POST /shutdown on localhost).
export function isLoopback(req) {
  const a = req.socket?.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

export function pickProtocolFor(bearer) {
  return (protocols) => {
    if (!bearer) return false;
    const list = Array.isArray(protocols) ? protocols : [...protocols];
    return list.some((p) => safeEqual(p, bearer)) ? bearer : false;
  };
}
