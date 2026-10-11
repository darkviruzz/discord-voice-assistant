#!/usr/bin/env node
// STT benchmark: runs reference recordings through the server's REAL finalize
// transcription path (silence split → providers → token merge) for one or more
// provider profiles and scores the result against a hand-corrected transcript.
//
//   WER / CER       overall recognition quality (punctuation/case ignored)
//   Namen-Recall    share of proper-name occurrences (bench/stt/names.txt) that
//                   came out exactly — the number that matters for a campaign,
//                   WER barely moves when "Kelthur" becomes "Kelt Ur"
//   RTF             processing time / audio duration (< 1 = faster than real time)
//
// Layout (see bench/stt/README.md):
//   bench/stt/<sample>.(wav|m4a|mp3|ogg|flac|opus)   audio
//   bench/stt/<sample>.txt                           reference transcript
//   bench/stt/names.txt                              one proper name per line (optional)
//   bench/stt/profiles.json                          provider profiles (optional;
//                                                    default = current apps/server/.env)
//
// Usage:
//   npm run bench:stt -- [--dir bench/stt] [--profiles file.json] [--only name[,name]]
//                        [--with-example] [--out report.md]
// Needs ffmpeg in PATH (decodes any input to 48 kHz mono PCM like the bot records).

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { wer, cer, nameRecall } from './lib/wer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO_EXT = new Set(['.wav', '.m4a', '.mp3', '.ogg', '.flac', '.opus', '.webm']);

function parseArgs(argv) {
  const a = { dir: path.join(ROOT, 'bench', 'stt'), profiles: null, only: null, withExample: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dir') a.dir = path.resolve(argv[++i]);
    else if (k === '--profiles') a.profiles = path.resolve(argv[++i]);
    else if (k === '--only') a.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--with-example') a.withExample = true;
    else if (k === '--out') a.out = path.resolve(argv[++i]);
    else if (k === '-h' || k === '--help') { a.help = true; }
    else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}

function findSamples(dir, withExample) {
  const samples = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      const ext = path.extname(f).toLowerCase();
      if (!AUDIO_EXT.has(ext)) continue;
      const ref = path.join(dir, path.basename(f, ext) + '.txt');
      if (!fs.existsSync(ref)) { console.warn(`! ${f}: keine Referenz ${path.basename(ref)} — übersprungen`); continue; }
      samples.push({ name: path.basename(f, ext), audio: path.join(dir, f), ref });
    }
  }
  if (withExample) {
    samples.push({ name: 'beispiel-quantengravitation', audio: path.join(ROOT, 'tests', 'Quantengravitation.m4a'), ref: path.join(ROOT, 'tests', 'transcript.txt') });
  }
  return samples;
}

function readNames(dir) {
  const f = path.join(dir, 'names.txt');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
}

function readProfiles(file) {
  if (!file) return [{ name: 'aktuell (.env)', env: {} }];
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(list) || !list.every((p) => p && typeof p.name === 'string')) {
    throw new Error(`${file}: erwartet ein Array von { name, env }`);
  }
  return list.map((p) => ({ name: p.name, env: p.env ?? {} }));
}

// Decode anything ffmpeg understands to raw 48 kHz mono s16le (what the bot
// records and the finalize path expects).
function decodeToPcm48k(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '48000', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', (e) => reject(new Error(`ffmpeg nicht startbar (${e.message}) — ffmpeg installieren`)));
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exit ${code}: ${err.trim()}`))));
  });
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) { saved[k] = process.env[k]; process.env[k] = String(v); }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)} %`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  // Same config the server uses; profile env overrides win.
  dotenv.config({ path: path.join(ROOT, 'apps', 'server', '.env') });
  // Bench must not spam the live transcript/debug paths.
  process.env.STT_STREAMING = 'false';

  // @discordjs/opus' node-pre-gyp parses process.argv at load time and would
  // take our `--dir` for its own option (→ ENOENT on a bogus package.json).
  const argv = process.argv;
  process.argv = argv.slice(0, 2);
  let transcribeChunked;
  try { ({ transcribeChunked } = await import('../apps/server/src/pipeline.js')); }
  finally { process.argv = argv; }
  const samples = findSamples(args.dir, args.withExample);
  if (samples.length === 0) {
    console.error(`Keine Samples in ${args.dir} (Audio + gleichnamige .txt). Tipp: --with-example nutzt tests/Quantengravitation.m4a.`);
    process.exitCode = 2;
    return;
  }
  const names = readNames(args.dir);
  let profiles = readProfiles(args.profiles ?? (fs.existsSync(path.join(args.dir, 'profiles.json')) ? path.join(args.dir, 'profiles.json') : null));
  if (args.only) profiles = profiles.filter((p) => args.only.includes(p.name));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const resultDir = path.join(args.dir, 'results', stamp);
  fs.mkdirSync(resultDir, { recursive: true });

  const pcmCache = new Map();
  const rows = [];
  for (const profile of profiles) {
    for (const s of samples) {
      if (!pcmCache.has(s.audio)) pcmCache.set(s.audio, await decodeToPcm48k(s.audio));
      const pcm = pcmCache.get(s.audio);
      const durSec = pcm.length / 2 / 48000;
      const reference = fs.readFileSync(s.ref, 'utf8');
      process.stdout.write(`… ${profile.name} · ${s.name} (${durSec.toFixed(0)} s) `);
      const t0 = performance.now();
      let hyp = '';
      let error = null;
      try {
        const r = await withEnv(profile.env, () => transcribeChunked(pcm));
        hyp = r.transcripts.join(' ').trim();
      } catch (e) { error = e.message; }
      const secs = (performance.now() - t0) / 1000;
      const w = wer(reference, hyp);
      const row = {
        profile: profile.name, sample: s.name, durSec, rtf: secs / durSec,
        wer: error ? null : w.wer, sub: w.substitutions, del: w.deletions, ins: w.insertions, refWords: w.refWords,
        cer: error ? null : cer(reference, hyp),
        names: error ? null : nameRecall(reference, hyp, names),
        error,
      };
      rows.push(row);
      const safe = `${profile.name}__${s.name}`.replace(/[^A-Za-z0-9._-]+/g, '_');
      fs.writeFileSync(path.join(resultDir, `${safe}.txt`), error ? `FEHLER: ${error}\n` : hyp + '\n');
      console.log(error ? `FEHLER: ${error}` : `WER ${pct(row.wer)} · RTF ${row.rtf.toFixed(2)}`);
    }
  }

  const lines = [
    `# STT-Benchmark ${stamp}`, '',
    `Samples: ${samples.map((s) => s.name).join(', ')} · Namen: ${names.length}`, '',
    '| Profil | Sample | Dauer | RTF | WER | (S/D/I) | CER | Namen-Recall |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(`| ${r.profile} | ${r.sample} | ${r.durSec.toFixed(0)} s | ${r.error ? '—' : r.rtf.toFixed(2)} | ${r.error ? `FEHLER: ${r.error.slice(0, 60)}` : pct(r.wer)} | ${r.error ? '' : `${r.sub}/${r.del}/${r.ins}`} | ${pct(r.cer)} | ${r.names?.recall == null ? '—' : `${pct(r.names.recall)} (${r.names.found}/${r.names.expected})`} |`);
  }
  lines.push('', '## Gesamt pro Profil (gewichtet nach Referenzwörtern)', '', '| Profil | WER | Namen-Recall | RTF |', '|---|---|---|---|');
  for (const p of profiles) {
    const rs = rows.filter((r) => r.profile === p.name && !r.error);
    const words = rs.reduce((n, r) => n + r.refWords, 0);
    const errs = rs.reduce((n, r) => n + r.sub + r.del + r.ins, 0);
    const exp = rs.reduce((n, r) => n + (r.names?.expected ?? 0), 0);
    const fnd = rs.reduce((n, r) => n + (r.names?.found ?? 0), 0);
    const dur = rs.reduce((n, r) => n + r.durSec, 0);
    const proc = rs.reduce((n, r) => n + r.rtf * r.durSec, 0);
    lines.push(`| ${p.name} | ${words ? pct(errs / words) : '—'} | ${exp ? `${pct(fnd / exp)} (${fnd}/${exp})` : '—'} | ${dur ? (proc / dur).toFixed(2) : '—'} |`);
  }
  const missed = new Map();
  for (const r of rows) for (const n of r.names?.perName ?? []) if (n.found < n.expected) missed.set(`${r.profile}: ${n.name}`, (missed.get(`${r.profile}: ${n.name}`) ?? 0) + n.expected - n.found);
  if (missed.size) {
    lines.push('', '## Verfehlte Namen', '');
    for (const [k, v] of [...missed].sort((a, b) => b[1] - a[1])) lines.push(`- ${k} (${v}×)`);
  }
  const report = lines.join('\n') + '\n';
  fs.writeFileSync(path.join(resultDir, 'report.md'), report);
  if (args.out) fs.writeFileSync(args.out, report);
  console.log('\n' + report + `\nHypothesen + Report: ${resultDir}`);
}

main().catch((e) => { console.error(process.env.BENCH_DEBUG ? e.stack : e.message); process.exitCode = 1; });
