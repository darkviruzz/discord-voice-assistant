import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import prism from 'prism-media';
import { UtteranceRecorder } from '../src/recorder.js';

// Regression: a corrupt Opus packet made prism's decoder throw, which the
// recorder turned into a *rejected* subscribe() promise that nobody caught →
// unhandled rejection → process crash (the bot left voice). subscribe() must
// now always RESOLVE; errors end the chunk gracefully, keeping decoded audio.

const FRAME_SAMPLES = 960; // 20 ms @ 48 kHz mono
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function makeRecorder(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-test-'));
  dirs.push(dir);
  const opusStream = new Readable({ read() {} });
  const receiver = { subscribe: () => opusStream };
  const session = { startedAt: Date.now() - 5000, dir };
  const rec = new UtteranceRecorder(session, null, receiver, { id: '42', username: 'tester' }, { silenceMs: 50, ...opts });
  return { rec, opusStream, session, dir };
}

// Real Opus packets: a 440 Hz tone, encoded 20 ms at a time.
async function opusFrames(count) {
  const enc = new prism.opus.Encoder({ frameSize: FRAME_SAMPLES, channels: 1, rate: 48000 });
  const packets = [];
  enc.on('data', (p) => packets.push(p));
  for (let f = 0; f < count; f++) {
    const pcm = Buffer.alloc(FRAME_SAMPLES * 2);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * (f * FRAME_SAMPLES + i)) / 48000)), i * 2);
    }
    enc.write(pcm);
  }
  enc.end();
  await new Promise((r) => enc.on('end', r));
  return packets;
}

// The recorder settles on the WAV writer's 'finish'; the file stream flush and
// the header patch (real data length at byte 40, replacing a placeholder) land
// asynchronously right after. Wait until the file is a consistent WAV, then
// return its data-chunk size. Also keeps the cleanup from racing the writer.
async function settledWavDataBytes(file, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const b = fs.readFileSync(file);
      if (b.length >= 44 && b.readUInt32LE(40) === b.length - 44) return b.length - 44;
    } catch { /* not created yet */ }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`WAV ${file} never became consistent`);
}
// Path of the single chunk WAV the recorder created (it may appear a tick late).
async function onlyChunk(dir, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  let files = [];
  while (Date.now() < end) {
    try { files = fs.readdirSync(path.join(dir, 'chunks')); } catch { files = []; }
    if (files.length) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(files.length, 1, 'exactly one chunk file');
  return path.join(dir, 'chunks', files[0]);
}

test('a complete utterance is written as WAV and reported once with bot-clock timing', async () => {
  const done = [];
  const { rec, opusStream, session } = makeRecorder({ onChunkDone: (r) => done.push(r) });
  const packets = await opusFrames(10);
  const p = rec.subscribe();
  for (const pkt of packets) opusStream.push(pkt);
  opusStream.push(null); // AfterSilence end → stream ends

  const result = await p;
  assert.ok(result, 'resolved with a recording');
  assert.equal(result.userId, '42');
  assert.equal(result.username, 'tester');
  assert.equal(result.durationMs, 200, '10 × 20 ms frames');
  assert.ok(result.startMs >= 5000 && result.startMs < 60_000, `startMs relative to session start: ${result.startMs}`);
  assert.equal(path.dirname(result.file), path.join(session.dir, 'chunks'));
  assert.equal(await settledWavDataBytes(result.file), 10 * FRAME_SAMPLES * 2, 'all decoded PCM flushed to the WAV');
  assert.deepEqual(done, [result], 'onChunkDone called exactly once with the same record');
});

test('a corrupt packet mid-utterance ends the chunk gracefully and keeps the audio decoded so far', async () => {
  const { rec, opusStream } = makeRecorder();
  const packets = await opusFrames(5);
  const p = rec.subscribe();
  for (const pkt of packets.slice(0, 3)) opusStream.push(pkt);
  opusStream.push(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x01])); // "compressed data is corrupted"
  for (const pkt of packets.slice(3)) opusStream.push(pkt);

  const result = await p; // rejected (→ crash) before the fix
  assert.ok(result, 'partial recording kept');
  assert.equal(result.durationMs, 60, 'the 3 good frames before the corrupt one');
  assert.equal(await settledWavDataBytes(result.file), 3 * FRAME_SAMPLES * 2);
});

test('subscribe() resolves null (never rejects) when the receive stream errors before any audio', async () => {
  const { rec, opusStream, dir } = makeRecorder();
  const p = rec.subscribe();
  queueMicrotask(() => opusStream.emit('error', new Error('The compressed data passed is corrupted')));
  assert.equal(await p, null, 'nothing decoded → no chunk');
  assert.equal(await settledWavDataBytes(await onlyChunk(dir)), 0, 'empty WAV closed cleanly');
});

test('dispose() settles an in-flight recording without throwing, idempotently', async () => {
  const done = [];
  const { rec, dir } = makeRecorder({ onChunkDone: (r) => done.push(r) });
  const p = rec.subscribe();
  rec.dispose();          // e.g. voice connection left READY
  assert.equal(await p, null);
  assert.equal(await settledWavDataBytes(await onlyChunk(dir)), 0);
  assert.doesNotThrow(() => rec.dispose()); // second call must not throw
  assert.deepEqual(done, [], 'an empty chunk is never reported');
});
