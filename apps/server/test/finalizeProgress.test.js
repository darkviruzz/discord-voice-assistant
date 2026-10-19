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

test('progress reporter keepalive: re-sends the latest state only after a quiet stretch', () => {
  let t = 0;
  const sent = [];
  const r = finalizeProgressReporter('123', 'cmd-1', { emit: (m) => sent.push(m), minIntervalMs: 1000, now: () => t });
  r.keepalive(60_000);                                  // nothing reported yet → nothing to repeat
  assert.equal(sent.length, 0);

  r({ phase: 'stt', done: 0, total: 5 });
  t = 30_000; r({ phase: 'stt', done: 5, total: 5 }); // last stt tick
  t = 30_100; r({ phase: 'audio' });                  // a long phase without ticks begins
  t = 60_000; r.keepalive(60_000);                    // 30 s quiet → not yet
  t = 90_100; r.keepalive(60_000);                    // 60 s quiet → repeat 'audio'
  t = 120_000; r.keepalive(60_000);                   // just repeated → quiet again
  t = 150_100; r.keepalive(60_000);
  assert.deepEqual(sent.map((m) => [m.phase, m.keepalive ?? false]), [
    ['stt', false], ['stt', false], ['audio', false], ['audio', true], ['audio', true],
  ]);
  assert.ok(sent.every((m) => m.type === 'finalize_progress' && m.sessionId === '123' && m.cmdId === 'cmd-1'));

  // A throttled tick still becomes the state a keepalive repeats.
  t = 200_000; r({ phase: 'summary', done: 0, total: 3 });
  t = 200_500; r({ phase: 'summary', done: 1, total: 3 }); // throttled
  t = 260_000; r.keepalive(60_000);
  assert.deepEqual(sent.at(-1), { type: 'finalize_progress', cmdId: 'cmd-1', sessionId: '123', phase: 'summary', done: 1, total: 3, keepalive: true });
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
