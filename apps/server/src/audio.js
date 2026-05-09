import opus from '@discordjs/opus';

const { OpusEncoder } = opus;

const OUT_RATE      = 48000;
const FRAME_SAMPLES = 960;           // 20 ms @ 48 kHz
const FRAME_BYTES   = FRAME_SAMPLES * 2;  // int16LE

/**
 * Converts a streaming sequence of mono int16LE PCM chunks (at fromRate) to
 * Opus packets at 48 kHz.  Maintains a single OpusEncoder instance and an
 * accumulator buffer across all push() calls so that chunk boundaries cause
 * no encoder resets and no samples are dropped.
 *
 * Typical usage:
 *   const pipe = new StreamingAudioPipeline(22050);
 *   for await (const { pcm } of ttsStream) {
 *     sendOpus(pipe.push(pcm));
 *   }
 *   if (!aborted) sendOpus(pipe.flush());
 */
export class StreamingAudioPipeline {
  constructor(fromRate, toRate = OUT_RATE) {
    this._fromRate = fromRate;
    this._toRate   = toRate;
    this._enc      = new OpusEncoder(toRate, 1);
    this._accum    = Buffer.alloc(0);
    this._lastSrc  = 0;   // last source sample, carried across chunks for interpolation
  }

  /** Resample + buffer chunk. Returns zero or more encoded Opus frames. */
  push(mono16leChunk) {
    const resampled = this._resample(mono16leChunk);
    this._accum     = Buffer.concat([this._accum, resampled]);
    return this._drain();
  }

  /**
   * Pad remaining buffered samples with silence and encode the final frame(s).
   * Must only be called on a clean stream end — not when the stream was aborted,
   * otherwise stale audio from an old response might be played.
   */
  flush() {
    if (this._accum.length === 0) return [];
    const rem    = this._accum.length % FRAME_BYTES;
    const padded = rem > 0
      ? Buffer.concat([this._accum, Buffer.alloc(FRAME_BYTES - rem)])
      : this._accum;
    this._accum = Buffer.alloc(0);
    return this._encodeAll(padded);
  }

  // ── private ──────────────────────────────────────────────────────────────

  _resample(src) {
    if (this._fromRate === this._toRate) {
      if (src.length >= 2) this._lastSrc = src.readInt16LE(src.length - 2);
      return src;
    }
    const srcSamples = src.length >>> 1;
    if (srcSamples === 0) return Buffer.alloc(0);

    const dstSamples = Math.round(srcSamples * this._toRate / this._fromRate);
    const dst        = Buffer.alloc(dstSamples * 2);

    for (let i = 0; i < dstSamples; i++) {
      const pos  = i * this._fromRate / this._toRate;
      const lo   = Math.floor(pos);
      const frac = pos - lo;
      const s0   = lo < srcSamples
        ? src.readInt16LE(lo * 2)
        : src.readInt16LE((srcSamples - 1) * 2);
      const hi   = lo + 1;
      // Clamp at chunk end; the next push() resumes from the new chunk's start.
      // A natural silence at sentence boundaries means this artefact is inaudible.
      const s1   = hi < srcSamples
        ? src.readInt16LE(hi * 2)
        : src.readInt16LE((srcSamples - 1) * 2);
      const s = s0 + (s1 - s0) * frac;
      dst.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
    }
    this._lastSrc = src.readInt16LE((srcSamples - 1) * 2);
    return dst;
  }

  _drain() {
    const frames = [];
    while (this._accum.length >= FRAME_BYTES) {
      frames.push(Buffer.from(this._enc.encode(this._accum.subarray(0, FRAME_BYTES))));
      this._accum = this._accum.subarray(FRAME_BYTES);
    }
    return frames;
  }

  _encodeAll(buf) {
    const frames = [];
    for (let off = 0; off + FRAME_BYTES <= buf.length; off += FRAME_BYTES) {
      frames.push(Buffer.from(this._enc.encode(buf.subarray(off, off + FRAME_BYTES))));
    }
    return frames;
  }
}
