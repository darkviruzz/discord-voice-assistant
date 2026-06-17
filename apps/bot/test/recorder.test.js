import test from 'node:test';
import assert from 'node:assert';
import { Readable } from 'node:stream';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { UtteranceRecorder } from '../src/recorder.js';

// Regression: a corrupt Opus packet made prism's decoder throw, which the
// recorder turned into a *rejected* subscribe() promise that nobody caught →
// unhandled rejection → process crash (the bot left voice). subscribe() must
// now always RESOLVE; errors end the chunk gracefully.

function makeRecorder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-test-'));
  fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true });
  const opusStream = new Readable({ read() {} });
  const receiver = { subscribe: () => opusStream };
  const session = { startedAt: Date.now(), dir };
  const rec = new UtteranceRecorder(session, null, receiver, { id: '42', username: 'tester' }, { silenceMs: 50 });
  return { rec, opusStream };
}

test('subscribe() resolves (never rejects) when the receive stream errors', async () => {
  const { rec, opusStream } = makeRecorder();
  const p = rec.subscribe();
  // Simulate the corrupt-packet failure surfacing on the audio stream.
  queueMicrotask(() => opusStream.emit('error', new Error('The compressed data passed is corrupted')));
  const result = await p; // would reject (and crash) before the fix
  assert.ok(result === null || typeof result === 'object');
});

test('dispose() settles an in-flight recording without throwing', async () => {
  const { rec } = makeRecorder();
  const p = rec.subscribe();
  rec.dispose();          // e.g. voice connection left READY
  const result = await p;
  assert.ok(result === null || typeof result === 'object');
  rec.dispose();          // idempotent — second call must not throw
});
