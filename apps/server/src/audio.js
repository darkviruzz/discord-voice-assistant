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
    this._srcCarry = Buffer.alloc(0);
    this._srcPos   = 0; // fractional source index for the next output sample
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
    const tail = this._flushResampler();
    if (tail.length > 0) {
      this._accum = Buffer.concat([this._accum, tail]);
    }
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
      return src;
    }

    const input = this._srcCarry.length > 0
      ? Buffer.concat([this._srcCarry, src])
      : src;
    const srcSamples = input.length >>> 1;
    if (srcSamples === 0) return Buffer.alloc(0);

    const step = this._fromRate / this._toRate;
    let pos = this._srcPos;
    const samples = [];

    // Keep one source sample of lookahead for interpolation across chunk
    // boundaries.  The final edge is emitted in _flushResampler().
    while (pos + 1 < srcSamples) {
      const lo = Math.floor(pos);
      const frac = pos - lo;
      const s0 = input.readInt16LE(lo * 2);
      const s1 = input.readInt16LE((lo + 1) * 2);
      const s = s0 + (s1 - s0) * frac;
      samples.push(Math.max(-32768, Math.min(32767, Math.round(s))));
      pos += step;
    }

    const consumed = Math.max(0, Math.floor(pos));
    this._srcCarry = input.subarray(consumed * 2);
    this._srcPos = pos - consumed;
    return this._samplesToBuffer(samples);
  }

  _flushResampler() {
    if (this._fromRate === this._toRate || this._srcCarry.length === 0) {
      this._srcCarry = Buffer.alloc(0);
      this._srcPos = 0;
      return Buffer.alloc(0);
    }

    const srcSamples = this._srcCarry.length >>> 1;
    const step = this._fromRate / this._toRate;
    let pos = this._srcPos;
    const samples = [];

    while (pos < srcSamples) {
      const lo = Math.min(Math.floor(pos), srcSamples - 1);
      const hi = Math.min(lo + 1, srcSamples - 1);
      const frac = pos - lo;
      const s0 = this._srcCarry.readInt16LE(lo * 2);
      const s1 = this._srcCarry.readInt16LE(hi * 2);
      const s = s0 + (s1 - s0) * frac;
      samples.push(Math.max(-32768, Math.min(32767, Math.round(s))));
      pos += step;
    }

    this._srcCarry = Buffer.alloc(0);
    this._srcPos = 0;
    return this._samplesToBuffer(samples);
  }

  _samplesToBuffer(samples) {
    if (samples.length === 0) return Buffer.alloc(0);
    const dst = Buffer.alloc(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      dst.writeInt16LE(samples[i], i * 2);
    }
    return dst;
  }

  _drain() {
    const frames = [];
    while (this._accum.length >= FRAME_BYTES) {
      frames.push(Buffer.from(this._enc.encode(this._accum.subarray(0, FRAME_BYTES), FRAME_SAMPLES)));
      this._accum = this._accum.subarray(FRAME_BYTES);
    }
    return frames;
  }

  _encodeAll(buf) {
    const frames = [];
    for (let off = 0; off + FRAME_BYTES <= buf.length; off += FRAME_BYTES) {
      frames.push(Buffer.from(this._enc.encode(buf.subarray(off, off + FRAME_BYTES), FRAME_SAMPLES)));
    }
    return frames;
  }
}
