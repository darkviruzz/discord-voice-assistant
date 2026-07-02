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
const UID = 424242424242n;

const pcm = readWavPcm(wav);
const totalFrames = Math.floor(pcm.length / 2 / FRAME);

const session = ensureSession(SID);
session.guildName = 'Testgilde';
session.channelName = 'stt-streaming-test';
session.voice.state = 'occupied';
session.voice.members.set(String(UID), 'Markus');
session.voice.updatedAt = Date.now();
publishPresence(SID);

const sp = ensureSpeaker(SID, UID);
sp.codec = 'opus';
sp.opusBuffer = [];

const enc = new opus.OpusEncoder(SR, 1);
console.log(`[sim] ${totalFrames} Frames (${(totalFrames * 0.02).toFixed(1)}s) — Echtzeit-Einspeisung startet`);
console.log(`[sim] UI: http://127.0.0.1:${process.env.PORT}/transcript/?sessionId=${SID}`);

const startTsMs = Date.now();
let fed = 0;
await new Promise((resolve) => {
  const timer = setInterval(() => {
    for (let k = 0; k < 5 && fed < totalFrames; k++, fed++) {
      const slice = pcm.subarray(fed * FRAME * 2, (fed + 1) * FRAME * 2);
      try { sp.opusBuffer.push(enc.encode(slice)); } catch (e) { console.error('[sim] encode:', e.message); }
    }
    if (fed % 1000 === 0) console.log(`[sim] ${(fed * 0.02).toFixed(0)}s eingespeist`);
    if (fed >= totalFrames) { clearInterval(timer); resolve(); }
  }, 100);
});

console.log('[sim] Audio komplett — utterance_end in 1.2s');
await new Promise((r) => setTimeout(r, 1200));
const endTsMs = Date.now();
await runPipeline(SID, UID, {
  userDisplayName: 'Markus',
  startTsMs,
  endTsMs,
  durationMs: endTsMs - startTsMs,
});
console.log('[sim] runPipeline fertig — Server bleibt für UI-Inspektion offen (Strg+C beendet)');
