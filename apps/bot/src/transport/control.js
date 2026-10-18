import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { log, warn, debug } from '../logger.js';
import { getVersion } from '../version.js';
import { State } from './state.js';
import { applyConfigUpdate, reportableConfig } from '../configOverrides.js';

const PROTO_VERSION = 1;

// Link timings. Overridable per instance (constructor `timing`) so tests can run
// the reconnect/handshake paths in milliseconds; production uses these.
const DEFAULT_TIMING = Object.freeze({
  backoffBaseMs:        2000,
  backoffCapMs:         30000,
  hbIntervalMs:         15000,
  serverQuietTimeoutMs: 30000,
  appPingIntervalMs:    30000,
  handshakeTimeoutMs:   10000,
  connectTimeoutMs:     8000,
});

function jitter(ms) { return Math.round(ms * (0.8 + Math.random() * 0.4)); }

function intEnv(key, def, min) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.round(n)) : def;
}

function fmtDuration(ms) {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

// How long the bot waits for a server finalize. An inactivity timeout, not a
// fixed deadline: every finalize_progress for the session pushes the idle
// deadline out, so only a server that has gone silent on it fails the wait
// (the server sends a keepalive progress at least once a minute while a run
// lasts, also through phases without ticks of their own). The old fixed 30 min
// was too short for a 3 h session (re-STT ~25-30 min + LLM summary): the bot
// gave up and left the session open while the server finished the transcript.
// The overall cap only guards against a run that keeps ticking forever.
// Read per finalize (panel: applyMode live).
export function finalizeWaitLimits() {
  return {
    idleMs: intEnv('FINALIZE_IDLE_TIMEOUT_MS', 600_000, 120_000),
    maxMs: intEnv('FINALIZE_MAX_MS', 10_800_000, 600_000),
  };
}

export class ControlClient extends EventEmitter {
  constructor({ baseUrl, bearer, botId, fsm, timing = {} }) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.bearer = bearer || null;
    this.botId = botId || randomUUID();
    this.fsm = fsm;
    this.timing = { ...DEFAULT_TIMING, ...timing };

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
    // cmdId → { type, resolve, reject, timer, idleTimer, idleTimeoutMs,
    // sessionId, resumable, msg, needsResend } for in-flight request/response calls.
    this.pending = new Map();
  }

  _backoff(attempt) {
    const { backoffBaseMs, backoffCapMs } = this.timing;
    return jitter(Math.min(backoffCapMs, backoffBaseMs * Math.pow(2, attempt)));
  }

  // Generic request/response over the control socket, matched by cmdId.
  //
  // A reply can only arrive on the socket the request went out on, so when that
  // socket closes a plain request is rejected right away (waiting for its
  // timeout would just hang the caller — minutes for a finalize).
  //
  // `resumable` requests instead survive a dropped link: they stay pending and
  // are RE-SENT with the SAME cmdId as soon as the link is registered again.
  // The server de-duplicates per session (a re-sent finalize_session joins the
  // run already in progress, or gets its cached result) and answers the cmdId
  // it was given, so the original promise resolves. A resumable request may
  // also be issued while the link is still (re)connecting — it then goes out on
  // registration. Only a link that is stopped or gave up rejects it. The overall
  // timeout keeps running across reconnects.
  //
  // `idleTimeoutMs` adds an inactivity timeout on top: the request also fails
  // when no finalize_progress for it arrived for that long (each one restarts
  // the timer, see _notePendingProgress). It runs across reconnects too — a
  // re-sent finalize is answered with a 'joined' progress right away.
  _request(type, payload = {}, { timeoutMs = 15_000, idleTimeoutMs = 0, resumable = false } = {}) {
    const cmdId = randomUUID();
    const msg = { type, cmdId, ...payload };
    const sent = this._sendIfReady(msg);
    if (!sent && !(resumable && this._willReconnect())) {
      return Promise.reject(new Error('Server nicht verbunden'));
    }
    if (!sent) log(`control: ${type} queued until the link is registered (cmdId ${cmdId})`);
    return new Promise((resolve, reject) => {
      const p = {
        type, resolve, reject, timer: null, idleTimer: null, idleTimeoutMs,
        sessionId: payload.sessionId != null ? String(payload.sessionId) : null,
        resumable, msg: resumable ? msg : null, needsResend: !sent,
      };
      p.timer = setTimeout(() => {
        this._rejectPending(cmdId, new Error(idleTimeoutMs > 0
          ? `${type}: Timeout (Obergrenze ${fmtDuration(timeoutMs)} erreicht)`
          : `${type}: Timeout`));
      }, timeoutMs);
      p.timer.unref?.();
      this.pending.set(cmdId, p);
      if (idleTimeoutMs > 0) this._armIdleTimer(cmdId, p);
    });
  }

  // (Re)start a request's inactivity timer.
  _armIdleTimer(cmdId, p) {
    clearTimeout(p.idleTimer);
    p.idleTimer = setTimeout(() => {
      this._rejectPending(cmdId, new Error(`${p.type}: Timeout (${fmtDuration(p.idleTimeoutMs)} ohne Fortschritt vom Server)`));
    }, p.idleTimeoutMs);
    p.idleTimer.unref?.();
  }

  // A finalize_progress is a sign of life of that finalize → restart the idle
  // timer of every request waiting on it. Matched by cmdId OR sessionId: the
  // server sends progress to all bots keyed by session, and a request that
  // joined a run started by an earlier request sees that run's cmdId.
  _notePendingProgress(msg) {
    const sessionId = msg.sessionId != null ? String(msg.sessionId) : null;
    for (const [cmdId, p] of this.pending) {
      if (!(p.idleTimeoutMs > 0)) continue;
      if (cmdId === msg.cmdId || (sessionId !== null && p.sessionId === sessionId)) this._armIdleTimer(cmdId, p);
    }
  }

  // True while the link is up or on its way back (connecting, handshaking,
  // waiting out a backoff — or READY with a socket that is just closing, whose
  // close event then schedules the reconnect). DISCONNECTED means stopped,
  // never started or gave up — nothing will come back on its own.
  _willReconnect() {
    return !this.stopped && !this.giveUp && !this.fsm.is(State.DISCONNECTED);
  }

  // The socket closed but the client reconnects: plain requests can no longer be
  // answered → reject; resumable ones wait for the re-send on registration.
  _suspendPending(reason) {
    for (const [cmdId, p] of this.pending) {
      if (p.resumable) {
        p.needsResend = true;
        log(`control: ${p.type} (cmdId ${cmdId}) kept pending across reconnect`);
        continue;
      }
      this._rejectPending(cmdId, new Error(`Server-Verbindung unterbrochen (${p.type}${reason ? `: ${reason}` : ''})`));
    }
  }

  // Re-send resumable requests after a reconnect, with their original cmdId.
  _resendPending() {
    for (const [cmdId, p] of this.pending) {
      if (!p.resumable || !p.needsResend) continue;
      if (this._send(p.msg)) {
        p.needsResend = false;
        log(`control: re-sent ${p.type} (cmdId ${cmdId}) after reconnect`);
      }
    }
  }

  // The link is gone for good (stop() / PROTO_MISMATCH) → nothing can be answered.
  _failAllPending(err) {
    for (const cmdId of [...this.pending.keys()]) this._rejectPending(cmdId, err);
  }

  _resolvePending(cmdId, value) {
    const p = this.pending.get(cmdId);
    if (!p) return false;
    clearTimeout(p.timer);
    clearTimeout(p.idleTimer);
    this.pending.delete(cmdId);
    p.resolve(value);
    return true;
  }

  _rejectPending(cmdId, err) {
    const p = this.pending.get(cmdId);
    if (!p) return false;
    clearTimeout(p.timer);
    clearTimeout(p.idleTimer);
    this.pending.delete(cmdId);
    p.reject(err);
    return true;
  }

  // Explicit (re)start — a fresh attempt: resets the backoff and a previous
  // PROTO_MISMATCH give-up (e.g. hit once during a rolling server update; before
  // this reset the bot could never reconnect again until a process restart, not
  // even via /join). Idempotent: no 2nd socket while one is connecting/
  // registering/ready; while waiting out a backoff it reconnects immediately.
  start() {
    this.stopped = false;
    this.giveUp = false;
    this.attempt = 0;
    if (this.ws) return;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._connect();
  }

  stop() {
    this.stopped = true;
    this._clearTimers();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      // Detach first: the close event of this socket arrives later and is then
      // ignored (see the stale-socket guard in _connect), so it can neither
      // schedule a reconnect nor touch a socket opened by a later start().
      const ws = this.ws;
      this.ws = null;
      try { ws.close(1000, 'bye'); } catch {}
    }
    this.fsm.set(State.DISCONNECTED);
    // Nothing reconnects after an explicit stop → no reply can arrive any more.
    this._failAllPending(new Error('Server-Verbindung beendet'));
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

  // Per-user voice channel join/leave → participant times in the transcript.
  voiceMember({ sessionId, userId, displayName, state }) {
    this._sendIfReady({ type: 'voice_member', cmdId: randomUUID(), sessionId, userId, displayName, state });
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

  // Ask the server to create the per-session upload dir before transferring WAVs.
  finalizePrepare(sessionId) {
    return this._request('finalize_prepare', { sessionId });
  }

  // Request server-side finalize. Resolves with the server's finalize_result.
  // Re-STT of long sessions can take half an hour and more → waits as long as
  // finalize_progress keeps coming (see finalizeWaitLimits). Resumable: a link
  // drop mid-finalize re-sends the request with the same cmdId after the
  // reconnect; the server joins it to the run in progress (or answers from its
  // short-lived result cache) instead of starting over.
  finalizeSession(payload = {}, { timeoutMs, idleTimeoutMs } = {}) {
    const limits = finalizeWaitLimits();
    return this._request('finalize_session', payload, {
      timeoutMs: timeoutMs ?? limits.maxMs,
      idleTimeoutMs: idleTimeoutMs ?? limits.idleMs,
      resumable: true,
    });
  }

  // Speaker-map read/write (server-persisted, per guild).
  speakerMapGet(guildId) {
    return this._request('speaker_map_get', { guildId }).then((m) => m.map || {});
  }
  speakerMapSet(guildId, userId, entry) {
    return this._request('speaker_map_set', { guildId, userId, entry });
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
    }, this.timing.connectTimeoutMs);
    ws.once('open',  () => clearTimeout(connectTimeout));
    ws.once('close', () => clearTimeout(connectTimeout));

    ws.on('open', () => {
      if (this.ws !== ws) return; // superseded (stop() while connecting)
      debug('control: socket open, awaiting hello');
      this.fsm.set(State.REGISTERING);
      this.handshakeTimer = setTimeout(() => {
        warn('control: handshake timeout');
        try { ws.close(4000, 'HANDSHAKE_TIMEOUT'); } catch {}
      }, this.timing.handshakeTimeoutMs);
    });

    ws.on('message', (data) => {
      if (this.ws !== ws) return; // late frame on a socket stop() already dropped
      this.lastServerMsgAt = Date.now();
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch (e) { warn('control: bad json from server:', e.message); return; }
      this._onMessage(msg);
    });

    ws.on('pong', () => { this.lastServerMsgAt = Date.now(); });

    ws.on('close', (code, reason) => {
      const r = reason && reason.toString();
      // A socket stop() already detached (or one replaced by a newer start())
      // must not clear the current socket's timers, fail its requests or
      // schedule a reconnect behind the caller's back.
      if (this.ws !== ws) { debug('control: stale socket closed', code, r || ''); return; }
      log('control: closed', code, r || '');
      this._clearTimers();
      this.ws = null;

      if (code === 4002) {
        // Until the next explicit start() (/join, finalize, /ask) — see start().
        warn('control: PROTO_MISMATCH — not reconnecting until the next explicit start');
        this.giveUp = true;
        this.fsm.set(State.DISCONNECTED);
        this._failAllPending(new Error('Server-Protokoll inkompatibel (PROTO_MISMATCH)'));
        return;
      }
      if (code === 4001) warn('control: AUTH_FAILED');
      this._suspendPending(r || `close ${code}`);
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
        // Ist-Konfiguration melden (Settings-Panel zeigt echte Bot-Werte statt
        // nur des server-seitigen Desired State). Secrets nur als „gesetzt?".
        this._send({ type: 'config_state', ...reportableConfig(), t: Date.now() });
        if (this.pendingSession) {
          debug('control: re-emitting session_start after reconnect');
          this._send({ type: 'session_start', cmdId: randomUUID(), ...this.pendingSession });
        }
        this._resendPending();
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
        this._rejectPending(msg.cmdId, new Error(msg.message || msg.code || 'server error'));
        return;
      }
      case 'finalize_progress': {
        this._notePendingProgress(msg);
        this.emit('finalizeProgress', msg);
        return;
      }
      // Settings-Panel: Konfigurations-Push vom Server. Auf process.env anwenden
      // + persistieren; reconnect-/restart-gebundene Werte greifen beim nächsten
      // Reconnect bzw. Bot-Neustart.
      case 'config_update': {
        try {
          const r = applyConfigUpdate({ set: msg.set, reset: msg.reset, persist: msg.persist !== false });
          log('control: config_update applied', r.applied.join(',') || '(leer)',
            'persist=', msg.persist !== false);
          this._send({ type: 'ack', op: 'config_update', cmdId: msg.cmdId, ok: true, applied: r.applied });
          // Frischen Ist-Zustand nachmelden, damit das Panel die Wirkung sieht.
          this._send({ type: 'config_state', ...reportableConfig(), t: Date.now() });
        } catch (e) {
          warn('control: config_update failed:', e.message);
          this._send({ type: 'ack', op: 'config_update', cmdId: msg.cmdId, ok: false, error: e.message });
        }
        return;
      }
      case 'finalize_result':
      case 'finalize_prepared':
      case 'speaker_map':
      case 'speaker_map_result': {
        this._resolvePending(msg.cmdId, msg);
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
      case 'finalize_request':
      case 'chat_message':
      case 'transcript_event': {
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

    const { hbIntervalMs, appPingIntervalMs, serverQuietTimeoutMs } = this.timing;
    this.hbTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try { this.ws.ping(); } catch (e) { debug('control: ping err', e.message); }
    }, hbIntervalMs);
    this.hbTimer.unref?.();

    this.appPingTimer = setInterval(() => {
      this._send({ type: 'ping', t: Date.now() });
    }, appPingIntervalMs);
    this.appPingTimer.unref?.();

    this.quietTimer = setInterval(() => {
      if (!this.ws) return;
      const since = Date.now() - this.lastServerMsgAt;
      if (since > serverQuietTimeoutMs) {
        warn(`control: server quiet for ${since}ms, terminating`);
        try { this.ws.terminate(); } catch {}
      }
    }, hbIntervalMs);
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
    const delay = this._backoff(this.attempt);
    this.attempt++;
    debug(`control: reconnect in ${delay}ms (attempt ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
