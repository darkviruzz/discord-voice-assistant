import { TransportState, State } from './state.js';
import { ControlClient } from './control.js';
import { UplinkClient } from './uplink.js';
import { log, warn } from '../logger.js';

let _instance = null;

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
  const fsm = new TransportState();
  fsm.on('change', (next, prev) => log(`transport: ${prev} -> ${next}`));

  const uplink = new UplinkClient({ baseUrl, bearer });
  const control = new ControlClient({ baseUrl, bearer, botId, fsm });

  // Open uplink as soon as the control plane is READY; close it whenever we
  // drop off (BACKOFF/DISCONNECTED). The uplink WS itself has no heartbeat —
  // the server's global ping/pong loop covers it.
  fsm.on('change', (next) => {
    if (next === State.READY) uplink.open();
    else uplink.close();
  });

  control.start();

  _instance = { fsm, control, uplink, baseUrl };
  return _instance;
}

export function sessionStart(info) {
  if (!_instance) return;
  try { _instance.control.sessionStart(info); }
  catch (e) { warn('transport.sessionStart failed:', e.message); }
}

export function sessionEnd(sessionId) {
  if (!_instance) return;
  try { _instance.control.sessionEnd(sessionId); }
  catch (e) { warn('transport.sessionEnd failed:', e.message); }
}

// Called from UtteranceRecorder for each raw Opus packet.
// sessionId and userId are strings; opus is a Buffer.
export function sendUplinkFrame({ sessionId, userId, tsMs, opus }) {
  if (!_instance) return;
  try { _instance.uplink.sendFrame({ sessionId, userId, tsMs, opus }); }
  catch (e) { warn('transport.sendUplinkFrame failed:', e.message); }
}

export function stop() {
  if (!_instance) return;
  try { _instance.control.stop(); } catch {}
  try { _instance.uplink.close(); } catch {}
  _instance = null;
}

export { State };
