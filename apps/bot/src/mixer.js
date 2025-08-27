import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { log, debug } from './logger.js';

// Hilfsfunktion: ffmpeg run mit bestimmter Bitrate
function runFfmpeg(inputs, filter, outFile, options = {}) {
  const args = [];
  for (const t of inputs) args.push('-i', t.file);
  args.push('-filter_complex', filter);

  if (options.hq) {
    args.push('-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on', '-application', 'audio');
  } else {
    args.push('-c:a', 'libopus', '-b:a', '48k', '-vbr', 'on', '-application', 'voip');
  }
  args.push(outFile);

  debug('ffmpeg args:', args.join(' '));
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', ...args], { stdio: 'inherit' });
    ff.on('close', (code) => code === 0 ? resolve(outFile) : reject(new Error('ffmpeg fail ' + code)));
  });
}

export async function mixSession(sessionDir, outBase = 'session_mix', timeline = []) {
  if (!timeline.length) throw new Error('Timeline ist leer');

  // Startzeit normalisieren
  const minStart = Math.min(...timeline.map(t => t.startMs));
  const delays = timeline.map((t, idx) => {
    const d = Math.max(0, Math.round(t.startMs - minStart));
    return `[${idx}:a]adelay=${d}|${d}[a${idx}]`;
  }).join(';');
  const maps = timeline.map((_, idx) => `[a${idx}]`).join('');
  const filter = `${delays};${maps}amix=inputs=${timeline.length}:normalize=0,aresample=48000,pan=mono|c0=c0`;

  // Gesamtmix HQ/LQ
  await runFfmpeg(timeline, filter, path.join(sessionDir, `${outBase}_hq.ogg`), { hq: true });
  await runFfmpeg(timeline, filter, path.join(sessionDir, `${outBase}_lq.ogg`), { hq: false });

  // Sprecherweise Mixes
  const byUser = {};
  for (const t of timeline) {
    (byUser[t.userId] ||= []).push(t);
  }
  for (const [uid, chunks] of Object.entries(byUser)) {
    chunks.sort((a, b) => a.startMs - b.startMs);
    const minU = Math.min(...chunks.map(c => c.startMs));
    const dly = chunks.map((t, idx) => {
      const d = Math.max(0, Math.round(t.startMs - minU));
      return `[${idx}:a]adelay=${d}|${d}[a${idx}]`;
    }).join(';');
    const map = chunks.map((_, idx) => `[a${idx}]`).join('');
    const filt = `${dly};${map}amix=inputs=${chunks.length}:normalize=0,aresample=48000,pan=mono|c0=c0`;

    const uname = chunks[0].username.replace(/[^a-z0-9_-]+/gi, '_');
    await runFfmpeg(chunks, filt, path.join(sessionDir, `user_${uname}_hq.ogg`), { hq: true });
    await runFfmpeg(chunks, filt, path.join(sessionDir, `user_${uname}_lq.ogg`), { hq: false });
  }

  log('Mixes erstellt (HQ/LQ, per User + Gesamt).');
}
