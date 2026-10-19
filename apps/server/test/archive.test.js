import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import { spawnSync } from 'child_process';
import {
  encodeOggArgs, mixEncodeArgs, mixTimeline, decodeWavMono48k, mixBlocks, writeMergedMix,
  buildAudioArchive, hasFfmpeg,
} from '../src/finalize/archive.js';

const tmpRoots = [];
after(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
  tmpRoots.push(d);
  return d;
}

// Canonical PCM WAV: interleaved `frames` ([[ch0, ch1, …], …]) or mono numbers.
function wav(frames, { rate = 48000, format = 1, bits = 16, list = false, dataSize } = {}) {
  const rows = Array.from(frames, (f) => (Array.isArray(f) ? f : [f]));
  const channels = rows[0]?.length ?? 1;
  const bps = bits / 8;
  const data = Buffer.alloc(rows.length * channels * bps);
  rows.forEach((row, i) => row.forEach((v, c) => {
    const p = (i * channels + c) * bps;
    if (format === 3) data.writeFloatLE(v, p);
    else data.writeInt16LE(Math.round(v * 32768), p);
  }));
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii'); fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(format, 8); fmt.writeUInt16LE(channels, 10); fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt32LE(rate * channels * bps, 16); fmt.writeUInt16LE(channels * bps, 20); fmt.writeUInt16LE(bits, 22);
  const extra = list ? Buffer.concat([Buffer.from('LIST', 'ascii'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc\0', 'ascii')]) : Buffer.alloc(0);
  const dataHdr = Buffer.alloc(8);
  dataHdr.write('data', 0, 'ascii'); dataHdr.writeUInt32LE(dataSize ?? data.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmt, extra, dataHdr, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

const pcm = (n, v) => new Float32Array(n).fill(v);

async function collect(gen) {
  const parts = [];
  for await (const b of gen) parts.push(b);
  const buf = Buffer.concat(parts);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

// Stand-in for spawn('ffmpeg', …): records the args and every byte piped to stdin.
function fakeSpawn(rec, exitCode = 0) {
  return (cmd, args) => {
    const ff = new EventEmitter();
    rec.cmd = cmd; rec.args = args; rec.bytes = 0;
    ff.stderr = new PassThrough();
    ff.stdin = new Writable({
      write(chunk, _enc, cb) { rec.bytes += chunk.length; cb(); },
      final(cb) { cb(); setImmediate(() => ff.emit('close', exitCode)); },
    });
    return ff;
  };
}

test('encodeOggArgs builds a mono 48k Opus transcode', () => {
  const args = encodeOggArgs('/in.wav', '/out.ogg', '32k');
  assert.deepEqual(args, [
    '-y', '-i', '/in.wav', '-ac', '1', '-ar', '48000',
    '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-application', 'voip', '/out.ogg',
  ]);
});

test('mixEncodeArgs encodes raw mono 48k float PCM from stdin to Opus', () => {
  assert.deepEqual(mixEncodeArgs('/mix.ogg', '32k'), [
    '-y', '-f', 'f32le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0',
    '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-application', 'voip', '/mix.ogg',
  ]);
});

test('mixTimeline offsets each utterance by its startMs relative to the earliest', () => {
  const tl = mixTimeline([
    { abs: '/b.wav', startMs: 1000 + 2500 },
    { abs: '/a.wav', startMs: 1000 },
    { abs: '/c.wav', startMs: 1000 + 0.4 }, // ms-rounded, like the old adelay
  ]);
  assert.deepEqual(tl.map((t) => [t.u.abs, t.offset]), [['/a.wav', 0], ['/c.wav', 0], ['/b.wav', 2500 * 48]]);
  assert.equal(mixTimeline([{ abs: '/x.wav' }, { abs: '/y.wav', startMs: 10 }])[1].offset, 10 * 48); // missing startMs = 0
});

test('decodeWavMono48k reads 16-bit / float PCM and keeps the first channel', () => {
  assert.deepEqual([...decodeWavMono48k(wav([0.5, -0.25, 0]))], [0.5, -0.25, 0]);
  assert.deepEqual([...decodeWavMono48k(wav([[0.5, 0.1], [-0.5, 0.2]]))], [0.5, -0.5]);
  assert.deepEqual([...decodeWavMono48k(wav([0.75, -1], { format: 3, bits: 32 }))], [0.75, -1]);
  assert.deepEqual([...decodeWavMono48k(wav([0.5], { list: true }))], [0.5], 'skips chunks before data');
  assert.deepEqual([...decodeWavMono48k(wav([0.5, 0.25], { dataSize: 0 }))], [0.5, 0.25], 'unpatched header → rest of file');
  assert.equal(decodeWavMono48k(wav([0.5], { rate: 16000 })), null, 'other rate → ffmpeg');
  assert.equal(decodeWavMono48k(wav([0.5], { format: 1, bits: 32 })), null, 'other bit depth → ffmpeg');
  assert.equal(decodeWavMono48k(Buffer.from('AUDIO-A')), null);
});

test('mixBlocks sums overlaps, keeps gaps silent and ends with the last utterance', async () => {
  const tl = mixTimeline([
    { startMs: 10, pcm: pcm(60, 0.25) },  // samples   0..59
    { startMs: 11, pcm: pcm(30, 0.5) },   // samples  48..77 (overlaps the first)
    { startMs: 12, pcm: null },           // undecodable → left out
    { startMs: 13, pcm: pcm(10, 0.125) }, // samples 144..153 (after a gap)
  ]);
  const out = await collect(mixBlocks(tl, (u) => u.pcm, 50)); // block size crosses every boundary
  const want = new Float32Array(154);
  want.fill(0.25, 0, 48); want.fill(0.75, 48, 60); want.fill(0.5, 60, 78); want.fill(0.125, 144, 154);
  assert.deepEqual([...out], [...want]);

  await assert.rejects(collect(mixBlocks(mixTimeline([{ startMs: 0, pcm: null }]), (u) => u.pcm)), /no decodable/);
  await assert.rejects(collect(mixBlocks(mixTimeline([{ startMs: 0 }, { startMs: 25 * 3600e3 }]), () => pcm(1, 0))), /exceeds 24 h/);
});

test('writeMergedMix keeps the ffmpeg command line bounded for a 3000-utterance session', async () => {
  // Old builder: one `-i <path>` + one adelay per utterance → spawn ENAMETOOLONG on Windows (~32K chars).
  const longDir = path.join('C:\\voice-assistant\\data\\uploads\\1730000000000-a-rather-long-session-id', 'sub');
  const utterances = Array.from({ length: 3000 }, (_, i) => ({ abs: path.join(longDir, `${i}-user-1234567890.wav`), startMs: i * 20 }));
  const outPath = path.join(longDir, 'session_mix.ogg');
  const rec = {};
  await writeMergedMix(utterances, outPath, { bitrate: '32k', spawnFn: fakeSpawn(rec), decode: () => pcm(480, 0.01) });

  assert.equal(rec.cmd, 'ffmpeg');
  assert.deepEqual(rec.args, mixEncodeArgs(outPath, '32k'), 'same command as for a single utterance');
  assert.ok(rec.args.join(' ').length < 400, `command line ${rec.args.join(' ').length} chars`);
  assert.ok(!rec.args.some((a) => a.includes('-user-')), 'no utterance path on the command line');
  assert.equal(rec.bytes, (2999 * 20 * 48 + 480) * 4, 'whole timeline streamed as f32le');
});

test('writeMergedMix rejects and removes the half-written output when ffmpeg fails', async () => {
  const dir = tmpdir();
  const outPath = path.join(dir, 'session_mix.ogg');
  fs.writeFileSync(outPath, 'partial');
  await assert.rejects(
    writeMergedMix([{ abs: 'x.wav', startMs: 0 }], outPath, { spawnFn: fakeSpawn({}, 1), decode: () => pcm(10, 0.1) }),
    /ffmpeg exited 1/,
  );
  assert.equal(fs.existsSync(outPath), false);
});

test('real ffmpeg: merged mix of 3000 utterances (and non-48k input) decodes to the full timeline', { skip: !hasFfmpeg() && 'ffmpeg not installed' }, async () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a.wav');
  const b = path.join(dir, 'b-16k.wav');
  fs.writeFileSync(a, wav(Array.from({ length: 480 }, (_, i) => 0.3 * Math.sin(i / 5))));
  fs.writeFileSync(b, wav(Array.from({ length: 160 }, (_, i) => 0.3 * Math.sin(i / 2)), { rate: 16000 }));
  const utterances = Array.from({ length: 3000 }, (_, i) => ({ abs: i === 1500 ? b : a, startMs: i * 20 }));
  const outPath = path.join(dir, 'session_mix.ogg');
  await writeMergedMix(utterances, outPath);

  const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', outPath, '-f', 'f32le', 'pipe:1'], { maxBuffer: 64 << 20 });
  assert.equal(dec.status, 0, String(dec.stderr));
  const samples = dec.stdout.length / 4;
  const want = 2999 * 20 * 48 + 480;
  assert.ok(Math.abs(samples - want) <= 960, `decoded ${samples} samples, want ~${want}`);
});

test('real ffmpeg: buildAudioArchive writes session_mix.ogg next to the originals', { skip: !hasFfmpeg() && 'ffmpeg not installed' }, async () => {
  const uploadDir = tmpdir();
  const archiveDir = tmpdir();
  fs.writeFileSync(path.join(uploadDir, 'a.wav'), wav(pcm(4800, 0.1)));
  fs.writeFileSync(path.join(uploadDir, 'b.wav'), wav(pcm(4800, 0.2)));
  const manifest = { utterances: [{ file: 'a.wav', startMs: 0 }, { file: 'b.wav', startMs: 50 }] };
  const res = await buildAudioArchive({ manifest, uploadDir, archiveDir });
  assert.deepEqual(res.files.sort(), [path.join('audio', 'a.wav'), path.join('audio', 'b.wav'), path.join('audio', 'session_mix.ogg')]);
  assert.ok(fs.statSync(path.join(archiveDir, 'audio', 'session_mix.ogg')).size > 0);
});
