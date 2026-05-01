// Jitter buffer for downlink Opus frames.
// Frames are stored with their receive timestamp and dropped if too stale.

export class JitterBuffer {
  constructor() {
    this._frames = []; // { opus: Buffer, tsMs: number }[]
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
    return this._frames.length > 0 ? this._frames.shift().opus : null;
  }

  clear() {
    this._frames = [];
  }
}
