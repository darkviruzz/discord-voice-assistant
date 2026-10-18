import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { spawn, spawnSync } from 'child_process';
import { debug, warn } from '../logger.js';

const OPUS_BITRATE = process.env.ARCHIVE_OPUS_BITRATE ?? '32k';
const MIX_RATE = 48000;
const MIX_BLOCK = MIX_RATE * 10; // samples per streamed mix block (10 s)
// Sanity cap: a corrupt manifest must not make the mix stream days of silence.
const MIX_MAX_SAMPLES = MIX_RATE * 60 * 60 * 24;

let _ffmpegChecked = null;
export function hasFfmpeg() {
  if (_ffmpegChecked !== null) return _ffmpegChecked;
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    _ffmpegChecked = !r.error && r.status === 0;
  } catch {
    _ffmpegChecked = false;
  }
  return _ffmpegChecked;
}

// Pure: ffmpeg args to transcode one input to mono 48 kHz Opus at the archive bitrate.
export function encodeOggArgs(inPath, outPath, bitrate = OPUS_BITRATE) {
  return ['-y', '-i', inPath, '-ac', '1', '-ar', '48000',
    '-c:a', 'libopus', '-b:a', bitrate, '-vbr', 'on', '-application', 'voip', outPath];
}

// The merged mix is summed in Node and streamed into ONE ffmpeg encode. It used
// to be a single ffmpeg call with an `-i` + adelay per utterance into
// amix=inputs=N: a real session (~2000 utterances) overran the Windows
// command-line limit (spawn ENAMETOOLONG), and every delayed input was padded
// with silence up to its start (work ∝ utterances × session length).

// Pure: ffmpeg args to encode the mix — raw mono 48 kHz float PCM on stdin →
// Opus. Independent of the utterance count.
export function mixEncodeArgs(outPath, bitrate = OPUS_BITRATE) {
  return ['-y', '-f', 'f32le', '-ar', String(MIX_RATE), '-ac', '1', '-i', 'pipe:0',
    '-c:a', 'libopus', '-b:a', bitrate, '-vbr', 'on', '-application', 'voip', outPath];
}

// Pure: each utterance's sample offset on the mix timeline (its startMs
// relative to the earliest, rounded to whole ms like the old adelay), by offset.
export function mixTimeline(utterances) {
  let minStart = Infinity;
  for (const u of utterances) minStart = Math.min(minStart, u.startMs || 0);
  return utterances
    .map((u) => ({ u, offset: Math.max(0, Math.round((u.startMs || 0) - minStart)) * (MIX_RATE / 1000) }))
    .sort((a, b) => a.offset - b.offset);
}

// Pure: decode a PCM WAV (16-bit int or 32-bit float, 48 kHz — what the bot
// writes) to mono float samples, keeping the first channel (as the old
// pan=mono|c0=c0 did). null → not natively decodable, let ffmpeg do it.
export function decodeWavMono48k(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt || fmt.rate !== MIX_RATE || fmt.channels < 1) return null;
      const int16 = fmt.format === 1 && fmt.bits === 16;
      if (!int16 && !(fmt.format === 3 && fmt.bits === 32)) return null;
      // Unpatched header (crash mid-write: 0 / 0xFFFFFFFF) or truncated file → take what is there.
      const end = (size === 0 || body + size > buf.length) ? buf.length : body + size;
      const step = fmt.channels * (fmt.bits / 8);
      const out = new Float32Array(Math.floor((end - body) / step));
      for (let i = 0, p = body; i < out.length; i++, p += step) {
        out[i] = int16 ? buf.readInt16LE(p) / 32768 : buf.readFloatLE(p);
      }
      return out;
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

// Any other input (other rate, bit depth or codec): ffmpeg decodes it to the
// same mono 48 kHz float PCM.
function decodeWithFfmpeg(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-af', 'pan=mono|c0=c0',
      '-ar', String(MIX_RATE), '-f', 'f32le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg decode exited ${code}: ${err.slice(-300)}`));
      const buf = Buffer.concat(chunks);
      // Copy into a fresh ArrayBuffer: Float32Array needs 4-byte alignment.
      resolve(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 4))));
    });
  });
}

// Best-effort per utterance: an unreadable file is left out of the mix, not fatal to it.
async function decodeUtterance(u) {
  try {
    return decodeWavMono48k(fs.readFileSync(u.abs)) ?? await decodeWithFfmpeg(u.abs);
  } catch (e) {
    warn('finalize: merged mix skips', path.basename(u.abs), '-', e.message);
    return null;
  }
}

// Yield the mix as consecutive mono float32 PCM blocks: a plain unnormalized
// sum (= amix normalize=0), as long as the latest-ending utterance. Only the
// utterances overlapping the current block are decoded and held in memory.
export async function* mixBlocks(timeline, decode = decodeUtterance, blockSamples = MIX_BLOCK) {
  if (timeline.length && timeline[timeline.length - 1].offset >= MIX_MAX_SAMPLES) {
    throw new Error('merged mix timeline exceeds 24 h');
  }
  let next = 0;
  let active = [];
  let end = 0; // furthest sample reached by any utterance decoded so far
  for (let cursor = 0; ; cursor += blockSamples) {
    while (next < timeline.length && timeline[next].offset < cursor + blockSamples) {
      const { u, offset } = timeline[next++];
      const samples = await decode(u);
      if (!samples?.length) continue;
      active.push({ offset, samples });
      end = Math.max(end, offset + samples.length);
    }
    const pending = next < timeline.length;
    if (!pending && end === 0) throw new Error('no decodable utterance audio');
    if (!pending && cursor >= end) return;
    const len = pending ? blockSamples : Math.min(blockSamples, end - cursor);
    const block = new Float32Array(len);
    for (const a of active) {
      const to = Math.min(cursor + len, a.offset + a.samples.length);
      for (let s = Math.max(cursor, a.offset); s < to; s++) block[s - cursor] += a.samples[s - a.offset];
    }
    active = active.filter((a) => a.offset + a.samples.length > cursor + len);
    yield Buffer.from(block.buffer);
  }
}

// Mix utterances onto one timeline and encode it to outPath (Opus).
export async function writeMergedMix(utterances, outPath, { bitrate = OPUS_BITRATE, spawnFn = spawn, decode } = {}) {
  const ff = spawnFn('ffmpeg', mixEncodeArgs(outPath, bitrate), { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr?.on('data', (d) => { err += d.toString(); });
  const exited = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`)));
  });
  exited.catch(() => {}); // awaited below; an early exit must not be an unhandled rejection meanwhile
  // A dying ffmpeg makes the pump fail with EPIPE; report ffmpeg's own error first.
  const pumpErr = await pipeline(Readable.from(mixBlocks(mixTimeline(utterances), decode)), ff.stdin)
    .then(() => null, (e) => e);
  try {
    await exited;
    if (pumpErr) throw pumpErr;
  } catch (e) {
    fs.rmSync(outPath, { force: true }); // no half-written mix in the archive
    throw e;
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr?.on('data', (d) => { err += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`)));
  });
}

// Build the audio archive under <archiveDir>/audio/:
//   <basename>.wav          — per-utterance ORIGINAL (lossless master + re-finalize source)
//   session_mix.ogg         — merged listening mix (Opus, small)
//   index.json              — basename → { userId, label, startMs, durationMs }
// Per-utterance format is WAV by default (the lossless master stays on the
// server, and re-finalize reads it back). Set ARCHIVE_AUDIO_FORMAT=ogg to store
// compressed per-utterance Opus instead (re-encode path kept for later A/B
// testing of whether OGG changes Whisper transcription — note: OGG per-utterance
// breaks archive re-finalize until an OGG→PCM decode path exists).
export async function buildAudioArchive({ manifest, uploadDir, archiveDir, verified = null }) {
  const audioDir = path.join(archiveDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });

  const utterances = (manifest.utterances || [])
    .filter((u) => (!verified || verified.has(u.file)))
    .map((u) => ({ ...u, abs: path.join(uploadDir, u.file) }))
    .filter((u) => fs.existsSync(u.abs));

  const perUtteranceOgg = (process.env.ARCHIVE_AUDIO_FORMAT ?? 'wav').toLowerCase() === 'ogg' && hasFfmpeg();

  const index = utterances.map((u) => ({
    file: perUtteranceOgg ? path.basename(u.file).replace(/\.wav$/i, '') + '.ogg' : path.basename(u.file),
    userId: u.userId != null ? String(u.userId) : null,
    username: u.username ?? null,
    startMs: u.startMs ?? 0,
    durationMs: u.durationMs ?? 0,
  }));
  fs.writeFileSync(path.join(audioDir, 'index.json'), JSON.stringify(index, null, 2));

  if (utterances.length === 0) {
    return { files: [], ok: true, error: null, format: 'none' };
  }

  const files = [];
  // Per-utterance: copy originals (default) or re-encode to Opus.
  for (const u of utterances) {
    const base = path.basename(u.file);
    if (perUtteranceOgg) {
      const out = path.join(audioDir, base.replace(/\.wav$/i, '') + '.ogg');
      try { await runFfmpeg(encodeOggArgs(u.abs, out)); files.push(path.relative(archiveDir, out)); }
      catch (e) { warn('finalize: per-utterance encode failed for', base, '-', e.message); }
    } else {
      const dst = path.join(audioDir, base);
      // Guard self-copy when re-finalizing from the archive itself.
      if (path.resolve(dst) !== path.resolve(u.abs)) fs.copyFileSync(u.abs, dst);
      files.push(path.relative(archiveDir, dst));
    }
  }

  // Merged listening mix (small, harmless). Best-effort.
  if (hasFfmpeg()) {
    try {
      const mixOut = path.join(audioDir, 'session_mix.ogg');
      await writeMergedMix(utterances, mixOut);
      files.push(path.relative(archiveDir, mixOut));
      debug('finalize: merged mix written', mixOut);
    } catch (e) {
      warn('finalize: merged mix failed:', e.message);
    }
  }

  return { files, ok: true, error: null, format: perUtteranceOgg ? 'ogg' : 'wav' };
}
