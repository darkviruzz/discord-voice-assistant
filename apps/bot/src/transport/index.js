import { TransportState, State } from './state.js';
import { ControlClient } from './control.js';
import { UplinkClient } from './uplink.js';
import { DownlinkClient } from './downlink.js';
import { log, warn, debug } from '../logger.js';

let _instance = null;
let _chatMessageCallback = null;

export function onChatMessage(cb) {
  _chatMessageCallback = cb;
}

function deriveBaseUrl() {
  if (process.env.SERVER_BASE_URL) return process.env.SERVER_BASE_URL.replace(/\/+$/, '');
  if (process.env.CONTROL_WS_URL) return process.env.CONTROL_WS_URL.replace(/\/control\/?$/, '').replace(/\/+$/, '');
  return null;
}

export function start({ botId } = {}) {
  if (_instance) return _instance;
  const baseUrl = deriveBaseUrl();
  if (!baseUrl) {
    log('transport: no SERVER_BASE_URL set — running standalone (no server link)');
    return null;
  }
  const bearer = process.env.CONTROL_BEARER || null;
  const params = {
    gateMs:       Number(process.env.GATE_MS        ?? 80),
    playoutMaxMs: Number(process.env.PLAYOUT_MAX_MS ?? 1500),
  };

  const fsm      = new TransportState();
  const uplink   = new UplinkClient({ baseUrl, bearer });
  const downlink = new DownlinkClient({ baseUrl, bearer, params });
  const control  = new ControlClient({ baseUrl, bearer, botId, fsm });

  fsm.on('change', (next, prev) => log(`transport: ${prev} -> ${next}`));

  // Open/close uplink and downlink in lockstep with the FSM.
  fsm.on('change', (next) => {
    if (next === State.READY) {
      uplink.open();
      if (_instance?.currentSessionId) downlink.open(_instance.currentSessionId);
    } else {
      uplink.close();
      downlink.close();
    }
  });

  // Route server→bot commands from the control plane.
  control.on('serverCommand', (msg) => {
    switch (msg.type) {
      case 'play_test_tone':
        // Server already generated and sent frames to the downlink WS.
        // Nothing to do on the bot side — frames arrive via WS automatically.
        control.ack(msg.cmdId, true);
        break;
      case 'set_params':
        downlink.setParams({
          gateMs:       msg.gateMs,
          playoutMaxMs: msg.playoutMaxMs,
        });
        control.ack(msg.cmdId, true);
        break;
      case 'stop_playback':
        downlink.stopPlayback();
        control.ack(msg.cmdId, true);
        break;
      case 'chat_message':
        if (_chatMessageCallback) _chatMessageCallback(msg);
        control.ack(msg.cmdId, true);
        break;
      default:
        debug('transport: unhandled server command', msg.type);
        control.ack(msg.cmdId, false, 'NOT_IMPLEMENTED');
    }
  });

  control.start();

  _instance = { fsm, control, uplink, downlink, baseUrl, currentSessionId: null };
  return _instance;
}

export function sessionStart(info) {
  if (!_instance) return;
  _instance.currentSessionId = info.sessionId;
  try { _instance.control.sessionStart(info); } catch (e) { warn('transport.sessionStart:', e.message); }
  if (_instance.fsm.is(State.READY)) {
    _instance.downlink.open(info.sessionId);
  }
}

export function sessionEnd(sessionId) {
  if (!_instance) return;
  _instance.currentSessionId = null;
  try { _instance.control.sessionEnd(sessionId); } catch (e) { warn('transport.sessionEnd:', e.message); }
  _instance.downlink.close();
}

export function sendUplinkFrame({ sessionId, userId, tsMs, opus }) {
  if (!_instance) return;
  try { _instance.uplink.sendFrame({ sessionId, userId, tsMs, opus }); }
  catch (e) { warn('transport.sendUplinkFrame:', e.message); }
}

export function sendUtteranceEnd({ sessionId, userId, durationMs }) {
  if (!_instance) return;
  try { _instance.control.sendUtteranceEnd({ sessionId, userId, durationMs }); }
  catch (e) { warn('transport.sendUtteranceEnd:', e.message); }
}

export function setVoiceConnection(conn) {
  if (!_instance) return;
  try { _instance.downlink.setVoiceConnection(conn); }
  catch (e) { warn('transport.setVoiceConnection:', e.message); }
}

export function clearVoiceConnection() {
  if (!_instance) return;
  try { _instance.downlink.clearVoiceConnection(); }
  catch (e) { warn('transport.clearVoiceConnection:', e.message); }
}

export function speakingStart(userId) {
  if (!_instance) return;
  _instance.downlink.speakingStart(userId);
}

export function speakingEnd(userId) {
  if (!_instance) return;
  _instance.downlink.speakingEnd(userId);
}

export function stop() {
  if (!_instance) return;
  try { _instance.control.stop(); } catch {}
  try { _instance.uplink.close(); } catch {}
  try { _instance.downlink.close(); } catch {}
  _instance = null;
}

export { State };
