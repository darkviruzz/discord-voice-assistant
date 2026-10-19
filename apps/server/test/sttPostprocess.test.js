// STT post-processing: the correction map (STT_CORRECTIONS /
// STT_CORRECTIONS_FILE) and the Whisper-filler filter (STT_HALLUCINATION_*),
// as units, on the live pipeline (JSONL + live view) and on finalize re-STT,
// plus the settings contract for the new keys.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import opus from '@discordjs/opus';

import {
  parseCorrections, compileCorrections, applyCorrections, correctWords, currentCorrections,
  matchHallucination, hallucinationPhrases, postprocessUtterance, postprocessConfig,
  DEFAULT_HALLUCINATION_PHRASES, _resetPostprocessCache,
} from '../src/sttPostprocess.js';
import { _resetVocabularyCache } from '../src/sttVocabulary.js';
import { catalogEntry } from '../src/configCatalog.js';
import { runPipeline } from '../src/pipeline.js';
import { sessions, ensureSession } from '../src/state.js';
import { subscribeEntries } from '../src/liveBus.js';
import { buildFinalizeModel } from '../src/finalize/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const repoDir = path.resolve(serverDir, '../..');

const KEYS = ['STT_CORRECTIONS', 'STT_CORRECTIONS_FILE', 'STT_HALLUCINATION_FILTER', 'STT_HALLUCINATION_PHRASES',
  'OBSIDIAN_VAULT_PATH', 'STT_VOCABULARY', 'STT_VOCABULARY_FILE', 'STT_VOCABULARY_MIN_MS',
  'STT_PROVIDER', 'WHISPER_URL', 'STT_STREAMING', 'TRANSCRIPT_DIR', 'WAKE_WORD', 'LIVE_CONTEXT_ENABLED',
  'STT_MAX_CHUNK_SECONDS'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const tmpRoots = [];
after(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  _resetPostprocessCache();
  _resetVocabularyCache();
});
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-post-'));
  tmpRoots.push(d);
  return d;
}

function captureWarn(fn) {
  const orig = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try { return { value: fn(), lines }; } finally { console.warn = orig; }
}

const fix = (text, rules) => applyCorrections(text, { matcher: compileCorrections(parseCorrections(rules).rules) });

// ── correction map: parsing ──────────────────────────────────────────────────

test('parseCorrections: rules, | alternatives, comments, list markers, frontmatter; bad entries reported', () => {
  const { rules, invalid } = parseCorrections([
    '---', 'tags: [stt]', '---',
    '# STT-Korrekturen',
    '- Rhoga | Rhogaar => Rhogar   # 12× in Runde 2',
    '* Gaaglath|GaGlath → Gaglath',
    '1. Wyern => Wyvern; Ga  Glath => Gaglath',
    'nur ein Wort',
    'leer =>',
    'rhoga => Roger',          // duplicate wrong form: the first rule wins
    'Rhogar => Rhogar',        // no-op
    'uhtred => Uhtred',        // a pure case fix is a rule
  ].join('\n'));
  assert.deepEqual(rules, [
    { from: 'Rhoga', to: 'Rhogar' }, { from: 'Rhogaar', to: 'Rhogar' },
    { from: 'Gaaglath', to: 'Gaglath' }, { from: 'GaGlath', to: 'Gaglath' },
    { from: 'Wyern', to: 'Wyvern' }, { from: 'Ga Glath', to: 'Gaglath' },
    { from: 'uhtred', to: 'Uhtred' },
  ]);
  assert.deepEqual(invalid, ['nur ein Wort', 'leer =>']);
  assert.deepEqual(parseCorrections('').rules, []);
  assert.equal(compileCorrections([]), null);
});

// ── correction map: applying ─────────────────────────────────────────────────

test('applyCorrections: whole words, any case, punctuation stays, the target is written as given', () => {
  const rules = 'Rhoga => Rhogar, Wyern => Wyvern';
  assert.equal(fix('Rhoga, du bist dran. rhoga! RHOGA?', rules), 'Rhogar, du bist dran. Rhogar! Rhogar?');
  assert.equal(fix('Rhogar und Rhogas Schild', rules), 'Rhogar und Rhogas Schild', 'never inside a word');
  assert.equal(fix('Der Wyern-Angriff', rules), 'Der Wyvern-Angriff', 'a hyphen is a word boundary');
  assert.equal(fix('Ärger mit Öko', 'Öko => Oko'), 'Ärger mit Oko', 'umlauts count as letters for the boundary');
  assert.equal(fix('Bärger', 'ärger => Ärger'), 'Bärger', 'no match after a letter');
});

test('applyCorrections: multi-word forms (any whitespace), longest first, one pass (no chains)', () => {
  assert.equal(fix('Ga  Glath und Ga\nGlath', 'Ga Glath => Gaglath'), 'Gaglath und Gaglath');
  assert.equal(fix('Ga Glath Matho', 'Ga Glath => Gaglath, Ga Glath Matho => Gaglath Matho'), 'Gaglath Matho');
  assert.equal(fix('A B', 'A => B, B => C'), 'B C', 'a replacement is not replaced again');
  assert.equal(applyCorrections('Rhoga', { matcher: null }), 'Rhoga', 'no rules → unchanged');
  assert.equal(applyCorrections('', { matcher: compileCorrections([{ from: 'x', to: 'y' }]) }), '');
});

test('correctWords: word list fixed like the text; multi-word forms merge and keep their times', () => {
  const c = { matcher: compileCorrections(parseCorrections('Rhoga => Rhogar, Ga Glath => Gaglath').rules) };
  const words = [
    { w: 'Rhoga,', t0: 0, t1: 300 }, { w: 'hilf', t0: 350, t1: 500 },
    { w: '(Ga', t0: 600, t1: 700 }, { w: 'Glath)!', t0: 720, t1: 900 }, { w: 'Ende.', t0: 950, t1: 1100 },
  ];
  assert.deepEqual(correctWords(words, c), [
    { w: 'Rhogar,', t0: 0, t1: 300 }, words[1], { w: '(Gaglath)!', t0: 600, t1: 900 }, words[4],
  ]);
  assert.equal(correctWords(words, { matcher: null }), words, 'no rules → same array');
  assert.equal(correctWords(null, c), null);
});

test('currentCorrections: inline + vault-relative file, re-read on change, bad entries warned once per list', () => {
  const vault = tmpdir();
  const file = path.join(vault, 'STT-Korrekturen.md');
  fs.writeFileSync(file, '# Korrekturen\nGaaglath | GaGlath => Gaglath\nkaputt\n');
  process.env.OBSIDIAN_VAULT_PATH = vault;
  process.env.STT_CORRECTIONS_FILE = 'STT-Korrekturen.md';
  process.env.STT_CORRECTIONS = 'Rhoga => Rhogar';

  const first = captureWarn(() => currentCorrections());
  assert.deepEqual(first.value.rules.map((r) => r.from), ['Rhoga', 'Gaaglath', 'GaGlath'], 'inline first');
  assert.equal(first.value.file, file);
  assert.equal(first.lines.length, 1);
  assert.match(first.lines[0], /1 correction entries ignored .*"kaputt"/);
  assert.equal(captureWarn(() => currentCorrections()).lines.length, 0, 'once per list');
  assert.equal(applyCorrections('Rhoga und GaGlath'), 'Rhogar und Gaglath');

  fs.writeFileSync(file, 'Wyern => Wyvern\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.equal(applyCorrections('Wyern und GaGlath'), 'Wyvern und GaGlath', 'edited file applies on the next call');

  process.env.STT_CORRECTIONS_FILE = 'fehlt.md';
  process.env.STT_CORRECTIONS = '';
  const missing = captureWarn(() => currentCorrections());
  assert.deepEqual(missing.value.rules, []);
  assert.match(missing.lines.join('\n'), /STT_CORRECTIONS_FILE .*fehlt\.md not readable/);
});

// ── hallucination filter ─────────────────────────────────────────────────────

test('matchHallucination: whole utterance only — any case, punctuation, apostrophes, repeats, * prefixes', () => {
  assert.equal(matchHallucination("Vielen Dank für's Zuschauen."), 'Vielen Dank fürs Zuschauen');
  assert.equal(matchHallucination('vielen dank fürs zuschauen!'), 'Vielen Dank fürs Zuschauen');
  assert.equal(matchHallucination('Vielen Dank für das Zuhören.'), 'Vielen Dank für das Zuhören');
  assert.equal(matchHallucination("Vielen Dank für's Zuschauen. Vielen Dank für's Zuschauen."), 'Vielen Dank fürs Zuschauen');
  assert.equal(matchHallucination('Untertitel im Auftrag des ZDF für funk, 2017'), 'Untertitel im Auftrag des ZDF*');
  assert.equal(matchHallucination('Untertitel der Amara.org-Community'), 'Untertitel der Amara.org-Community');
  assert.equal(matchHallucination('(Untertitelung aufgrund der Audioqualität nicht möglich)'),
    'Untertitelung aufgrund der Audioqualität nicht möglich');

  assert.equal(matchHallucination("Vielen Dank für's Zuschauen, und jetzt würfeln wir."), null, 'real words left over');
  assert.equal(matchHallucination("Okay. Vielen Dank für's Zuschauen."), null);
  assert.equal(matchHallucination('Vielen Dank.'), null, 'a prefix of a phrase is real speech');
  assert.equal(matchHallucination('Untertitel'), null);
  assert.equal(matchHallucination(''), null);
});

test('matchHallucination: STT_HALLUCINATION_FILTER=false turns it off; a custom list replaces the defaults', () => {
  process.env.STT_HALLUCINATION_FILTER = 'false';
  assert.equal(matchHallucination("Vielen Dank für's Zuschauen."), null);
  delete process.env.STT_HALLUCINATION_FILTER;

  process.env.STT_HALLUCINATION_PHRASES = 'Copyright WDR*; Abonniert den Kanal;*;  ';
  assert.deepEqual(hallucinationPhrases().map((p) => p.phrase), ['Abonniert den Kanal', 'Copyright WDR*'], 'a lone * is ignored');
  assert.equal(matchHallucination('Copyright WDR 2021'), 'Copyright WDR*');
  assert.equal(matchHallucination('Abonniert den Kanal!'), 'Abonniert den Kanal');
  assert.equal(matchHallucination("Vielen Dank für's Zuschauen."), null, 'defaults replaced');
  assert.equal(matchHallucination('Ein Satz.'), null);
});

test('postprocessUtterance: drops a filler, corrects segments and words; postprocessConfig for session_meta', () => {
  assert.deepEqual(postprocessUtterance({ segments: ['Vielen Dank', "für's Zuschauen."], words: [{ w: 'Vielen', t0: 0, t1: 1 }] }),
    { dropped: 'Vielen Dank fürs Zuschauen', segments: [], words: null });

  const plain = { segments: ['Rhoga greift an.'], words: null };
  assert.deepEqual(postprocessUtterance(plain), { dropped: null, ...plain }, 'no map → unchanged');

  process.env.STT_CORRECTIONS = 'Rhoga => Rhogar';
  assert.deepEqual(postprocessUtterance({ segments: ['Rhoga greift an.', 'Weiter, Rhoga!'], words: [{ w: 'Rhoga', t0: 0, t1: 300 }] }),
    { dropped: null, segments: ['Rhogar greift an.', 'Weiter, Rhogar!'], words: [{ w: 'Rhogar', t0: 0, t1: 300 }] });

  assert.deepEqual(postprocessConfig(), {
    corrections: { rules: 1, file: null },
    hallucinationFilter: { phrases: DEFAULT_HALLUCINATION_PHRASES.length, custom: false },
  });
  process.env.STT_HALLUCINATION_FILTER = 'false';
  assert.equal(postprocessConfig().hallucinationFilter, false);
});

// ── live pipeline (fake whisper.cpp) ─────────────────────────────────────────

// A string, or one string per request in order (the last one repeats).
let sttReply = 'Hallo.';
const srv = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const text = Array.isArray(sttReply) ? (sttReply.length > 1 ? sttReply.shift() : sttReply[0]) : sttReply;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
after(() => { srv.closeAllConnections?.(); srv.close(); });

const encoder = new opus.OpusEncoder(48000, 1);
const silenceFrames = (n) => Array.from({ length: n }, () => encoder.encode(Buffer.alloc(960 * 2)));

// One utterance through runPipeline → { events (JSONL), entries (live bus) }.
async function runUtterance(text, { sid = 4242n, uid = 7n } = {}) {
  const dir = tmpdir();
  Object.assign(process.env, {
    WHISPER_URL: `http://127.0.0.1:${srv.address().port}`, STT_STREAMING: 'false',
    TRANSCRIPT_DIR: dir, WAKE_WORD: 'Rabenauge', LIVE_CONTEXT_ENABLED: 'true',
  });
  sttReply = text;
  ensureSession(sid);
  sessions.get(sid).speakers.set(uid, { opusBuffer: silenceFrames(75) }); // 1.5 s
  const entries = [];
  const off = subscribeEntries((e) => { if (e.sessionId === String(sid)) entries.push(e.entry); });
  try {
    await runPipeline(sid, uid, { userDisplayName: 'Fabi', startTsMs: 1000, endTsMs: 2500, durationMs: 1500 });
  } finally {
    off();
    sessions.delete(sid);
  }
  const file = path.join(dir, `session_${sid}.jsonl`);
  const events = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];
  return { events, entries };
}

test('pipeline: the correction map fixes JSONL text, segments, rawChunks and the live entry; rawText keeps Whisper\'s', async () => {
  process.env.STT_CORRECTIONS = 'Rhoga => Rhogar';
  const { events, entries } = await runUtterance('Rhoga, du bist dran.');
  const ev = events.find((e) => e.type === 'user_transcript');
  assert.equal(ev.text, 'Rhogar, du bist dran.');
  assert.equal(ev.rawText, 'Rhoga, du bist dran.');
  assert.deepEqual(ev.segments, ['Rhogar, du bist dran.']);
  assert.deepEqual(ev.rawChunks.map((c) => c.text), ['Rhogar, du bist dran.']);
  assert.equal(ev.dropped, undefined);
  const final = entries.filter((e) => !e.partial && !e.retracted);
  assert.equal(final.length, 1);
  assert.equal(final[0].text, 'Rhogar, du bist dran.');
  assert.ok(entries.filter((e) => e.partial).every((e) => !e.text.includes('Rhoga,')), 'progress partials corrected too');

  const unchanged = await runUtterance('Alles richtig.');
  assert.equal(unchanged.events.find((e) => e.type === 'user_transcript').rawText, undefined, 'rawText only when changed');
});

test('pipeline: a pure Whisper filler is logged as dropped and never shown; partials are retracted', async () => {
  const { events, entries } = await runUtterance("Vielen Dank für's Zuschauen.");
  const ev = events.find((e) => e.type === 'user_transcript');
  assert.equal(ev.text, '');
  assert.equal(ev.dropped, 'hallucination');
  assert.equal(ev.rawText, "Vielen Dank für's Zuschauen.");
  assert.deepEqual(ev.segments, []);
  assert.equal(ev.words, null);
  assert.deepEqual(entries.filter((e) => e.text), [], 'no bubble with the filler');

  // Two chunks (forced split at 1 s): the first one's "Vielen Dank" is shown as
  // a progress partial, the whole utterance is the filler → the partial goes.
  process.env.STT_MAX_CHUNK_SECONDS = '1';
  const split = await runUtterance(['Vielen Dank', "Vielen Dank für's Zuschauen."]);
  delete process.env.STT_MAX_CHUNK_SECONDS;
  assert.equal(split.events.find((e) => e.type === 'user_transcript').dropped, 'hallucination');
  assert.deepEqual(split.entries.map((e) => [e.text, !!e.partial, !!e.retracted]),
    [['Vielen Dank', true, false], ['', false, true]]);

  process.env.STT_HALLUCINATION_FILTER = 'false';
  const off = await runUtterance("Vielen Dank für's Zuschauen.");
  assert.equal(off.events.find((e) => e.type === 'user_transcript').text, "Vielen Dank für's Zuschauen.", 'filter off → kept');
});

// ── finalize re-STT ──────────────────────────────────────────────────────────

test('finalize: re-STT spans get the same post-processing (filler dropped, text and words corrected)', async () => {
  process.env.STT_CORRECTIONS = 'Gaaglath | GaGlath => Gaglath';
  const dir = tmpdir();
  for (const f of ['a.wav', 'b.wav', 'c.wav']) fs.writeFileSync(path.join(dir, f), 'x');
  const stt = {
    'a.wav': { text: 'GaGlath greift an.', words: [{ w: 'GaGlath', t0: 0, t1: 400 }, { w: 'greift', t0: 450, t1: 700 }, { w: 'an.', t0: 720, t1: 900 }] },
    'b.wav': { text: "Vielen Dank für's Zuschauen.", words: null },
    'c.wav': { text: 'Gaaglath?', words: null },
  };
  const model = await buildFinalizeModel({
    sessionId: '1700000000000', uploadDir: dir, events: [],
    manifest: {
      sessionStartMs: 1_700_000_000_000,
      utterances: ['a.wav', 'b.wav', 'c.wav'].map((file, i) => ({ userId: String(i + 1), username: `U${i}`, file, startMs: i * 5000, durationMs: 1000 })),
    },
    transcribeFn: async (abs) => stt[path.basename(abs)],
  });
  const users = model.spans.filter((s) => s.type === 'user');
  assert.deepEqual(users.map((s) => s.text), ['Gaglath greift an.', 'Gaglath?']);
  assert.deepEqual(users[0].words.map((w) => w.w), ['Gaglath', 'greift', 'an.']);
});

// ── settings contract ────────────────────────────────────────────────────────

const NEW_KEYS = {
  STT_VOCABULARY_MIN_MS: { type: 'number', def: '1200' },
  STT_CORRECTIONS: { type: 'string', def: '' },
  STT_CORRECTIONS_FILE: { type: 'string', def: '' },
  STT_HALLUCINATION_FILTER: { type: 'boolean', def: 'true' },
  STT_HALLUCINATION_PHRASES: { type: 'string', def: '' },
};

test('new STT keys: complete live catalog entries in the STT group with the code defaults', () => {
  for (const [key, { type, def }] of Object.entries(NEW_KEYS)) {
    const e = catalogEntry('server', key);
    assert.ok(e, `${key} missing from configCatalog.js`);
    assert.equal(e.group, 'Server · STT');
    assert.equal(e.applyMode, 'live', `${key} is read per request/utterance`);
    assert.equal(e.type, type, key);
    assert.equal(e.def, def, key);
    assert.ok(e.label && e.desc.length > 80, `${key} label/desc`);
  }
  // The built-in phrase list in the panel text matches the code.
  const desc = catalogEntry('server', 'STT_HALLUCINATION_PHRASES').desc;
  for (const p of DEFAULT_HALLUCINATION_PHRASES) assert.ok(desc.includes(p), `"${p}" listed in the catalog desc`);
});

test('new STT keys: documented in apps/server/.env.example, passed through compose, in deploy/.env.example', () => {
  const example = fs.readFileSync(path.join(serverDir, '.env.example'), 'utf8');
  const compose = fs.readFileSync(path.join(repoDir, 'deploy/docker-compose.yml'), 'utf8');
  const start = compose.indexOf('\n  server:');
  const serverEnv = compose.slice(start, compose.indexOf('\n    env_file:', start));
  const deployExample = fs.readFileSync(path.join(repoDir, 'deploy/.env.example'), 'utf8');
  for (const [key, { def }] of Object.entries(NEW_KEYS)) {
    assert.match(example, new RegExp(`^#?\\s*${key}=`, 'm'), `${key} in apps/server/.env.example`);
    assert.match(serverEnv, new RegExp(`^\\s+${key}: \\$\\{${key}:-${def}\\}\\r?$`, 'm'), `${key} in compose server env`);
    assert.match(deployExample, new RegExp(`^${key}=${def}\\r?$`, 'm'), `${key} in deploy/.env.example`);
  }
});
