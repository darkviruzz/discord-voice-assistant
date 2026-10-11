import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finalizeProgressReporter } from '../src/control.js';
import { buildFinalizeModel } from '../src/finalize/index.js';

test('progress reporter: phase changes and the last tick always go out, ticks are throttled', () => {
  let t = 0;
  const sent = [];
  const r = finalizeProgressReporter('123', 'cmd-1', { emit: (m) => sent.push(m), minIntervalMs: 1000, now: () => t });
  r({ phase: 'stt', done: 0, total: 5 });
  t = 100; r({ phase: 'stt', done: 1, total: 5 });   // throttled
  t = 200; r({ phase: 'stt', done: 2, total: 5 });   // throttled
  t = 1300; r({ phase: 'stt', done: 3, total: 5 });  // interval passed
  t = 1400; r({ phase: 'stt', done: 5, total: 5 });  // last one — always
  t = 1450; r({ phase: 'merge' });                    // phase change — always
  t = 1460; r({ phase: 'audio' });
  assert.deepEqual(sent.map((m) => [m.phase, m.done ?? null]), [
    ['stt', 0], ['stt', 3], ['stt', 5], ['merge', null], ['audio', null],
  ]);
  assert.ok(sent.every((m) => m.type === 'finalize_progress' && m.sessionId === '123' && m.cmdId === 'cmd-1'));
});

test('buildFinalizeModel reports one stt tick per verified utterance, also on STT errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-progress-'));
  try {
    const manifest = {
      sessionStartMs: 1_000,
      utterances: [
        { file: 'a.wav', userId: '1', username: 'A', startMs: 0, durationMs: 1000 },
        { file: 'b.wav', userId: '1', username: 'A', startMs: 2000, durationMs: 1000 },
        { file: 'skip.wav', userId: '2', username: 'B', startMs: 4000, durationMs: 1000 },
      ],
    };
    const ticks = [];
    const transcribeFn = async (abs) => {
      if (abs.endsWith('b.wav')) throw new Error('stt down');
      return { text: 'Hallo Welt', words: null };
    };
    await buildFinalizeModel({
      sessionId: '1000', manifest, uploadDir: dir, transcribeFn,
      verified: new Set(['a.wav', 'b.wav']),
      onProgress: (p) => { ticks.push(`${p.phase}:${p.done}/${p.total}`); throw new Error('callback bug must not break finalize'); },
    });
    assert.deepEqual(ticks, ['stt:0/2', 'stt:1/2', 'stt:2/2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
