import WebSocket from 'ws';
import { TtsPlayback } from '../audio/ttsPlayback.js';
import { debug, warn } from '../logger.js';

const RECONNECT_DELAY_MS = 3000;

export class DownlinkClient {
  constructor({ baseUrl, bearer, params = {} }) {
    this.url = `${baseUrl}/downlink`;
    this.bearer = bearer || null;

    this._ws = null;
    this._sessionId = null;
    this._closing = false;
    this._reconnectTimer = null;
    this._playback = new TtsPlayback({ rewindMs: params.rewindMs ?? 1000 });

    this.interruptMinMs = params.interruptMinMs ?? 800;
    this.resumeGateMs = params.resumeGateMs ?? 1200;
    this.rewindMs = params.rewindMs ?? 1000;
    this._speakTimers = new Map();
    this._activeSpeakers = new Set();
    this._resumeTimer = null;
    this._playbackEventHandler = () => {};
    this._pauseStartedAt = null;
    this._pauseUserId = null;
  }

  open(sessionId) {
    this.close();
    this._sessionId = sessionId;

    const headers = this.bearer ? { Authorization: `Bearer ${this.bearer}` } : {};
    let ws;
    try {
      ws = new WebSocket(this.url, { headers });
    } catch (e) {
      warn('downlink: open failed:', e.message);
      return;
    }
    this._ws = ws;

    ws.on('open', () => {
      debug('downlink: connected, subscribing to session', sessionId);
      try {
        ws.send(JSON.stringify({ subscribe: true, sessionId }));
      } catch (e) {
        warn('downlink: subscribe send failed:', e.message);
      }
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        debug('downlink: ignoring legacy binary frame');
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        warn('downlink: bad json:', e.message);
        return;
      }

      this._handleMessage(msg);
    });

    ws.on('close', (code) => {
      debug('downlink: ws closed', code);
      if (this._ws !== ws) return;
      this._ws = null;
      if (!this._closing && this._sessionId) {
        debug('downlink: scheduling reconnect in', RECONNECT_DELAY_MS, 'ms');
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          if (!this._closing && this._sessionId) {
            debug('downlink: reconnecting to session', this._sessionId.toString());
            this.open(this._sessionId);
          }
        }, RECONNECT_DELAY_MS);
      }
    });

    ws.on('error', (e) => {
      warn('downlink: ws error:', e.message);
    });
  }

  close() {
    this._closing = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    const ws = this._ws;
    this._ws = null;
    if (ws) {
      try { ws.close(); } catch {}
    }

    for (const timer of this._speakTimers.values()) clearTimeout(timer);
    this._speakTimers.clear();
    this._activeSpeakers.clear();
    if (this._resumeTimer) {
      clearTimeout(this._resumeTimer);
      this._resumeTimer = null;
    }
    this._pauseStartedAt = null;
    this._pauseUserId = null;

    this._playback.stop();
    this._sessionId = null;
    this._closing = false;
  }

  setVoiceConnection(conn) {
    this._playback.subscribe(conn);
  }

  setPlaybackEventHandler(handler) {
    this._playbackEventHandler = typeof handler === 'function' ? handler : () => {};
  }

  clearVoiceConnection() {
    this._playback.stop();
    debug('downlink: cleared voice connection');
  }

  stopPlayback() {
    const stats = this._playback.stop();
    return stats ? { ...stats, sessionId: this._sessionId?.toString?.() ?? String(this._sessionId ?? '') } : null;
  }

  updateSession(sessionId) {
    if (sessionId === this._sessionId) return;
    const wasOpen = !!this._ws;
    this.close();
    if (wasOpen) this.open(sessionId);
  }

  setParams({ interruptMinMs, resumeGateMs, rewindMs } = {}) {
    if (typeof interruptMinMs === 'number') this.interruptMinMs = interruptMinMs;
    if (typeof resumeGateMs === 'number') this.resumeGateMs = resumeGateMs;
    if (typeof rewindMs === 'number') {
      this.rewindMs = rewindMs;
      this._playback.setParams({ rewindMs });
    }
    debug('downlink: params updated', {
      interruptMinMs: this.interruptMinMs,
      resumeGateMs: this.resumeGateMs,
      rewindMs: this.rewindMs,
    });
  }

  speakingStart(_userId) {
    if (this._speakTimers.has(_userId) || this._activeSpeakers.has(_userId)) return;
    if (this._resumeTimer) {
      clearTimeout(this._resumeTimer);
      this._resumeTimer = null;
    }
    const timer = setTimeout(() => {
      this._speakTimers.delete(_userId);
      this._activeSpeakers.add(_userId);
      const stats = this._playback.pause(`speaker ${_userId}`);
      if (stats) {
        this._pauseStartedAt = Date.now();
        this._pauseUserId = _userId;
        this._emitPlaybackEvent('playback_paused', {
          interruptedByUserId: _userId,
          interruptMinMs: this.interruptMinMs,
          rewindMs: this.rewindMs,
          ...stats,
        });
      }
    }, this.interruptMinMs);
    this._speakTimers.set(_userId, timer);
  }

  speakingEnd(_userId) {
    const timer = this._speakTimers.get(_userId);
    if (timer) {
      clearTimeout(timer);
      this._speakTimers.delete(_userId);
      if (this._playback.isPaused() && this._activeSpeakers.size === 0) {
        this._scheduleResume();
      }
      return;
    }

    this._activeSpeakers.delete(_userId);
    if (this._activeSpeakers.size > 0) return;

    if (this._playback.isPaused()) this._scheduleResume();
  }

  _scheduleResume() {
    if (this._resumeTimer) clearTimeout(this._resumeTimer);
    this._resumeTimer = setTimeout(() => {
      this._resumeTimer = null;
      const pauseStartedAt = this._pauseStartedAt;
      const pauseUserId = this._pauseUserId;
      const stats = this._playback.resume('speakers ended');
      if (stats) {
        this._emitPlaybackEvent('playback_resumed', {
          interruptedByUserId: pauseUserId,
          pauseDurationMs: pauseStartedAt ? Date.now() - pauseStartedAt : null,
          resumeGateMs: this.resumeGateMs,
          rewindMs: this.rewindMs,
          rewindFrames: stats.rewindFrames,
          rewoundMs: (stats.rewindFrames ?? 0) * 20,
          ...stats,
        });
      }
      this._pauseStartedAt = null;
      this._pauseUserId = null;
    }, this.resumeGateMs);
  }

  _emitPlaybackEvent(eventType, payload) {
    const sessionId = this._sessionId?.toString?.() ?? String(this._sessionId ?? '');
    if (!sessionId || !payload?.id) return;
    this._playbackEventHandler({
      eventType,
      sessionId,
      ...payload,
    });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'tts_start': {
        if (typeof msg.id !== 'string') {
          warn('downlink: tts_start without id');
          return;
        }
        this._playback.begin(msg.id);
        return;
      }
      case 'tts_frame': {
        if (typeof msg.id !== 'string' || typeof msg.payload !== 'string') {
          warn('downlink: bad tts_frame');
          return;
        }
        const frame = Buffer.from(msg.payload, 'base64');
        this._playback.pushFrame(msg.id, frame, msg.seq);
        return;
      }
      case 'tts_done': {
        if (typeof msg.id !== 'string') {
          warn('downlink: tts_done without id');
          return;
        }
        this._playback.markDone(msg.id);
        return;
      }
      case 'tts_error': {
        warn('downlink: tts_error', msg.id || '', msg.message || '');
        this._playback.stop();
        return;
      }
      default:
        debug('downlink: ignored message type', msg.type);
    }
  }
}
