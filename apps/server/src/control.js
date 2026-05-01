import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { log, debug, warn } from './logger.js';
import { sendTestTone } from './downlink.js';
import { pickProtocolFor } from './auth.js';
import { ensureSession, dropSession } from './state.js';
import { runPipeline } from './pipeline.js';

const PROTO_VERSION = 1;
const SERVER_VERSION = '0.1.0';
const SERVER_ID = randomUUID();

// Registered bot connections — used to route server→bot commands.
const botConnections = new Set();

// Default playout/gating params advertised to bots; bots may apply them
// locally. These mirror the env-documented defaults from the README.
function serverParams() {
  return {
    gateMs:        Number(process.env.GATE_MS        ?? 200),
    jitterMs:      Number(process.env.JITTER_MS      ?? 120),
    playoutMs:     Number(process.env.PLAYOUT_MS     ?? 200),
    playoutMaxMs:  Number(process.env.PLAYOUT_MAX_MS ?? 1500),
    hbIntervalMs:  15000,
  };
}

function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) { warn('control send failed:', e.message); }
}

export function initControlWSS({ bearer } = {}) {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: pickProtocolFor(bearer),
    maxPayload: 65536,
    perMessageDeflate: false,
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let registered = false;
    let activeSessionId = null;

    send(ws, { type: 'hello', serverId: SERVER_ID, version: SERVER_VERSION, protoVersion: PROTO_VERSION, t: Date.now() });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch (e) {
        warn('control json parse:', e.message, data.toString().slice(0, 120));
        return;
      }

      try {
        switch (msg.type) {
          case 'register': {
            if (typeof msg.protoVersion === 'number' && msg.protoVersion !== PROTO_VERSION) {
              send(ws, { type: 'error', code: 'PROTO_MISMATCH', message: `expected protoVersion ${PROTO_VERSION}` });
              ws.close(4002, 'PROTO_MISMATCH');
              return;
            }
            registered = true;
            botConnections.add(ws);
            log('control: bot registered botId=', msg.botId, 'version=', msg.version);
            send(ws, { type: 'registered', serverParams: serverParams() });
            return;
          }
          case 'session_start': {
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED' }); return; }
            if (typeof msg.sessionId !== 'string' || !/^\d+$/.test(msg.sessionId)) {
              send(ws, { type: 'error', code: 'BAD_SESSION_ID', cmdId: msg.cmdId });
              return;
            }
            activeSessionId = BigInt(msg.sessionId);
            ensureSession(activeSessionId);
            log('control: session_start sid=', activeSessionId.toString(), 'guild=', msg.guildId, 'channel=', msg.channelId);
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: 'session_start' });
            return;
          }
          case 'session_end': {
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED' }); return; }
            if (typeof msg.sessionId !== 'string' || !/^\d+$/.test(msg.sessionId)) {
              send(ws, { type: 'error', code: 'BAD_SESSION_ID', cmdId: msg.cmdId });
              return;
            }
            const sid = BigInt(msg.sessionId);
            dropSession(sid);
            if (activeSessionId === sid) activeSessionId = null;
            log('control: session_end sid=', sid.toString());
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: 'session_end' });
            return;
          }
          case 'ping': {
            send(ws, { type: 'pong', t: msg.t, srvT: Date.now() });
            return;
          }
          case 'ack': {
            // Bot acknowledges a server→bot command (e.g. set_params routed from a controller).
            debug('control: bot ack', msg.cmdId, msg.ok);
            return;
          }
          case 'play_test_tone': {
            if (typeof msg.sessionId !== 'string' || !/^\d+$/.test(msg.sessionId)) {
              send(ws, { type: 'error', code: 'BAD_SESSION_ID', cmdId: msg.cmdId });
              return;
            }
            sendTestTone(BigInt(msg.sessionId)).then(
              () => send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: 'play_test_tone' }),
              (e) => send(ws, { type: 'error', code: 'TEST_TONE_FAILED', message: e.message, cmdId: msg.cmdId }),
            );
            return;
          }
          case 'set_params':
          case 'stop_playback': {
            let forwarded = 0;
            for (const botWs of botConnections) {
              if (botWs !== ws && botWs.readyState === 1 /* OPEN */) {
                send(botWs, msg);
                forwarded++;
              }
            }
            debug('control: routed', msg.type, 'to', forwarded, 'bot(s)');
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: msg.type });
            return;
          }
          case 'utterance_end': {
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED' }); return; }
            if (typeof msg.sessionId !== 'string' || !/^\d+$/.test(msg.sessionId)) {
              send(ws, { type: 'error', code: 'BAD_SESSION_ID', cmdId: msg.cmdId });
              return;
            }
            const sid = BigInt(msg.sessionId);
            const uid = BigInt(msg.userId ?? '0');
            log('control: utterance_end sid=', sid.toString(), 'userId=', uid.toString(), 'durationMs=', msg.durationMs);
            // Fire-and-forget — pipeline errors are logged internally.
            runPipeline(sid, uid).catch((e) => warn('pipeline error:', e.message));
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: 'utterance_end' });
            return;
          }
          // Phase 2/3 stubs: log and ack so the bot can develop against them.
          case 'say':
          case 'play':
          case 'save_session': {
            debug('control: stub command', msg.type);
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: false, error: 'NOT_IMPLEMENTED', op: msg.type });
            return;
          }
          default: {
            send(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: `unknown msg.type=${msg.type}`, cmdId: msg.cmdId });
            return;
          }
        }
      } catch (e) {
        warn('control dispatch error:', e.message, e.stack);
        send(ws, { type: 'error', code: 'INTERNAL', message: e.message, cmdId: msg && msg.cmdId });
      }
    });

    ws.on('close', (code, reason) => {
      botConnections.delete(ws);
      debug('control closed', code, reason && reason.toString());
    });
    ws.on('error', (e) => warn('control ws error:', e.message));
  });

  log('control ws ready');
  return wss;
}
