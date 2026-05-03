// Jitter buffer for downlink Opus frames.
// Frames are stored with their receive timestamp and dropped if too stale.

export class JitterBuffer {
  constructor() {
    this._frames  = []; // { opus: Buffer, tsMs: number }[]
    this._history = []; // last 50 played frames (~1000 ms) for rewind
  }

  get size() { return this._frames.length; }

  add(opus, tsMs = Date.now()) {
    this._frames.push({ opus, tsMs });
  }

  // Returns the oldest frame whose age is <= maxAgeMs, or null.
  // Silently discards frames that are too old.
  shift(maxAgeMs = 1500) {
    const cutoff = Date.now() - maxAgeMs;
    while (this._frames.length > 0 && this._frames[0].tsMs < cutoff) {
      this._frames.shift();
    }
    if (this._frames.length === 0) return null;
    const frame = this._frames.shift();
    // Keep last 50 frames (~1000 ms) for rewind after interruptions.
    this._history.push(frame);
    if (this._history.length > 50) this._history.shift();
    return frame.opus;
  }

  // Re-insert the last `ms` of played frames at the front of the queue.
  // Existing queued frames are re-timestamped so they are not dropped as stale
  // while the history plays back.
  rewind(ms = 1000) {
    const count = Math.min(Math.ceil(ms / 20), this._history.length);
    if (count === 0) return;
    const slice = this._history.slice(-count);
    const now   = Date.now();
    // Push existing queued frames into the future so they survive the replay window.
    for (let i = 0; i < this._frames.length; i++) {
      this._frames[i] = { opus: this._frames[i].opus, tsMs: now + (count + i) * 20 };
    }
    const fresh = slice.map((f, i) => ({ opus: f.opus, tsMs: now - (count - 1 - i) * 20 }));
    this._frames.unshift(...fresh);
  }

  clear() {
    this._frames  = [];
    this._history = [];
  }
}
