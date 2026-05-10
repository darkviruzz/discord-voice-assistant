import WebSocket from 'ws';
import { TtsPlayback } from '../audio/ttsPlayback.js';
import { debug, warn } from '../logger.js';

const RECONNECT_DELAY_MS = 3000;

export class DownlinkClient {
  constructor({ baseUrl, bearer }) {
    this.url = `${baseUrl}/downlink`;
    this.bearer = bearer || null;

    this._ws = null;
    this._sessionId = null;
    this._closing = false;
    this._reconnectTimer = null;
    this._playback = new TtsPlayback();
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

    this._playback.stop();
    this._sessionId = null;
    this._closing = false;
  }

  setVoiceConnection(conn) {
    this._playback.subscribe(conn);
  }

  clearVoiceConnection() {
    this._playback.stop();
    debug('downlink: cleared voice connection');
  }

  stopPlayback() {
    this._playback.stop();
  }

  updateSession(sessionId) {
    if (sessionId === this._sessionId) return;
    const wasOpen = !!this._ws;
    this.close();
    if (wasOpen) this.open(sessionId);
  }

  setParams(_params) {
    debug('downlink: set_params ignored by minimal FIFO playback');
  }

  speakingStart(_userId) {
    // Minimal rebuild step 1: no gate, no pause, no DTX.
  }

  speakingEnd(_userId) {
    // Minimal rebuild step 1: no gate, no pause, no DTX.
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
