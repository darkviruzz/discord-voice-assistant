import { TransportState, State } from './state.js';
import { ControlClient } from './control.js';
import { log, warn } from '../logger.js';

let _instance = null;

function deriveBaseUrl() {
  if (process.env.SERVER_BASE_URL) return process.env.SERVER_BASE_URL.replace(/\/+$/, '');
  // Backwards compat with the original env layout: derive from CONTROL_WS_URL.
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

  const control = new ControlClient({ baseUrl, bearer, botId, fsm });
  control.start();

  _instance = { fsm, control, baseUrl };
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

export function stop() {
  if (!_instance) return;
  try { _instance.control.stop(); } catch {}
  _instance = null;
}

export { State };
