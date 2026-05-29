import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { debug, warn } from '../logger.js';

const OPUS_BITRATE = process.env.ARCHIVE_OPUS_BITRATE ?? '32k';

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

// Pure: ffmpeg args to mix utterances onto one timeline (each delayed by its
// startMs relative to the earliest), normalize=0 to preserve levels.
export function mergedMixArgs(utterances, outPath, bitrate = OPUS_BITRATE) {
  const minStart = Math.min(...utterances.map((u) => u.startMs || 0));
  const inputs = [];
  for (const u of utterances) inputs.push('-i', u.abs);
  const delays = utterances.map((u, idx) => {
    const d = Math.max(0, Math.round((u.startMs || 0) - minStart));
    return `[${idx}:a]adelay=${d}|${d}[a${idx}]`;
  }).join(';');
  const maps = utterances.map((_, idx) => `[a${idx}]`).join('');
  const filter = `${delays};${maps}amix=inputs=${utterances.length}:normalize=0,aresample=48000,pan=mono|c0=c0`;
  return ['-y', ...inputs, '-filter_complex', filter,
    '-c:a', 'libopus', '-b:a', bitrate, '-vbr', 'on', '-application', 'voip', outPath];
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
      await runFfmpeg(mergedMixArgs(utterances, mixOut));
      files.push(path.relative(archiveDir, mixOut));
      debug('finalize: merged mix written', mixOut);
    } catch (e) {
      warn('finalize: merged mix failed:', e.message);
    }
  }

  return { files, ok: true, error: null, format: perUtteranceOgg ? 'ogg' : 'wav' };
}
