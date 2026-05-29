import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { finalizeSession, buildFinalizeModel, verifyUploads, sha256File } from '../src/finalize/index.js';

const BASE = 1_700_000_000_000;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-test-'));
}
function writeWav(dir, name, content) {
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, Buffer.from(content));
  return { name, sha256: crypto.createHash('sha256').update(Buffer.from(content)).digest('hex') };
}

// Deterministic fake STT keyed by file basename.
const fakeStt = (transcripts) => async (absPath) => {
  const base = path.basename(absPath);
  return transcripts[base] || { text: '', words: null };
};

function baseManifest(uploadDir) {
  const a = writeWav(uploadDir, 'a.wav', 'AUDIO-A');
  const b = writeWav(uploadDir, 'b.wav', 'AUDIO-B');
  return {
    sessionStartMs: BASE,
    channelName: 'Spieltisch',
    guildName: 'Drachenhort',
    wakeWord: 'Rabenauge',
    utterances: [
      { userId: '111', username: 'Hauke', file: a.name, sha256: a.sha256, startMs: 0, durationMs: 2000 },
      { userId: '222', username: 'Greta', file: b.name, sha256: b.sha256, startMs: 3000, durationMs: 1000 },
    ],
  };
}

const events = [
  { type: 'session_meta', sessionId: String(BASE), tsMs: BASE, users: { '111': { player: 'Hauke', character: 'Thrain' } }, wakeword: { word: 'Rabenauge' }, stopPhrases: ['stop'] },
  { type: 'wakeword_query', sessionId: String(BASE), tsMs: BASE + 1500, userId: '111', query: 'öffne die Tür' },
  { type: 'assistant_response', sessionId: String(BASE), tsMs: BASE + 2500, text: 'Die Tür öffnet sich.' },
];

test('verifyUploads classifies present / missing / mismatched', () => {
  const dir = tmpdir();
  const manifest = baseManifest(dir);
  const v1 = verifyUploads(manifest, dir);
  assert.equal(v1.verified.size, 2);
  assert.deepEqual(v1.missing, []);

  manifest.utterances[1].sha256 = 'deadbeef';
  const v2 = verifyUploads(manifest, dir);
  assert.equal(v2.verified.size, 1);
  assert.deepEqual(v2.mismatched, ['b.wav']);

  manifest.utterances.push({ userId: '333', username: 'X', file: 'gone.wav', startMs: 9000, durationMs: 100 });
  const v3 = verifyUploads(manifest, dir);
  assert.deepEqual(v3.missing, ['gone.wav']);
});

test('buildFinalizeModel uses re-STT for users + carries assistant overlay', async () => {
  const dir = tmpdir();
  const manifest = baseManifest(dir);
  const { verified } = verifyUploads(manifest, dir);
  const model = await buildFinalizeModel({
    sessionId: String(BASE), manifest, events, uploadDir: dir, verified,
    speakerMap: { '111': { player: 'Hauke', character: 'Thrain' } },
    transcribeFn: fakeStt({
      'a.wav': { text: 'Ich gehe durch die Tür', words: [{ w: 'Ich', t0: 0, t1: 300 }, { w: 'Tür', t0: 1800, t1: 2000 }] },
      'b.wav': { text: 'Moment mal', words: null },
    }),
  });
  const users = model.spans.filter((s) => s.type === 'user');
  const asst = model.spans.filter((s) => s.type === 'assistant');
  assert.equal(users.length, 2);
  assert.equal(asst.length, 1);
  const hauke = users.find((s) => s.userId === '111');
  assert.equal(hauke.startMs, BASE + 0);
  assert.equal(hauke.label, 'Hauke (Thrain)');
  assert.ok(Array.isArray(hauke.words));
});

test('finalizeSession writes transcript + archive with checksums', async () => {
  const upload = tmpdir();
  const out = tmpdir();
  const manifest = baseManifest(upload);
  const result = await finalizeSession({
    sessionId: String(BASE), manifest, events, uploadDir: upload,
    archiveRoot: path.join(out, 'archive'),
    transcriptRoot: path.join(out, 'transcripts'),
    transcribeFn: fakeStt({
      'a.wav': { text: 'Rabenauge öffne die Tür', words: null },
      'b.wav': { text: 'Moment mal', words: null },
    }),
    opts: { timeZone: 'UTC' },
  });

  assert.ok(result.ok);
  assert.ok(fs.existsSync(result.transcriptPath));
  const md = fs.readFileSync(result.transcriptPath, 'utf8');
  assert.match(md, /\*\*Hauke \(Thrain\):\*\*/);
  assert.match(md, /\*\*Rabenauge:\*\* Die Tür öffnet sich\./);
  assert.match(md, /\*\*Rabenauge\*\* öffne/); // wake word bolded in user text

  // Archive contains the expected files, each checksummed.
  const names = result.files.map((f) => f.name).sort();
  for (const want of ['transcript.md', 'manifest.json', 'speaker-map.json', 'session.jsonl']) {
    assert.ok(names.includes(want), `archive missing ${want}`);
  }
  for (const f of result.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.bytes > 0);
    assert.equal(f.sha256, sha256File(path.join(result.archiveDir, f.name)));
  }
  // Audio copies present.
  assert.ok(fs.existsSync(path.join(result.archiveDir, 'audio', 'a.wav')));
});

test('finalizeSession finalizes the verified subset when an upload is corrupt', async () => {
  const upload = tmpdir();
  const out = tmpdir();
  const manifest = baseManifest(upload);
  manifest.utterances[1].sha256 = 'deadbeef'; // b.wav now mismatches
  const result = await finalizeSession({
    sessionId: String(BASE), manifest, events, uploadDir: upload,
    archiveRoot: path.join(out, 'archive'),
    transcriptRoot: path.join(out, 'transcripts'),
    transcribeFn: fakeStt({
      'a.wav': { text: 'Nur ich werde transkribiert', words: null },
      'b.wav': { text: 'sollte fehlen', words: null },
    }),
    opts: { timeZone: 'UTC' },
  });
  assert.deepEqual(result.mismatched, ['b.wav']);
  assert.equal(result.userCount, 1);
  const md = fs.readFileSync(result.transcriptPath, 'utf8');
  assert.doesNotMatch(md, /sollte fehlen/);
});

test('re-finalize from the archive (no upload) reuses archived WAVs', async () => {
  const upload = tmpdir();
  const out = tmpdir();
  const manifest = baseManifest(upload);
  const archiveRoot = path.join(out, 'archive');
  const transcriptRoot = path.join(out, 'transcripts');
  const stt = fakeStt({ 'a.wav': { text: 'Erste Aussage', words: null }, 'b.wav': { text: 'Zweite Aussage', words: null } });

  const r1 = await finalizeSession({
    sessionId: String(BASE), manifest, events, uploadDir: upload,
    archiveRoot, transcriptRoot, transcribeFn: stt, opts: { timeZone: 'UTC' },
  });
  const audioDir = path.join(r1.archiveDir, 'audio');
  assert.ok(fs.existsSync(path.join(audioDir, 'a.wav')), 'originals copied into archive');

  // Re-finalize: source IS the archive audio dir; must not delete it.
  const archManifest = JSON.parse(fs.readFileSync(path.join(r1.archiveDir, 'manifest.json'), 'utf8'));
  const r2 = await finalizeSession({
    sessionId: String(BASE), manifest: archManifest, events, uploadDir: audioDir,
    archiveRoot, transcriptRoot, transcribeFn: stt, opts: { timeZone: 'UTC' }, cleanupUploadDir: false,
  });
  assert.ok(r2.ok);
  assert.equal(r2.userCount, 2);
  assert.ok(fs.existsSync(path.join(audioDir, 'a.wav')), 'archive WAVs preserved after re-finalize');
});
