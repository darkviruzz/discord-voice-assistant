import { WebSocketServer } from 'ws';
import { MAGIC_UPLK, parseFrame } from './protocol.js';
import { ensureSpeaker } from './state.js';
import { pickProtocolFor } from './auth.js';
import { debug, log, warn } from './logger.js';

// Nimmt per-Speaker Uplink-Frames entgegen (Opus oder PCM), kein Re-encode.
// Phase 1: WSS exists and is auth-gated, but the bot does not connect yet.
export function initUplinkWSS({ bearer } = {}) {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: pickProtocolFor(bearer),
    maxPayload: 65536,
    perMessageDeflate: false,
  });
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    debug('uplink connected');
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      try {
        const f = parseFrame(Buffer.from(data));
        if (!f.magic.equals(MAGIC_UPLK)) return;
        const sp = ensureSpeaker(f.sessionId, f.userId);
        sp.codec ??= f.codec;
        sp.frames++;
        sp.lastSeq = f.seq;
        if ((sp.frames % 100) === 0) debug('speaker frames', f.userId.toString(), sp.frames);
      } catch (e) {
        warn('uplink parse error:', e.message);
      }
    });
    ws.on('close', () => debug('uplink closed'));
    ws.on('error', (e) => warn('uplink ws error:', e.message));
  });
  log('uplink ws ready');
  return wss;
}
