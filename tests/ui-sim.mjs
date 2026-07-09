// End-to-End-Simulation des Streaming-STT für die Transkript-Web-UI.
//
// Startet den ECHTEN Server auf Port 7441 (Auth aus, eigene Test-Transkripte
// unter tests/.cache/) und speist tests/Quantengravitation.m4a in Echtzeit als
// Opus-Frames in eine Fake-Session ein. Der reguläre Streaming-Loop
// transkribiert gegen den whisper.cpp-Server (:8080, muss laufen) und die
// Wort-für-Wort-Partials erscheinen live im Browser:
//
//   node tests/ui-sim.mjs
//   → http://127.0.0.1:7441/transcript/?sessionId=1780000000001
//
// Am Ende läuft der echte utterance_end-Pfad (finalize); der Prozess bleibt
// danach für die Inspektion offen (Strg+C beendet).
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(testsDir);
const serverSrc = pathToFileURL(path.join(repoRoot, 'apps/server/src')).href;
const cacheDir = path.join(testsDir, '.cache');
fs.mkdirSync(cacheDir, { recursive: true });

// Testaudio: 48 kHz mono PCM-WAV, on-demand aus dem m4a konvertiert (ffmpeg).
const wav = path.join(cacheDir, 'quanten_full_48k.wav');
if (!fs.existsSync(wav)) {
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-i', path.join(testsDir, 'Quantengravitation.m4a'),
    '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
}

// Test-Env VOR dem Server-Import setzen (dotenv überschreibt vorhandene nicht).
process.env.PORT ??= '7441';
process.env.HOST ??= '127.0.0.1';
process.env.TRANSCRIPT_UI_AUTH ??= 'off';
process.env.WHISPER_URL ??= 'http://localhost:8080';
process.env.WHISPER_LANGUAGE ??= 'de';
process.env.WHISPER_TEMPERATURE ??= '0.1';
process.env.STT_STREAMING ??= 'true';
process.env.LIVE_CONTEXT_ENABLED ??= 'true';
process.env.DEBUG ??= '';
process.env.TRANSCRIPT_DIR = path.join(cacheDir, 'transcripts');
process.env.CONFIG_OVERRIDES_FILE = path.join(cacheDir, 'overrides.json');
// Echte Speaker-Map des Servers (die Sim läuft im Repo-Root, nicht in apps/server).
process.env.SPEAKER_MAP_FILE ??= path.join(repoRoot, 'apps/server/data/speaker-map.json');
fs.writeFileSync(process.env.CONFIG_OVERRIDES_FILE, '{}');

await import(`${serverSrc}/index.js`);
const { ensureSession, ensureSpeaker } = await import(`${serverSrc}/state.js`);
const { runPipeline } = await import(`${serverSrc}/pipeline.js`);
const { readWavPcm } = await import(`${serverSrc}/finalize/sttFile.js`);
const { publishPresence } = await import(`${serverSrc}/liveBus.js`);
const { createRequire } = await import('module');
const opus = createRequire(`${serverSrc}/`)('@discordjs/opus');

const SR = 48000;
const FRAME = 960; // 20 ms
const SID = 1780000000001n;

const pcm = readWavPcm(wav);
const totalSec = pcm.length / 2 / SR;

// Zwei Sprecher: Markus liest den ganzen Absatz (ein langer Monolog), Nogard
// unterbricht zweimal mit kurzen Passagen aus demselben Audio — das erzeugt
// die Unterbrecher-Blasen (floatInto) live im Web-UI. Jeder Clip ist eine
// eigene Utterance (utterance_end 1,2 s nach Clip-Ende, wie der Bot es täte).
const speakers = [
  { uid: 424242424242n, name: 'Markus', clips: [{ atSec: 0, fromSec: 0, toSec: totalSec }] },
  { uid: 555555555555n, name: 'Nogard', clips: [
    { atSec: 20, fromSec: 5, toSec: 12 },
    { atSec: 48, fromSec: 30, toSec: 36 },
  ] },
];

const session = ensureSession(SID);
session.guildName = 'Testgilde';
session.channelName = 'stt-streaming-test';
session.voice.state = 'occupied';
for (const s of speakers) session.voice.members.set(String(s.uid), s.name);
session.voice.updatedAt = Date.now();
publishPresence(SID);

const enc = new Map(); // one encoder per speaker (stateful codec)
for (const s of speakers) {
  const sp = ensureSpeaker(SID, s.uid);
  sp.codec = 'opus';
  sp.opusBuffer = [];
  s.sp = sp;
  enc.set(s.uid, new opus.OpusEncoder(SR, 1));
  for (const c of s.clips) {
    c.frames = Math.floor((c.toSec - c.fromSec) * SR / FRAME);
    c.fed = 0;
    c.startedAt = null;
  }
}

console.log(`[sim] ${totalSec.toFixed(1)}s Audio, ${speakers.length} Sprecher — Echtzeit-Einspeisung startet`);
console.log(`[sim] UI: http://127.0.0.1:${process.env.PORT}/transcript/?sessionId=${SID}`);

const simStart = Date.now();
const pending = [];
await new Promise((resolve) => {
  const timer = setInterval(() => {
    const simSec = (Date.now() - simStart) / 1000;
    let anyLeft = false;
    for (const s of speakers) {
      for (const c of s.clips) {
        if (c.fed >= c.frames) continue;
        anyLeft = true;
        if (simSec < c.atSec) continue;
        if (c.startedAt === null) {
          c.startedAt = Date.now();
          console.log(`[sim] ${s.name} beginnt bei ${simSec.toFixed(0)}s (${(c.toSec - c.fromSec).toFixed(0)}s Clip)`);
        }
        for (let k = 0; k < 5 && c.fed < c.frames; k++, c.fed++) {
          const sample = Math.floor(c.fromSec * SR) + c.fed * FRAME;
          const slice = pcm.subarray(sample * 2, (sample + FRAME) * 2);
          try { s.sp.opusBuffer.push(enc.get(s.uid).encode(slice)); }
          catch (e) { console.error('[sim] encode:', e.message); }
        }
        if (c.fed >= c.frames) {
          // Clip fertig → utterance_end nach 1,2 s (Bot-Stille-Erkennung)
          const meta = { userDisplayName: s.name, startTsMs: c.startedAt, endTsMs: Date.now(), durationMs: Date.now() - c.startedAt };
          pending.push(new Promise((r) => setTimeout(() => {
            console.log(`[sim] utterance_end ${s.name} (${(c.toSec - c.fromSec).toFixed(0)}s)`);
            runPipeline(SID, s.uid, meta).catch((e) => console.error('[sim] pipeline:', e.message)).finally(r);
          }, 1200)));
        }
      }
    }
    if (!anyLeft) { clearInterval(timer); resolve(); }
  }, 100);
});

await Promise.all(pending);
console.log('[sim] alle Utterances finalisiert — Server bleibt für UI-Inspektion offen (Strg+C beendet)');
