import { WebSocketServer } from 'ws';
import { log, debug, warn } from './logger.js';
import { sendTestTone } from './downlink.js';

// Einfache Control-WS (JSON). Auth via Sec-WebSocket-Protocol oder Authorization-Header.
export function initControlWSS(server, { path = '/control', bearer } = {}) {
  const wss = new WebSocketServer({
    server, path,
    verifyClient: (info, cb) => {
      if (!bearer) return cb(true);
      const proto = info.req.headers['sec-websocket-protocol'] || '';
      const auth  = info.req.headers['authorization'] || '';
      if ((typeof proto === 'string' && proto.includes(bearer)) || (typeof auth === 'string' && auth.includes(bearer))) cb(true);
      else cb(false, 401, 'Unauthorized');
    }
  });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', t: Date.now() }));
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          return ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
        }
        if (msg.type === 'play_test_tone' && typeof msg.sessionId === 'string') {
          await sendTestTone(BigInt(msg.sessionId));
          return ws.send(JSON.stringify({ type: 'ok', op: 'play_test_tone' }));
        }
        // TODO: say / play / save_session / set_params
      } catch (e) { warn('control msg err', e.message); }
    });
  });

  log('control ws ready at', path);
  return wss;
}
