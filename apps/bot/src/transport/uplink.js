import WebSocket from 'ws';
import { buildFrame, MAGIC_UPLK } from './protocol.js';
import { debug, warn } from '../logger.js';

// While the uplink socket is down, every incoming Opus frame (~50/s during
// speech) would otherwise log its own "frame dropped" line — logging the
// first drop immediately (visible right away in a live tail) then coalescing
// the rest into one summary per this interval instead of flooding.
const DROP_LOG_INTERVAL_MS = 10_000;

// Sends per-speaker raw Opus frames to the server's /uplink endpoint.
// Frames are dropped silently when the socket is not open — voice is
// real-time and buffering stale audio is useless.
export class UplinkClient {
  constructor({ baseUrl, bearer }) {
    this.url = `${baseUrl}/uplink`;
    this.bearer = bearer || null;
    this.ws = null;
    this.seqs = new Map(); // userId(string) → u32 seq counter
    this._dropCount = 0;
    this._dropWindowStart = 0;
  }

  open() {
    if (this.ws) return; // already open or opening
    const headers = this.bearer ? { Authorization: `Bearer ${this.bearer}` } : {};
    try {
      const ws = new WebSocket(this.url, { headers });
      this.ws = ws;
      ws.on('open', () => debug('uplink: connected'));
      ws.on('close', (code) => {
        debug('uplink: closed', code);
        if (this.ws === ws) this.ws = null;
      });
      ws.on('error', (e) => {
        warn('uplink ws error:', e.message);
        if (this.ws === ws) this.ws = null;
      });
    } catch (e) {
      warn('uplink: open failed:', e.message);
    }
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    if (ws) try { ws.close(); } catch {}
  }

  // Logs the first drop of a burst immediately, then coalesces further drops
  // into one summary line per DROP_LOG_INTERVAL_MS instead of one per frame.
  _logFrameDropped(state) {
    const now = Date.now();
    if (this._dropCount === 0) {
      debug('uplink: frame dropped (ws state=', state, ') — further drops summarized every', DROP_LOG_INTERVAL_MS / 1000, 's');
      this._dropWindowStart = now;
    }
    this._dropCount++;
    if (now - this._dropWindowStart >= DROP_LOG_INTERVAL_MS) {
      debug(`uplink: ${this._dropCount} frames dropped in the last ${Math.round((now - this._dropWindowStart) / 1000)}s (ws state=`, state, ')');
      this._dropCount = 0;
    }
  }

  // Called on a successful send so a burst that ends mid-window still reports
  // its tail instead of silently losing the last few drops.
  _flushFrameDropLog() {
    if (this._dropCount === 0) return;
    const now = Date.now();
    debug(`uplink: ${this._dropCount} frames dropped in the last ${Math.round((now - this._dropWindowStart) / 1000)}s (ws recovered)`);
    this._dropCount = 0;
  }

  // Sends one raw Opus packet. sessionId and userId are strings.
  sendFrame({ sessionId, userId, tsMs, opus }) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this._logFrameDropped(ws ? ws.readyState : 'null');
      return;
    }
    this._flushFrameDropLog();
    const seq = this.seqs.get(userId) ?? 0;
    this.seqs.set(userId, (seq + 1) >>> 0); // wrap at u32
    const pkt = buildFrame({
      magic:     MAGIC_UPLK,
      codec:     'opus',
      sessionId: BigInt(sessionId),
      userId:    BigInt(userId),
      seq,
      tsMs:      tsMs ?? Date.now(),
      payload:   opus,
    });
    try { ws.send(pkt, { binary: true }); }
    catch (e) { warn('uplink send failed:', e.message); }
  }

  resetSeq(userId) {
    this.seqs.delete(userId);
  }
}
