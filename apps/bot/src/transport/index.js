import { TransportState, State } from './state.js';
import { ControlClient } from './control.js';
import { UplinkClient } from './uplink.js';
import { DownlinkClient } from './downlink.js';
import { log, warn, debug } from '../logger.js';
import { ensureServerReachable } from '../serverAutoStart.js';
import { writeTranscriptEvent } from '../transcriptWriter.js';

// How long the transport may sit outside READY during an active session
// before we re-run SERVER_START_CMD (e.g. a spot instance got reclaimed —
// the control socket's own reconnect loop only ever retries the SAME
// address, it never spins up a replacement server).
const WATCHDOG_THRESHOLD_MS = Number(process.env.SERVER_WATCHDOG_THRESHOLD_MS) || 90_000;
// Minimum gap between watchdog-triggered restart attempts, so a persistent
// failure doesn't hammer SERVER_START_CMD (and whatever cloud API it calls).
const WATCHDOG_COOLDOWN_MS = Number(process.env.SERVER_WATCHDOG_COOLDOWN_MS) || 300_000;

let _instance = null;
let _chatMessageCallback = null;
let _serverInfoCallback = null;
let _finalizeRequestCallback = null;
// Supplied by index.js at start() — true while the bot is actively in a voice
// channel with an open session (same signal scheduleServerStop/scheduleIdleRelease
// use). The watchdog below gates on THIS, not on currentSessionId: a session
// deliberately stays "open" (currentSessionId set) across /leave for later
// /join resumption, so gating on it alone kept re-running SERVER_START_CMD
// long after nobody was even in voice anymore.
let _isSessionActive = () => false;

// Server-initiated finalize (idle auto-finalize). cb receives { sessionId, reason }.
export function onFinalizeRequest(cb) {
  _finalizeRequestCallback = cb;
}

export function onChatMessage(cb) {
  _chatMessageCallback = cb;
}

// Notifies on server-version changes: { connected: true, version, serverId } on hello,
// { connected: false } when transport leaves READY (lost server). Fires the latest
// known state immediately if subscribed late.
export function onServerInfo(cb) {
  _serverInfoCallback = cb;
  if (!cb || !_instance) return;
  if (_instance.fsm.is(State.READY) && _instance.control.serverInfo) {
    cb({ connected: true, ..._instance.control.serverInfo });
  } else {
    cb({ connected: false });
  }
}

function deriveBaseUrl() {
  if (process.env.SERVER_BASE_URL) return process.env.SERVER_BASE_URL.replace(/\/+$/, '');
  if (process.env.CONTROL_WS_URL) return process.env.CONTROL_WS_URL.replace(/\/control\/?$/, '').replace(/\/+$/, '');
  return null;
}

export function start({ botId, isSessionActive } = {}) {
  if (_instance) return _instance;
  if (isSessionActive) _isSessionActive = isSessionActive;
  const baseUrl = deriveBaseUrl();
  if (!baseUrl) {
    log('transport: no SERVER_BASE_URL set — running standalone (no server link)');
    return null;
  }
  const bearer = process.env.CONTROL_BEARER || null;
  const params = {
    gateMs:         Number(process.env.GATE_MS           ?? 80),
    playoutMaxMs:   Number(process.env.PLAYOUT_MAX_MS    ?? 1500),
    interruptMinMs: Number(process.env.INTERRUPT_MIN_MS  ?? 800),
    resumeGateMs:   Number(process.env.RESUME_GATE_MS    ?? 1200),
    rewindMs:       Number(process.env.REWIND_MS         ?? 1000),
  };

  const fsm      = new TransportState();
  const uplink   = new UplinkClient({ baseUrl, bearer });
  const downlink = new DownlinkClient({ baseUrl, bearer, params });
  const control  = new ControlClient({ baseUrl, bearer, botId, fsm });
  downlink.setPlaybackEventHandler((event) => control.playbackEvent(event));

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

  // Fire serverInfo callback on hello and on state-leaving-READY.
  control.on('serverHello', (info) => {
    if (_serverInfoCallback) _serverInfoCallback({ connected: true, ...info });
  });
  fsm.on('change', (next, prev) => {
    if (prev === State.READY && next !== State.READY) {
      if (_serverInfoCallback) _serverInfoCallback({ connected: false });
    }
  });

  // Watchdog: the control socket's own reconnect loop only ever retries the
  // same SERVER_BASE_URL — it has no notion of "the server is gone for good
  // and a replacement needs to be launched" (e.g. a reclaimed spot instance).
  // If we're unreachable for a while while someone is actively in voice, re-run
  // SERVER_START_CMD via the same ensureServerReachable() used on /join. Gated
  // on _isSessionActive(), NOT currentSessionId: a session stays "open"
  // (currentSessionId set) across /leave so it can resume on the next /join,
  // so gating on it alone kept re-launching a cloud instance long after
  // everyone had already left voice.
  let lastReadyAt = Date.now();
  let lastRestartAttemptAt = 0;
  fsm.on('change', (next) => {
    if (next === State.READY) lastReadyAt = Date.now();
  });
  const watchdogTimer = setInterval(() => {
    if (!_isSessionActive() || fsm.is(State.READY)) return;
    const now = Date.now();
    if (now - lastReadyAt < WATCHDOG_THRESHOLD_MS) return;
    if (now - lastRestartAttemptAt < WATCHDOG_COOLDOWN_MS) return;
    lastRestartAttemptAt = now;
    warn(`transport: unreachable for >${WATCHDOG_THRESHOLD_MS}ms during an active session — re-running SERVER_START_CMD`);
    ensureServerReachable().catch((e) => warn('transport watchdog:', e.message));
  }, 15_000);
  watchdogTimer.unref?.();

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
          interruptMinMs: msg.interruptMinMs,
          resumeGateMs:   msg.resumeGateMs,
          rewindMs:       msg.rewindMs,
        });
        control.ack(msg.cmdId, true);
        break;
      case 'stop_playback':
        control.ack(msg.cmdId, true, null, { playback: downlink.stopPlayback() });
        break;
      case 'chat_message':
        if (_chatMessageCallback) _chatMessageCallback(msg);
        control.ack(msg.cmdId, true);
        break;
      case 'finalize_request':
        control.ack(msg.cmdId, true);
        if (_finalizeRequestCallback) _finalizeRequestCallback({ sessionId: msg.sessionId, reason: msg.reason });
        break;
      case 'transcript_event':
        writeTranscriptEvent(msg.sessionId, msg.event);
        control.ack(msg.cmdId, true);
        break;
      default:
        debug('transport: unhandled server command', msg.type);
        control.ack(msg.cmdId, false, 'NOT_IMPLEMENTED');
    }
  });

  // NOTE: we do NOT auto-connect here. The control link is opened lazily via
  // connect()/ensureConnected() (on /join or an on-demand /ask) and closed via
  // disconnect() (on /leave) so an idle bot keeps no server link — no endless
  // reconnect attempts and no periodic app-rtt pings while out of voice. The
  // watchdog above is a no-op until _isSessionActive() is true (i.e. someone
  // is actually in voice), so it stays dormant during this idle period too.
  _instance = { fsm, control, uplink, downlink, baseUrl, currentSessionId: null, idleReleaseTimer: null, watchdogTimer };
  return _instance;
}

// Open the control link (idempotent — control.start() resets backoff and is a
// no-op while already connecting/connected).
export function connect() {
  if (!_instance) return;
  cancelIdleRelease();
  // Only kick off a fresh connect from a clean stop; if we're already
  // connecting/backing-off/ready, control is handling it (avoid a 2nd socket).
  if (_instance.fsm.is(State.DISCONNECTED)) _instance.control.start();
}

// Close the control link and stop reconnecting (uplink/downlink close via the
// FSM leaving READY). Used when the bot is no longer in a voice session.
export function disconnect() {
  if (!_instance) return;
  cancelIdleRelease();
  try { _instance.control.stop(); } catch (e) { warn('transport.disconnect:', e.message); }
}

export function isConnected() {
  return !!_instance && _instance.fsm.is(State.READY);
}

export function serverVersion() {
  return _instance?.control?.serverInfo?.version ?? null;
}

// Connect (if needed) and resolve once the control link is READY, or reject on
// timeout. Used by /join and on-demand by /ask when no session is active.
export function ensureConnected({ timeoutMs = 12000 } = {}) {
  if (!_instance) return Promise.reject(new Error('Transport nicht initialisiert (kein SERVER_BASE_URL)'));
  if (_instance.fsm.is(State.READY)) return Promise.resolve();
  connect();
  return new Promise((resolve, reject) => {
    const onChange = (next) => {
      if (next === State.READY) { cleanup(); resolve(); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Server nicht erreichbar (Timeout)')); }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const cleanup = () => { clearTimeout(timer); _instance.fsm.off('change', onChange); };
    _instance.fsm.on('change', onChange);
  });
}

// Disconnect after a grace period IF no session is keeping the link alive.
// `hasWork()` is supplied by the caller (index.js knows about active sessions)
// and re-checked when the timer fires, so a /join during the grace window keeps
// the connection. Calling connect()/disconnect() cancels a pending release.
export function scheduleIdleRelease({ delayMs = 60000, hasWork = () => false } = {}) {
  if (!_instance) return;
  cancelIdleRelease();
  _instance.idleReleaseTimer = setTimeout(() => {
    _instance.idleReleaseTimer = null;
    if (!hasWork()) disconnect();
  }, delayMs);
  if (typeof _instance.idleReleaseTimer.unref === 'function') _instance.idleReleaseTimer.unref();
}

export function cancelIdleRelease() {
  if (_instance?.idleReleaseTimer) {
    clearTimeout(_instance.idleReleaseTimer);
    _instance.idleReleaseTimer = null;
  }
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

export function voiceState({ sessionId, state } = {}) {
  if (!_instance) return;
  try { _instance.control.voiceState({ sessionId, state }); }
  catch (e) { warn('transport.voiceState:', e.message); }
}

export function voiceMember({ sessionId, userId, displayName, state } = {}) {
  if (!_instance) return;
  try { _instance.control.voiceMember({ sessionId, userId, displayName, state }); }
  catch (e) { warn('transport.voiceMember:', e.message); }
}

export function sendUtteranceEnd({ sessionId, userId, durationMs, startTsMs, endTsMs, userDisplayName }) {
  if (!_instance) return;
  try { _instance.control.sendUtteranceEnd({ sessionId, userId, durationMs, startTsMs, endTsMs, userDisplayName }); }
  catch (e) { warn('transport.sendUtteranceEnd:', e.message); }
}

export function debugTts({ sessionId, text } = {}) {
  if (!_instance) return;
  const sid = sessionId ?? _instance.currentSessionId;
  if (!sid) {
    warn('transport.debugTts: no active session');
    return;
  }
  try { _instance.control.debugTts({ sessionId: sid, text }); }
  catch (e) { warn('transport.debugTts:', e.message); }
}

export function textQuery({ question, tts = false, channelId, userId, userDisplayName, source = 'slash' } = {}) {
  if (!_instance) return false;
  const sessionId = _instance.currentSessionId ?? undefined;
  try {
    return _instance.control.textQuery({
      sessionId,
      question,
      tts,
      channelId,
      userId,
      userDisplayName,
      source,
    });
  } catch (e) {
    warn('transport.textQuery:', e.message);
    return false;
  }
}

export function finalizePrepare(sessionId) {
  if (!_instance) return Promise.reject(new Error('Transport nicht initialisiert'));
  return _instance.control.finalizePrepare(sessionId);
}

export function finalizeSession(payload, opts) {
  if (!_instance) return Promise.reject(new Error('Transport nicht initialisiert'));
  return _instance.control.finalizeSession(payload, opts);
}

export function onFinalizeProgress(cb) {
  if (!_instance) return;
  _instance.control.on('finalizeProgress', cb);
}

export function getSpeakerMap(guildId) {
  if (!_instance) return Promise.reject(new Error('Transport nicht initialisiert'));
  return _instance.control.speakerMapGet(guildId);
}

export function setSpeakerMapping(guildId, userId, entry) {
  if (!_instance) return Promise.reject(new Error('Transport nicht initialisiert'));
  return _instance.control.speakerMapSet(guildId, userId, entry);
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
  try { clearInterval(_instance.watchdogTimer); } catch {}
  try { _instance.control.stop(); } catch {}
  try { _instance.uplink.close(); } catch {}
  try { _instance.downlink.close(); } catch {}
  _instance = null;
}

export { State };
