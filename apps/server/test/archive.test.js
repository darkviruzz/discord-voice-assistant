import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeOggArgs, mergedMixArgs } from '../src/finalize/archive.js';

test('encodeOggArgs builds a mono 48k Opus transcode', () => {
  const args = encodeOggArgs('/in.wav', '/out.ogg', '32k');
  assert.deepEqual(args, [
    '-y', '-i', '/in.wav', '-ac', '1', '-ar', '48000',
    '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-application', 'voip', '/out.ogg',
  ]);
});

test('mergedMixArgs delays each input by its relative startMs', () => {
  const utterances = [
    { abs: '/a.wav', startMs: 1000 },
    { abs: '/b.wav', startMs: 1000 + 2500 },
  ];
  const args = mergedMixArgs(utterances, '/mix.ogg', '32k');
  const filterIdx = args.indexOf('-filter_complex');
  const filter = args[filterIdx + 1];
  // Earliest start normalized to 0; second delayed by 2500 ms.
  assert.match(filter, /\[0:a\]adelay=0\|0\[a0\]/);
  assert.match(filter, /\[1:a\]adelay=2500\|2500\[a1\]/);
  assert.match(filter, /amix=inputs=2:normalize=0/);
  assert.ok(args.includes('/a.wav') && args.includes('/b.wav'));
  assert.equal(args[args.length - 1], '/mix.ogg');
});
