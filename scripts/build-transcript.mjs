#!/usr/bin/env node
// Offline transcript builder. Renders a readable Markdown transcript from a
// session JSONL log (the live/fallback path — uses the live STT text and word
// timestamps already in the log). The server's /finalize flow re-transcribes
// from the archived WAVs for the authoritative pass; this CLI is for quick
// offline rebuilds, debugging, and re-finalizing old sessions from JSONL.
//
// Usage:
//   node scripts/build-transcript.mjs <session_*.jsonl> [options]
// Options:
//   --out <file.md>        write to file (default: stdout)
//   --tz <IANA tz>         timezone for timestamps (default: Europe/Berlin)
//   --speaker-map <json>   path to a speaker-map JSON ({ "<userId>": {player,character} })
//   --pause <seconds>      pause-header threshold (default: 30)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildModelFromEvents, mergeTranscript } from '../apps/server/src/finalize/merge.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--tz') args.tz = argv[++i];
    else if (a === '--speaker-map') args.speakerMap = argv[++i];
    else if (a === '--pause') args.pause = Number(argv[++i]);
    else args._.push(a);
  }
  return args;
}

function parseJsonl(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* skip malformed line */ }
  }
  return events;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args._[0];
  if (!input) {
    console.error('usage: build-transcript.mjs <session_*.jsonl> [--out f.md] [--tz tz] [--speaker-map m.json] [--pause secs]');
    process.exit(2);
  }
  const raw = fs.readFileSync(input, 'utf8');
  const events = parseJsonl(raw);
  if (events.length === 0) {
    console.error('no events parsed from', input);
    process.exit(1);
  }

  let speakerMap = {};
  const meta = events.find((e) => e && e.type === 'session_meta') || {};
  if (meta.users && typeof meta.users === 'object') speakerMap = { ...meta.users };
  if (args.speakerMap) {
    try { speakerMap = { ...speakerMap, ...JSON.parse(fs.readFileSync(args.speakerMap, 'utf8')) }; }
    catch (e) { console.error('speaker-map read failed:', e.message); }
  }

  const wakeWord = meta.wakeword?.word ?? 'Rabenauge';
  const stopPhrases = Array.isArray(meta.stopPhrases) ? meta.stopPhrases : [];

  const model = buildModelFromEvents(events, { speakerMap, assistantName: wakeWord });
  const md = mergeTranscript(model, {
    timeZone: args.tz || 'Europe/Berlin',
    pauseThresholdS: Number.isFinite(args.pause) ? args.pause : 30,
    wakeWord,
    stopPhrases,
    assistantName: wakeWord,
    speakerMap,
    channelName: meta.channelName || null,
    guildName: meta.guildName || null,
  });

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, md);
    console.error('wrote', args.out, `(${md.length} bytes)`);
  } else {
    process.stdout.write(md);
  }
}

main();
