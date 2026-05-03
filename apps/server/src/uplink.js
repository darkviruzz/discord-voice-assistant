import { WebSocketServer } from 'ws';
import { MAGIC_UPLK, parseFrame } from './protocol.js';
import { ensureSpeaker, sessions } from './state.js';
import { pickProtocolFor } from './auth.js';
import { debug, log, warn } from './logger.js';

// Drain and return all buffered Opus frames for a speaker, then clear the buffer.
// sessionId and userId may be string or BigInt.
export function drainBuffer(sessionId, userId) {
  const s = sessions.get(BigInt(sessionId));
  if (!s) return [];
  const sp = s.speakers.get(BigInt(userId));
  if (!sp || !sp.opusBuffer) return [];
  const frames = sp.opusBuffer.splice(0);
  return frames;
}

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

    // Track which (sessionId, userId) pairs this connection owns so we can
    // clean them up on close. One uplink connection may serve one speaker.
    let ownedSession = null;
    let ownedUser    = null;

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      try {
        const f = parseFrame(Buffer.from(data));
        if (!f.magic.equals(MAGIC_UPLK)) return;
        const sp = ensureSpeaker(f.sessionId, f.userId);
        sp.codec  ??= f.codec;
        sp.frames++;
        sp.lastSeq = f.seq;
        // Buffer raw Opus payload for pipeline processing.
        if (!sp.opusBuffer) sp.opusBuffer = [];
        sp.opusBuffer.push(Buffer.from(f.payload)); // no cap — chunked STT handles long audio
        // Remember the first session/user this connection contributed to.
        if (!ownedSession) {
          ownedSession = f.sessionId;
          ownedUser    = f.userId;
          log('uplink: first frame userId=', f.userId.toString(), 'sessionId=', f.sessionId.toString());
        }
        if ((sp.frames % 100) === 0) debug('speaker frames', f.userId.toString(), sp.frames);
      } catch (e) {
        warn('uplink parse error:', e.message);
      }
    });

    ws.on('close', () => {
      debug('uplink closed');
      if (ownedSession) {
        const s = sessions.get(ownedSession);
        if (s) s.speakers.delete(ownedUser);
      }
    });
    ws.on('error', (e) => warn('uplink ws error:', e.message));
  });

  log('uplink ws ready');
  return wss;
}
