import { WebSocketServer } from 'ws';
import { MAGIC_UPLK, parseFrame } from './protocol.js';
import { ensureSpeaker } from './state.js';
import { debug, log, warn } from './logger.js';

// Nimmt per-Speaker Uplink-Frames entgegen (Opus oder PCM), kein Re-encode
export function initUplinkWSS(server, { path = '/uplink' } = {}) {
  const wss = new WebSocketServer({ server, path });
  wss.on('connection', (ws) => {
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
        // Hier könntest du Frames an STT weiterreichen oder auf Datei schreiben.
        // Minimal: zählen/loggen:
        if ((sp.frames % 100) === 0) debug('speaker frames', f.userId.toString(), sp.frames);
      } catch (e) {
        warn('uplink parse error:', e.message);
      }
    });
    ws.on('close', () => debug('uplink closed'));
  });
  log('uplink ws ready at', path);
  return wss;
}
