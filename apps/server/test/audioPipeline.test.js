// StreamingAudioPipeline at the TTS input rates: 24 kHz (OpenAI-compatible
// servers, ElevenLabs pcm_24000), 22050 / 16000 Hz (Piper voices). Checks the
// frame arithmetic (no drift, nothing lost at flush), that chunk boundaries —
// including odd byte counts — do not change the encoded output, and that the
// pitch survives the resampling (a wrong ratio would shift it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import opus from '@discordjs/opus';
import { StreamingAudioPipeline } from '../src/audio.js';

const FRAME = 960; // 20 ms @ 48 kHz

function sine(rate, seconds, hz = 440, amp = 8000) {
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * hz * i / rate)), i * 2);
  return buf;
}

function encodeOneShot(rate, pcm) {
  const p = new StreamingAudioPipeline(rate);
  return [...p.push(pcm), ...p.flush()];
}

function encodeChunked(rate, pcm, sizes) {
  const p = new StreamingAudioPipeline(rate);
  const frames = [];
  let off = 0;
  for (let k = 0; off < pcm.length; k++) {
    const n = Math.min(sizes[k % sizes.length], pcm.length - off);
    frames.push(...p.push(pcm.subarray(off, off + n)));
    off += n;
  }
  frames.push(...p.flush());
  return frames;
}

function zeroCrossings(frames) {
  const dec = new opus.OpusEncoder(48000, 1);
  const pcm = Buffer.concat(frames.map((f) => dec.decode(f)));
  // Hysteresis: only sign changes between |s| > 1000 count, so codec noise in
  // the silent flush padding does not add crossings.
  let z = 0;
  let sign = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    const now = s > 1000 ? 1 : s < -1000 ? -1 : 0;
    if (now !== 0 && sign !== 0 && now !== sign) z++;
    if (now !== 0) sign = now;
  }
  return { z, samples: pcm.length / 2 };
}

test('24 kHz: exactly 2 output samples per input sample → ceil(2N/960) frames, nothing lost at flush', () => {
  for (const n of [1, 2, 479, 480, 481, 960, 24000, 24000 * 7 + 13]) {
    const frames = encodeOneShot(24000, sine(24000, n / 24000));
    assert.equal(frames.length, Math.ceil((2 * n) / FRAME), `N=${n}`);
  }
});

test('24 kHz: one second is 50 frames whether pushed at once or in odd-sized chunks (no drift)', () => {
  const pcm = sine(24000, 1);
  const whole = encodeOneShot(24000, pcm);
  assert.equal(whole.length, 50);
  // 1-byte first chunk, odd sizes, splits inside samples, one big chunk.
  const chunked = encodeChunked(24000, pcm, [1, 3, 2, 7, 1000, 1, 1, 333, 4801]);
  assert.equal(chunked.length, whole.length);
  for (let i = 0; i < whole.length; i++) assert.ok(whole[i].equals(chunked[i]), `frame ${i} differs`);
});

test('24 kHz: a long stream stays sample-exact (60 s → 3000 frames)', () => {
  const p = new StreamingAudioPipeline(24000);
  const chunk = sine(24000, 0.1); // 2400 samples, pushed 600×
  let frames = 0;
  for (let i = 0; i < 600; i++) frames += p.push(chunk).length;
  frames += p.flush().length;
  assert.equal(frames, 3000);
});

test('24 kHz: pitch survives resampling (440 Hz in → ~880 zero crossings per second out)', () => {
  const { z, samples } = zeroCrossings(encodeOneShot(24000, sine(24000, 1)));
  assert.equal(samples, 48000);
  assert.ok(Math.abs(z - 880) <= 10, `zero crossings ${z}`);
});

test('Piper rates (22050 / 16000 Hz): frame count matches the duration, chunking does not change the audio', () => {
  for (const rate of [22050, 16000]) {
    const pcm = sine(rate, 1.5);
    const whole = encodeOneShot(rate, pcm);
    const expected = Math.ceil((1.5 * 48000) / FRAME); // 75
    assert.ok(Math.abs(whole.length - expected) <= 1, `${rate}: ${whole.length} frames`);
    // The step (rate/48000) is not a binary fraction here, so the fractional
    // read position rounds slightly differently per chunk and single samples
    // may differ by 1 LSB — compare the decoded audio, not the Opus bytes.
    const chunked = encodeChunked(rate, pcm, [1, 4095, 2, 513, 7]);
    assert.equal(chunked.length, whole.length, `${rate}: chunked frame count`);
    assert.ok(decodedRmsDiff(whole, chunked) < 0.01, `${rate}: chunked audio deviates`);
    const { z } = zeroCrossings(whole);
    assert.ok(Math.abs(z - 1320) <= 15, `${rate}: zero crossings ${z}`);
  }
});

// RMS of the difference between two decoded frame sequences, relative to the
// RMS of the first one.
function decodedRmsDiff(a, b) {
  const dec = (frames) => {
    const d = new opus.OpusEncoder(48000, 1);
    return Buffer.concat(frames.map((f) => d.decode(f)));
  };
  const x = dec(a);
  const y = dec(b);
  let se = 0;
  let sx = 0;
  for (let i = 0; i < x.length; i += 2) {
    const d = x.readInt16LE(i) - y.readInt16LE(i);
    se += d * d;
    sx += x.readInt16LE(i) ** 2;
  }
  return Math.sqrt(se / sx);
}

test('flush on an empty or already flushed pipeline returns nothing', () => {
  const p = new StreamingAudioPipeline(24000);
  assert.deepEqual(p.flush(), []);
  p.push(sine(24000, 0.05));
  assert.ok(p.flush().length > 0);
  assert.deepEqual(p.flush(), []);
});
