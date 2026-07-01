import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStreamChunks } from '../src/pipeline.js';

// splitAtSilence returns a single chunk while the total is below the max-chunk
// cap; use a modest cap so these tests need only ~30 s of synthetic PCM.
process.env.STT_MAX_CHUNK_SECONDS = '12';

const SR = 48000; // 48 kHz, 16-bit mono

// Build a PCM Buffer from a list of { sec, loud } segments.
function pcm(segments) {
  const total = segments.reduce((n, s) => n + Math.round(s.sec * SR), 0);
  const buf = Buffer.alloc(total * 2);
  let off = 0;
  for (const seg of segments) {
    const samples = Math.round(seg.sec * SR);
    const val = seg.loud ? 8000 : 0; // 8000 rms ≫ 300 threshold; 0 = silence
    for (let i = 0; i < samples; i++) buf.writeInt16LE(val, (off + i) * 2);
    off += samples;
  }
  return buf;
}

test('planStreamChunks: nothing complete yet for a short single chunk', () => {
  // 8 s speech, below the 10 s MIN_CHUNK and the 30 s max → one in-progress chunk.
  assert.equal(planStreamChunks(pcm([{ sec: 8, loud: true }])), null);
});

test('planStreamChunks: one completed chunk after a natural pause', () => {
  // 11 s speech, 0.5 s silence, 6 s speech → chunk0 complete, tail in progress.
  const plan = planStreamChunks(pcm([
    { sec: 11, loud: true }, { sec: 0.5, loud: false }, { sec: 6, loud: true },
  ]));
  assert.ok(plan, 'expected a plan');
  assert.equal(plan.complete.length, 1);
  assert.equal(plan.complete[0].split, 'natural-silence');
  // advance = start of the in-progress tail ≈ 11.5 s (after the discarded silence).
  assert.ok(plan.advance > 11 * SR && plan.advance < 12 * SR,
    `advance ${plan.advance} not ~11.5s`);
});

test('planStreamChunks: two completed chunks, tail left in progress', () => {
  const plan = planStreamChunks(pcm([
    { sec: 11, loud: true }, { sec: 0.5, loud: false },
    { sec: 11, loud: true }, { sec: 0.5, loud: false },
    { sec: 5, loud: true },
  ]));
  assert.ok(plan, 'expected a plan');
  assert.equal(plan.complete.length, 2);
  // Tail begins ~23 s in.
  assert.ok(plan.advance > 22 * SR && plan.advance < 24 * SR,
    `advance ${plan.advance} not ~23s`);
});

test('planStreamChunks: consuming advance leaves exactly the tail', () => {
  const full = pcm([
    { sec: 11, loud: true }, { sec: 0.5, loud: false }, { sec: 6, loud: true },
  ]);
  const plan = planStreamChunks(full);
  const remaining = full.subarray(plan.advance * 2);
  // The remaining tail (~6 s) is below MIN_CHUNK/max → not yet splittable.
  assert.equal(planStreamChunks(remaining), null);
  // And it is roughly the 6 s of trailing speech we expect.
  const remSec = remaining.length / 2 / SR;
  assert.ok(remSec > 5.5 && remSec < 6.5, `tail ${remSec}s not ~6s`);
});
