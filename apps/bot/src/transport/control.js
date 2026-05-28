import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { log, warn, debug } from '../logger.js';
import { getVersion } from '../version.js';
import { State } from './state.js';

const PROTO_VERSION = 1;

const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 30000;
const HB_INTERVAL_MS = 15000;
const SERVER_QUIET_TIMEOUT_MS = 30000;
const APP_PING_INTERVAL_MS = 30000;
const HANDSHAKE_TIMEOUT_MS = 10000;

function jitter(ms) { return Math.round(ms * (0.8 + Math.random() * 0.4)); }
function backoff(attempt) {
  return jitter(Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt)));
}

export class ControlClient extends EventEmitter {
  constructor({ baseUrl, bearer, botId, fsm }) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.bearer = bearer || null;
    this.botId = botId || randomUUID();
    this.fsm = fsm;

    this.ws = null;
    this.attempt = 0;
    this.stopped = false;
    this.giveUp = false;

    this.serverParams = null;
    this.serverInfo = null;

    // NTP-style clock offset estimate (serverClock − botClock, ms), smoothed
    // with an EMA over app-ping round-trips. Bot time is authoritative; this is
    // reported to the server so finalize can map server-stamped event
    // timestamps onto the bot timeline. null until the first measurement.
    this.clockOffsetMs = null;

    this.lastServerMsgAt = 0;
    this.hbTimer = null;
    this.appPingTimer = null;
    this.quietTimer = null;
    this.handshakeTimer = null;
    this.reconnectTimer = null;

    this.pendingSession = null;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this._clearTimers();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.close(1000, 'bye'); } catch {}
      this.ws = null;
    }
    this.fsm.set(State.DISCONNECTED);
  }

  ack(cmdId, ok = true, error, extra = {}) {
    const msg = { type: 'ack', cmdId, ok, ...extra };
    if (error) msg.error = error;
    this._send(msg);
  }

  // sessionInfo: { sessionId: string(numeric), guildId, channelId, startedAt }
  sessionStart(sessionInfo) {
    this.pendingSession = sessionInfo;
    this._sendIfReady({ type: 'session_start', cmdId: randomUUID(), ...sessionInfo });
  }

  sessionEnd(sessionId) {
    if (this.pendingSession && this.pendingSession.sessionId === sessionId) {
      this.pendingSession = null;
    }
    this._sendIfReady({ type: 'session_end', cmdId: randomUUID(), sessionId });
  }

  // Notify the server that a speaker's utterance has finished.
  // { sessionId: string, userId: string, durationMs: number }
  sendUtteranceEnd({ sessionId, userId, durationMs, startTsMs, endTsMs, userDisplayName }) {
    this._sendIfReady({ type: 'utterance_end', cmdId: randomUUID(), sessionId, userId, durationMs, startTsMs, endTsMs, userDisplayName });
  }

  playbackEvent(event) {
    this._sendIfReady({ type: 'playback_event', cmdId: randomUUID(), ...event });
  }

  // Voice-channel presence signal driving the server-side idle/auto-finalize
  // timer. state ∈ 'joined' | 'left' | 'alone' | 'occupied'.
  voiceState({ sessionId, state }) {
    this._sendIfReady({ type: 'voice_state', cmdId: randomUUID(), sessionId, state });
  }

  debugTts({ sessionId, text }) {
    this._sendIfReady({ type: 'debug_tts', cmdId: randomUUID(), sessionId, text });
  }

  textQuery({ sessionId, question, tts = false, channelId, userId, userDisplayName, source = 'slash' }) {
    return this._sendIfReady({
      type: 'text_query',
      cmdId: randomUUID(),
      sessionId,
      question,
      tts,
      channelId,
      userId,
      userDisplayName,
      source,
    });
  }

  _sendIfReady(obj) {
    if (!this.fsm.is(State.READY)) {
      debug('control: drop send (not ready)', obj.type);
      return false;
    }
    return this._send(obj);
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; }
    catch (e) { warn('control send failed:', e.message); return false; }
  }

  _connect() {
    if (this.stopped || this.giveUp) return;
    this.fsm.set(State.CONNECTING);

    const url = `${this.baseUrl}/control`;
    const headers = this.bearer ? { Authorization: `Bearer ${this.bearer}` } : {};
    debug('control: connecting to', url, 'attempt', this.attempt);
    let ws;
    try {
      ws = new WebSocket(url, { headers });
    } catch (e) {
      warn('control: ws ctor threw:', e.message);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    // Bail out quickly when the server is unreachable so backoff cycles fast.
    const connectTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        debug('control: connect timeout, terminating');
        ws.terminate();
      }
    }, 8000);
    ws.once('open',  () => clearTimeout(connectTimeout));
    ws.once('close', () => clearTimeout(connectTimeout));

    ws.on('open', () => {
      debug('control: socket open, awaiting hello');
      this.fsm.set(State.REGISTERING);
      this.handshakeTimer = setTimeout(() => {
        warn('control: handshake timeout');
        try { ws.close(4000, 'HANDSHAKE_TIMEOUT'); } catch {}
      }, HANDSHAKE_TIMEOUT_MS);
    });

    ws.on('message', (data) => {
      this.lastServerMsgAt = Date.now();
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch (e) { warn('control: bad json from server:', e.message); return; }
      this._onMessage(msg);
    });

    ws.on('pong', () => { this.lastServerMsgAt = Date.now(); });

    ws.on('close', (code, reason) => {
      const r = reason && reason.toString();
      log('control: closed', code, r || '');
      this._clearTimers();
      this.ws = null;

      if (code === 4002) {
        warn('control: PROTO_MISMATCH — refusing to reconnect');
        this.giveUp = true;
        this.fsm.set(State.DISCONNECTED);
        return;
      }
      if (code === 4001) warn('control: AUTH_FAILED');
      this._scheduleReconnect();
    });

    ws.on('error', (e) => {
      if (/401|unauthorized/i.test(e.message)) warn('control: AUTH_FAILED (bad bearer)');
      // 'close' will follow; just log here.
      debug('control: ws error:', e.message);
    });
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'hello': {
        if (typeof msg.protoVersion === 'number' && msg.protoVersion !== PROTO_VERSION) {
          warn(`control: server protoVersion ${msg.protoVersion} != client ${PROTO_VERSION}`);
          try { this.ws.close(4002, 'PROTO_MISMATCH'); } catch {}
          return;
        }
        this.serverInfo = { serverId: msg.serverId, version: msg.version, protoVersion: msg.protoVersion };
        this.emit('serverHello', this.serverInfo);
        this._send({
          type: 'register',
          botId: this.botId,
          version: getVersion(),
          protoVersion: PROTO_VERSION,
          capabilities: ['uplink', 'downlink'],
          t: Date.now(),
        });
        return;
      }
      case 'registered': {
        if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
        this.serverParams = msg.serverParams || {};
        this.attempt = 0;
        this.fsm.set(State.READY);
        log('control: registered, params=', JSON.stringify(this.serverParams));
        this._startHeartbeats();
        if (this.pendingSession) {
          debug('control: re-emitting session_start after reconnect');
          this._send({ type: 'session_start', cmdId: randomUUID(), ...this.pendingSession });
        }
        return;
      }
      case 'pong': {
        if (typeof msg.t === 'number') {
          const now = Date.now();
          const rtt = now - msg.t;
          debug(`control: app rtt ${rtt}ms`);
          // Estimate clock offset when the server echoed its receive-time.
          // Server received the ping at ≈ msg.t + rtt/2 on the bot clock.
          if (typeof msg.srvT === 'number') {
            const sample = msg.srvT - (msg.t + rtt / 2);
            // EMA (α=0.2) once seeded; ignore wild samples from rare RTT spikes.
            this.clockOffsetMs = this.clockOffsetMs === null
              ? sample
              : 0.8 * this.clockOffsetMs + 0.2 * sample;
            this._send({ type: 'clock_sync', offsetMs: Math.round(this.clockOffsetMs), rttMs: rtt });
          }
        }
        return;
      }
      case 'ack': {
        debug('control: ack', msg.op, 'cmdId', msg.cmdId, 'ok=', msg.ok, msg.error || '');
        return;
      }
      case 'error': {
        warn('control: server error', msg.code, msg.message || '', 'cmdId=', msg.cmdId);
        return;
      }
      // Server→bot commands: dispatch to transport/index.js via event.
      // The listener is expected to call this.ack(cmdId, ok, error?) when done.
      case 'say':
      case 'play':
      case 'play_test_tone':
      case 'set_params':
      case 'save_session':
      case 'stop_playback':
      case 'chat_message': {
        debug('control: server command:', msg.type);
        this.emit('serverCommand', msg);
        return;
      }
      default:
        debug('control: unknown msg type', msg.type);
    }
  }

  _startHeartbeats() {
    this._clearTimers();

    this.hbTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try { this.ws.ping(); } catch (e) { debug('control: ping err', e.message); }
    }, HB_INTERVAL_MS);
    this.hbTimer.unref?.();

    this.appPingTimer = setInterval(() => {
      this._send({ type: 'ping', t: Date.now() });
    }, APP_PING_INTERVAL_MS);
    this.appPingTimer.unref?.();

    this.quietTimer = setInterval(() => {
      if (!this.ws) return;
      const since = Date.now() - this.lastServerMsgAt;
      if (since > SERVER_QUIET_TIMEOUT_MS) {
        warn(`control: server quiet for ${since}ms, terminating`);
        try { this.ws.terminate(); } catch {}
      }
    }, HB_INTERVAL_MS);
    this.quietTimer.unref?.();
  }

  _clearTimers() {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    if (this.appPingTimer) { clearInterval(this.appPingTimer); this.appPingTimer = null; }
    if (this.quietTimer) { clearInterval(this.quietTimer); this.quietTimer = null; }
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
  }

  _scheduleReconnect() {
    if (this.stopped || this.giveUp) {
      this.fsm.set(State.DISCONNECTED);
      return;
    }
    this.fsm.set(State.BACKOFF);
    const delay = backoff(this.attempt);
    this.attempt++;
    debug(`control: reconnect in ${delay}ms (attempt ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
