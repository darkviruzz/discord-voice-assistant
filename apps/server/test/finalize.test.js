import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { finalizeSession, buildFinalizeModel, verifyUploads, sha256File } from '../src/finalize/index.js';
import { summarizeSession } from '../src/finalize/summary.js';

const BASE = 1_700_000_000_000;

const tmpRoots = [];
after(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-test-'));
  tmpRoots.push(d);
  return d;
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

test('the session summary sees the players only — not the assistant\'s replies', async () => {
  const upload = tmpdir();
  const out = tmpdir();
  const manifest = { ...baseManifest(upload), wakeWord: 'Orakel' };
  const evs = [
    { ...events[0], wakeword: { word: 'Orakel' } },
    { type: 'assistant_response', sessionId: String(BASE), tsMs: BASE + 2500, text: 'Baron Kelthur herrscht noch immer über Graufurt.' },
  ];
  const prompts = [];
  let opts = null;
  await finalizeSession({
    sessionId: String(BASE), manifest, events: evs, uploadDir: upload,
    archiveRoot: path.join(out, 'archive'), transcriptRoot: path.join(out, 'transcripts'),
    transcribeFn: fakeStt({
      'a.wav': { text: 'Orakel, wir reiten nach Graufurt und reden dort mit dem Hauptmann der Wache über den gestohlenen Vertrag.', words: null },
      'b.wav': { text: 'Ich behalte den Vertrag bei mir und lasse den Hauptmann nicht aus den Augen, bis wir wissen, wem er dient.', words: null },
    }),
    opts: {
      timeZone: 'UTC',
      summarizeFn: (md, o) => {
        opts = o;
        return summarizeSession(md, { ...o, completeFn: async ({ messages }) => { prompts.push(messages[1].content); return { content: 'Zusammenfassung.' }; } });
      },
    },
  });
  assert.equal(opts.assistantName, 'Orakel');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /gestohlenen Vertrag/);
  assert.match(prompts[0], /wem er dient/);
  assert.doesNotMatch(prompts[0], /herrscht noch immer/);
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

test('verifyUploads refuses manifest entries that are not plain basenames (no reads outside the upload dir)', () => {
  const root = tmpdir();
  const upload = path.join(root, 'upload');
  fs.mkdirSync(upload);
  fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP SECRET');
  const secretSha = sha256File(path.join(root, 'secret.txt'));
  const manifest = baseManifest(upload);
  const evil = ['../secret.txt', 'sub/../../secret.txt', '..', '.'];
  for (const file of evil) manifest.utterances.push({ userId: '9', username: 'X', file, sha256: secretSha, startMs: 0, durationMs: 1 });
  manifest.utterances.push({ userId: '9', username: 'X', file: '../secret.txt', startMs: 0, durationMs: 1 }); // no sha at all

  const v = verifyUploads(manifest, upload);
  assert.deepEqual([...v.verified].sort(), ['a.wav', 'b.wav']);
  for (const file of evil) assert.ok(v.mismatched.includes(file), `${file} refused`);
});

test('finalizeSession never transcribes or archives a file outside the upload dir', async () => {
  const root = tmpdir();
  const upload = path.join(root, 'upload');
  fs.mkdirSync(upload);
  fs.writeFileSync(path.join(root, 'secret.txt'), 'TOP SECRET');
  const manifest = baseManifest(upload);
  manifest.utterances.push({ userId: '9', username: 'Eve', file: '../secret.txt', startMs: 500, durationMs: 100 });
  const transcribed = [];
  const result = await finalizeSession({
    sessionId: String(BASE), manifest, events, uploadDir: upload,
    archiveRoot: path.join(root, 'archive'), transcriptRoot: path.join(root, 'transcripts'),
    transcribeFn: async (abs) => { transcribed.push(abs); return { text: 'gehört', words: null }; },
    opts: { timeZone: 'UTC' },
  });
  assert.ok(transcribed.every((p) => path.dirname(p) === upload), `transcribed outside upload dir: ${transcribed}`);
  assert.equal(fs.existsSync(path.join(result.archiveDir, 'audio', 'secret.txt')), false, 'secret not copied into the (bot-pullable) archive');
  assert.ok(result.mismatched.includes('../secret.txt'));
  assert.ok(fs.existsSync(upload), 'unverified upload dir kept for a retry');
});

test('finalizeSession keeps archive and transcript dirs inside their roots for any sessionName', async () => {
  for (const sessionName of ['..', '.', '/..', '../..', 'a/../..']) {
    const root = tmpdir();
    const upload = path.join(root, 'upload');
    fs.mkdirSync(upload);
    const manifest = { ...baseManifest(upload), sessionName };
    const archiveRoot = path.join(root, 'archive');
    const transcriptRoot = path.join(root, 'transcripts');
    const r = await finalizeSession({
      sessionId: String(BASE), manifest, events, uploadDir: upload, archiveRoot, transcriptRoot,
      transcribeFn: fakeStt({}), opts: { timeZone: 'UTC' },
    });
    assert.equal(path.dirname(r.archiveDir), path.resolve(archiveRoot), `archive escaped for sessionName=${sessionName}`);
    assert.equal(path.dirname(path.dirname(r.transcriptPath)), path.resolve(transcriptRoot), `transcript escaped for ${sessionName}`);
    assert.ok(!['.', '..'].includes(r.archiveName), `archiveName ${r.archiveName} must be pullable`);
    assert.equal(fs.existsSync(path.join(root, 'transcript.md')), false);
    assert.equal(fs.existsSync(path.join(archiveRoot, 'transcript.md')), false, 'nothing written into the archive root itself');
  }
});

test('archive dir name: sanitized bot sessionName, else <date in FINALIZE tz>-<sessionId>', async () => {
  const root = tmpdir();
  const upload = path.join(root, 'upload');
  fs.mkdirSync(upload);
  const common = { sessionId: String(BASE), events, uploadDir: upload, transcribeFn: fakeStt({}), cleanupUploadDir: false };
  const named = await finalizeSession({
    ...common, manifest: { ...baseManifest(upload), sessionName: '2023-11-14T22:13:20.000Z <x>' },
    archiveRoot: path.join(root, 'a1'), transcriptRoot: path.join(root, 't1'), opts: { timeZone: 'UTC' },
  });
  assert.equal(named.archiveName, '2023-11-14T221320.000Zx');
  // BASE = 2023-11-14T22:13:20Z → already Nov 15th at UTC+14.
  const dated = await finalizeSession({
    ...common, manifest: baseManifest(upload),
    archiveRoot: path.join(root, 'a2'), transcriptRoot: path.join(root, 't2'), opts: { timeZone: 'Pacific/Kiritimati' },
  });
  assert.equal(dated.archiveName, `2023-11-15-${BASE}`);
});
