import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { ensureSession } from './state.js';
import { log, debug } from './logger.js';
import opus from '@discordjs/opus';
const { OpusEncoder } = opus;

// Downlink-Verteiler: Bots subscriben per Text-JSON auf eine Session
export function initDownlinkWSS({} = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let sessionId = null;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // Downlink empfängt nur Steuer-JSON vom Bot (Subscribe)
      try {
        const msg = JSON.parse(data.toString());
        if (msg.subscribe && typeof msg.sessionId === 'string' && /^\d+$/.test(msg.sessionId)) {
          // Remove from any previous session before re-subscribing.
          if (sessionId) {
            const prev = ensureSession(sessionId);
            prev.downlinks.delete(ws);
          }
          sessionId = BigInt(msg.sessionId);
          const s = ensureSession(sessionId);
          s.downlinks.add(ws);
          debug('downlink subscribed', sessionId.toString());
        }
      } catch (e) { debug('downlink msg parse error:', e.message); }
    });
    ws.on('close', () => {
      if (sessionId) {
        const s = ensureSession(sessionId);
        s.downlinks.delete(ws);
      }
    });
  });
  log('downlink ws ready');
  return wss;
}

function sendJson(ws, obj) {
  if (ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

// Beispiel: 1 s 440 Hz Testton in 20 ms Opus-Frames an alle Bots der Session.
// Uses the same JSON tts_start / tts_frame / tts_done path as Piper TTS.
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
    frames.push(Buffer.from(enc.encode(pcm, frameSamples)));
  }
  const id = `tone-${randomUUID()}`;
  for (const ws of s.downlinks) {
    if (!sendJson(ws, { type: 'tts_start', id })) continue;
    for (let i = 0; i < frames.length; i++) {
      sendJson(ws, {
        type: 'tts_frame',
        id,
        seq: i,
        payload: frames[i].toString('base64'),
      });
    }
    sendJson(ws, { type: 'tts_done', id });
  }
  debug('test tone sent to session', sessionId.toString(), 'frames=', frames.length);
}
