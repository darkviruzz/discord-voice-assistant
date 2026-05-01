import WebSocket from 'ws';
import { buildFrame, MAGIC_UPLK } from './protocol.js';
import { debug, warn } from '../logger.js';

// Sends per-speaker raw Opus frames to the server's /uplink endpoint.
// Frames are dropped silently when the socket is not open — voice is
// real-time and buffering stale audio is useless.
export class UplinkClient {
  constructor({ baseUrl, bearer }) {
    this.url = `${baseUrl}/uplink`;
    this.bearer = bearer || null;
    this.ws = null;
    this.seqs = new Map(); // userId(string) → u32 seq counter
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

  // Sends one raw Opus packet. sessionId and userId are strings.
  sendFrame({ sessionId, userId, tsMs, opus }) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      debug('uplink: frame dropped (ws state=', ws ? ws.readyState : 'null', ')');
      return;
    }
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
