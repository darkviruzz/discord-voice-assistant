import { WebSocketServer } from 'ws';
import { MAGIC_DNLK, buildFrame } from './protocol.js';
import { ensureSession } from './state.js';
import { log, debug } from './logger.js';
import { OpusEncoder } from '@discordjs/opus';

// Downlink-Verteiler: Bots subscriben per Text-JSON auf eine Session
export function initDownlinkWSS(server, { path = '/downlink' } = {}) {
  const wss = new WebSocketServer({ server, path });
  wss.on('connection', (ws) => {
    let sessionId = null;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // Downlink empfängt nur Steuer-JSON vom Bot (Subscribe)
      try {
        const msg = JSON.parse(data.toString());
        if (msg.subscribe && typeof msg.sessionId === 'string') {
          sessionId = BigInt(msg.sessionId);
          const s = ensureSession(sessionId);
          s.downlinks.add(ws);
          debug('downlink subscribed', sessionId.toString());
        }
      } catch {}
    });
    ws.on('close', () => {
      if (sessionId) {
        const s = ensureSession(sessionId);
        s.downlinks.delete(ws);
      }
    });
  });
  log('downlink ws ready at', path);
  return wss;
}

// Beispiel: 1 s 440 Hz Testton in 20 ms Opus-Frames an alle Bots der Session
export async function sendTestTone(sessionId) {
  const s = ensureSession(sessionId);
  if (!s) return;
  const enc = new OpusEncoder(48000, 1);
  const frameSamples = 960; // 20 ms @ 48k
  const totalFrames = 50;   // ~1 s
  const frames = [];
  for (let i = 0; i < totalFrames; i++) {
    const pcm = Buffer.alloc(frameSamples * 2);
    for (let n = 0; n < frameSamples; n++) {
      const t = (i * frameSamples + n) / 48000;
      const sample = Math.round(Math.sin(2 * Math.PI * 440 * t) * 2000);
      pcm.writeInt16LE(sample, n * 2);
    }
    frames.push(Buffer.from(enc.encode(pcm)));
  }
  let seq = 0; const ts0 = Date.now();
  for (const ws of s.downlinks) {
    for (let i = 0; i < frames.length; i++) {
      const pkt = buildFrame({
        magic: MAGIC_DNLK, codec: 'opus',
        sessionId, userId: 0n, seq: seq++, tsMs: ts0 + i * 20, payload: frames[i]
      });
      ws.send(pkt, { binary: true });
    }
  }
  debug('test tone sent to session', sessionId.toString());
}
