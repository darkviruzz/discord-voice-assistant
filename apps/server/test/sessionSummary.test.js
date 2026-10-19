import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  transcriptBody, compactTranscript, chunkRecords, chunkLines, capText, partialNote,
  summarizeSession, writeSummaryToVault, latestSessionSummary,
} from '../src/finalize/summary.js';
import { _resetVocabularyCache } from '../src/sttVocabulary.js';

const KEYS = ['SESSION_SUMMARY_ENABLED', 'SESSION_SUMMARY_CHUNK_CHARS', 'SESSION_SUMMARY_MAX_CHARS', 'SESSION_SUMMARY_TIMEOUT_MS',
  'SESSION_SUMMARY_VAULT_DIR', 'OBSIDIAN_VAULT_PATH', 'SUMMARY_MODEL', 'STT_VOCABULARY', 'STT_VOCABULARY_FILE'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } _resetVocabularyCache(); });
beforeEach(() => { for (const k of KEYS) delete process.env[k]; _resetVocabularyCache(); });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sess-sum-'));
const line = (i) => `\`20:${String(i % 60).padStart(2, '0')}\` **Anna (Mira):** Wir gehen nach Graufurt und reden mit Baron Kelthur über den Vertrag Nummer ${i}.`;
const md = (n) => ['# Session', '', '- **Beginn:** 20:00 · **Dauer:** 3h', '- **Teilnehmer:** Anna', '', '---', '', ...Array.from({ length: n }, (_, i) => line(i))].join('\n');

test('transcriptBody keeps spoken lines, drops header facts', () => {
  const b = transcriptBody(md(3));
  assert.equal(b.split('\n').length, 3);
  assert.ok(!b.includes('Beginn'));
});

// 2026-10-18: a Rabenauge reply built from an outdated CAMPAIGN.md ended up in
// summary.md as if it had happened in the game.
const MIXED = ['# Session', '', '- **Teilnehmer:** Anna, Ben', '', '---', '',
  '[20:00:01] **Anna (Mira):** **Rabenauge**, wer ist Baron Kelthur?',
  '[20:00:09] **Rabenauge:** Baron Kelthur herrscht noch immer über Graufurt.',
  '[20:00:15] **Rabenauge:** _[weiter]_ Er ist ein Tyrann.',
  '[20:00:20] **Ben:** _(getippt)_ Wir gehen zur Burg.',
].join('\n');

test('transcriptBody drops the assistant\'s own replies, keeps every player line', () => {
  assert.deepEqual(transcriptBody(MIXED).split('\n'), [
    '[20:00:01] **Anna (Mira):** **Rabenauge**, wer ist Baron Kelthur?',
    '[20:00:20] **Ben:** _(getippt)_ Wir gehen zur Burg.',
  ]);
  // The label is the session's wake word (manifest.wakeWord), any case.
  const orakel = MIXED.replaceAll('**Rabenauge:**', '**Orakel:**');
  assert.equal(transcriptBody(orakel, { assistantName: 'orakel' }).split('\n').length, 2);
  assert.equal(transcriptBody(orakel).split('\n').length, 4, 'another label is a player');
});

test('only assistant lines → no summary (no fallback to the raw text)', async () => {
  const only = Array.from({ length: 8 }, (_, i) => `[20:0${i}:00] **Rabenauge:** Baron Kelthur herrscht seit vielen Jahren über Graufurt, Absatz ${i}.`).join('\n');
  assert.equal(transcriptBody(only), '');
  let called = false;
  assert.equal(await summarizeSession(only, { completeFn: async () => { called = true; return { content: 'x' }; } }), null);
  assert.equal(called, false);
});

test('chunkLines respects the budget at line boundaries; capText cuts at a sentence', () => {
  const chunks = chunkLines('aaaa\nbbbb\ncccc', 9);
  assert.deepEqual(chunks, ['aaaa\nbbbb', 'cccc']);
  assert.deepEqual(chunkLines('x'.repeat(25), 10), ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  assert.equal(capText('Eins zwei drei. Vier fünf sechs sieben acht.', 30), 'Eins zwei drei.');
});

test('compactTranscript drops timestamps and markup, joins a speaker\'s consecutive lines', () => {
  const body = [
    '[19:44:16] **Benny (Gaglath):** _[unterbricht]_ Ein Mini-Drache,',
    '[19:44:17] **Benny (Gaglath):** _[weiter]_ ein **Wyvern** ist gekommen.',
    '[19:44:21] **Fabi (Rhogar):** _(getippt)_ Dann...',
    '`20:05` **Anna (Mira):** Alte Zeitangabe.',
    'freie Zeile ohne Sprecher',
    '[19:45:00] **Fabi (Rhogar):** _[weiter]_',
  ].join('\n');
  assert.deepEqual(compactTranscript(body), [
    { ts: '19:44', line: 'Benny (Gaglath): Ein Mini-Drache, ein Wyvern ist gekommen.' },
    { ts: '19:44', line: 'Fabi (Rhogar): Dann...' },
    { ts: '20:05', line: 'Anna (Mira): Alte Zeitangabe.' },
    { ts: null, line: 'freie Zeile ohne Sprecher' },
  ]);
  // A monologue still breaks into lines (chunks are cut between lines).
  const mono = Array.from({ length: 40 }, (_, i) => `[20:00:${String(i).padStart(2, '0')}] **SL:** Ein langer Satz der Spielleitung, Nummer ${i}.`).join('\n');
  const lines = compactTranscript(mono);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => l.line.length <= 800 && l.line.startsWith('SL: ')));
});

test('chunkRecords cuts between lines and labels each chunk with its clock range', () => {
  const rec = [{ ts: '20:00', line: 'a'.repeat(6) }, { ts: null, line: 'b'.repeat(6) }, { ts: '20:30', line: 'c'.repeat(6) }];
  assert.deepEqual(chunkRecords(rec, 13), [
    { text: 'aaaaaa\nbbbbbb', from: '20:00', to: '20:00' },
    { text: 'cccccc', from: '20:30', to: '20:30' },
  ]);
  assert.deepEqual(chunkRecords([{ ts: '21:00', line: 'x'.repeat(25) }], 10).map((c) => c.text.length), [10, 10, 5]);
});

test('short transcript → single final call; long → map-reduce, one progress tick per call', async () => {
  const calls = [];
  const fake = async ({ messages }) => { calls.push(messages[1].content); return { content: `Zusammenfassung ${calls.length}` }; };
  assert.equal(await summarizeSession(md(5), { completeFn: fake }), 'Zusammenfassung 1');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^Transkript:\nAnna \(Mira\): Wir gehen/);

  calls.length = 0;
  process.env.SESSION_SUMMARY_CHUNK_CHARS = '2000';
  const progress = [];
  const out = await summarizeSession(md(80), { completeFn: fake, onProgress: (p) => progress.push(p) });
  const parts = calls.length - 1;
  assert.ok(parts >= 3, `expected several partial calls, got ${parts}`);
  assert.equal(out, `Zusammenfassung ${calls.length}`);
  assert.match(calls[0], /^Ausschnitt 1 von \d+ \(20:00–20:\d\d Uhr\):\nAnna \(Mira\): /);
  assert.ok(calls.slice(0, -1).every((c) => !c.includes('**') && !c.includes('`20:')), 'the LLM gets compacted lines');
  assert.match(calls.at(-1), /^Notizen:\nTeil 1 \(20:00–20:\d\d Uhr\): Zusammenfassung 1/);
  assert.deepEqual(progress.map((p) => [p.phase, p.done, p.total]),
    calls.map((_, i) => ['summary', i, calls.length]), 'a tick before every call, the merge included');
});

test('the STT vocabulary is the spelling reference in every prompt', async () => {
  const systems = [];
  const fake = async ({ messages }) => { systems.push(messages[0].content); return { content: 'Notiz.' }; };
  process.env.SESSION_SUMMARY_CHUNK_CHARS = '2000';
  await summarizeSession(md(40), { completeFn: fake });
  assert.ok(systems.length >= 3);
  assert.ok(systems.every((s) => !s.includes('Korrekte Schreibweisen')), 'no vocabulary → no hint');

  systems.length = 0;
  // Longer than the 250 chars Whisper gets: the LLM gets the whole list.
  const filler = Array.from({ length: 30 }, (_, i) => `Ortsname${i}`).join(', ');
  process.env.STT_VOCABULARY = `Gaglath, Spugnoir, Ylva Binsenhalm, ${filler}, Wyvern`;
  _resetVocabularyCache();
  await summarizeSession(md(40), { completeFn: fake });
  assert.ok(systems.length >= 3);
  for (const s of systems) {
    assert.match(s, /Korrekte Schreibweisen von Namen und Begriffen der Kampagne: Gaglath, Spugnoir, Ylva Binsenhalm, Ortsname0, .*, Wyvern\./);
    assert.match(s, /falsch erkannte Varianten stillschweigend korrigieren/);
  }
  assert.ok(systems.some((s) => s.startsWith('Du protokollierst')), 'part prompt');
  assert.ok(systems.at(-1).startsWith('Du schreibst die Zusammenfassung'), 'final prompt');
});

test('notes that do not fit one merge call are merged in batches first', async () => {
  process.env.SESSION_SUMMARY_CHUNK_CHARS = '2000';
  const calls = [];
  const fake = async ({ messages }) => {
    calls.push({ system: messages[0].content, user: messages[1].content });
    // Every note far longer than asked → the notes overflow one merge call.
    return { content: `${'Die Gruppe verhandelt mit Baron Kelthur. '.repeat(30)}Ende.` };
  };
  const out = await summarizeSession(md(80), { completeFn: fake });
  const batch = calls.filter((c) => c.system.includes('zu einem Teil der Sitzung'));
  assert.ok(batch.length >= 1, 'batch merges ran');
  assert.match(batch[0].user, /^Notizen:\nTeil 1 \(/);
  const final = calls.at(-1);
  assert.match(final.system, /^Du schreibst die Zusammenfassung/);
  assert.match(final.user, /^Notizen:\nTeile 1–\d+ \(20:00–/);
  assert.ok(final.user.length <= 2500 + 40, `final input within 1.25 × chunk (${final.user.length})`);
  assert.ok(out && !out.includes('Unvollständig'));
});

test('disabled, too short, or LLM failure → null (finalize unaffected)', async () => {
  const boom = async () => { throw new Error('llm down'); };
  assert.equal(await summarizeSession(md(10), { completeFn: boom }), null);
  assert.equal(await summarizeSession('# leer', { completeFn: async () => ({ content: 'x' }) }), null);
  process.env.SESSION_SUMMARY_ENABLED = 'false';
  assert.equal(await summarizeSession(md(10), { completeFn: async () => ({ content: 'x' }) }), null);
});

test('summary is capped at SESSION_SUMMARY_MAX_CHARS', async () => {
  process.env.SESSION_SUMMARY_MAX_CHARS = '300';
  const long = 'Ein Satz über Kelthur. '.repeat(100);
  const out = await summarizeSession(md(5), { completeFn: async () => ({ content: long }) });
  assert.ok(out.length <= 300);
  assert.ok(out.endsWith('.'));
});

test('vault copy: off by default, written inside the vault, refuses to escape it', () => {
  const vault = tmp();
  try {
    process.env.OBSIDIAN_VAULT_PATH = vault;
    assert.equal(writeSummaryToVault('text', { title: 't', dateLabel: '2026-10-11' }), null);
    process.env.SESSION_SUMMARY_VAULT_DIR = 'Rabenauge/Sessions';
    const f = writeSummaryToVault('Die Gruppe erreichte Graufurt.', { title: '2026-10-11 Session/1', dateLabel: '2026-10-11' });
    assert.ok(f.startsWith(path.join(vault, 'Rabenauge', 'Sessions')));
    const content = fs.readFileSync(f, 'utf8');
    assert.match(content, /^---\ntype: session-summary\ndate: 2026-10-11/);
    assert.match(content, /Graufurt/);
    process.env.SESSION_SUMMARY_VAULT_DIR = '../outside';
    assert.equal(writeSummaryToVault('x', { title: 'y', dateLabel: 'z' }), null);
    assert.ok(!fs.existsSync(path.join(vault, '..', 'outside', 'y.md')));
  } finally { fs.rmSync(vault, { recursive: true, force: true }); }
});

test('latestSessionSummary orders by session start, not by file time', () => {
  const root = tmp();
  try {
    const mk = (name, start, text) => {
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'manifest.json'), JSON.stringify({ sessionStartMs: start }));
      fs.writeFileSync(path.join(root, name, 'summary.md'), text);
    };
    mk('new', 2000, 'neueste Sitzung');
    mk('old', 1000, 'alte Sitzung'); // written last (newer mtime, e.g. a re-finalize)
    fs.mkdirSync(path.join(root, 'nosummary'));
    assert.deepEqual(latestSessionSummary(root), { text: 'neueste Sitzung', archiveName: 'new', sessionStartMs: 2000 });
    assert.equal(latestSessionSummary(root, { excludeArchiveName: 'new' }).archiveName, 'old');
    assert.equal(latestSessionSummary(path.join(root, 'missing')), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('budget running out keeps the notes: merged into a summary marked incomplete', async () => {
  process.env.SESSION_SUMMARY_CHUNK_CHARS = '2000';
  process.env.SESSION_SUMMARY_TIMEOUT_MS = '40000';
  let t = 0;
  const calls = [];
  const slow = async ({ timeoutMs, messages }) => {
    calls.push({ timeoutMs, system: messages[0].content });
    t += 8000;
    return { content: messages[0].content.startsWith('Du schreibst') ? 'Die Gruppe erreichte Graufurt.' : 'Notiz zu Graufurt.' };
  };
  const out = await summarizeSession(md(80), { completeFn: slow, now: () => t });
  // 10 s (a quarter of the budget, ≥ 2 calls) are held back for the merge.
  assert.deepEqual(calls.map((c) => c.timeoutMs), [30000, 22000, 14000, 16000]);
  assert.match(calls.at(-1).system, /^Du schreibst die Zusammenfassung/, 'the merge still ran');
  assert.match(out, /^Die Gruppe erreichte Graufurt\.\n\n\(Unvollständig — Zeitbudget aufgebraucht: 3 von \d+ Abschnitten berücksichtigt, reicht bis etwa 20:\d\d Uhr\.\)$/);
});

test('no time left for the merge: the notes themselves, condensed and marked', async () => {
  process.env.SESSION_SUMMARY_CHUNK_CHARS = '2000';
  process.env.SESSION_SUMMARY_TIMEOUT_MS = '40000';
  process.env.SESSION_SUMMARY_MAX_CHARS = '600';
  let t = 0;
  let n = 0;
  const slow = async ({ messages }) => {
    if (messages[0].content.startsWith('Du schreibst')) { t += 60_000; throw new Error('llm: timeout after 16000 ms'); }
    t += 8000;
    n += 1;
    // gemma4 answered one part with Markdown bullets despite "Prosa".
    if (n === 2) return { content: '**Ereignisse**\n*   **Kampf:** Rhogar trifft die Wyvern.\n*   Gaglath flieht.' };
    return { content: `Notiz ${n}: Die Gruppe verhandelt in Graufurt. ${'Weitere Einzelheiten folgen hier. '.repeat(10)}` };
  };
  const out = await summarizeSession(md(80), { completeFn: slow, now: () => t });
  assert.ok(out.length <= 600, `capped (${out.length})`);
  assert.match(out, /^20:00–20:\d\d Uhr: Notiz 1: Die Gruppe verhandelt in Graufurt\./);
  assert.match(out, /\n\n20:\d\d–20:\d\d Uhr: Ereignisse Kampf: Rhogar trifft die Wyvern\. Gaglath flieht\.\n\n/, 'every note keeps its share, Markdown flattened');
  assert.match(out, /\n\n20:\d\d–20:\d\d Uhr: Notiz 3: /);
  assert.match(out, /\(Unvollständig — Zeitbudget aufgebraucht: 3 von \d+ Abschnitten berücksichtigt, reicht bis etwa 20:\d\d Uhr; die Notizen wurden nicht mehr zusammengeführt\.\)$/);
});

test('a failing part is skipped (marked), two in a row end the map, none at all → null', async () => {
  process.env.SESSION_SUMMARY_CHUNK_CHARS = '2000';
  let i = 0;
  const flaky = async ({ messages }) => {
    i += 1;
    if (i === 2) throw new Error('HTTP 500');
    return { content: messages[0].content.startsWith('Du schreibst') ? 'Zusammenfassung.' : `Notiz ${i}.` };
  };
  const out = await summarizeSession(md(80), { completeFn: flaky });
  assert.match(out, /^Zusammenfassung\.\n\n\(Unvollständig — LLM-Fehler: (\d+) von \d+ Abschnitten berücksichtigt\.\)$/);

  i = 0;
  const calls = [];
  const dies = async ({ messages }) => {
    calls.push(messages[0].content);
    i += 1;
    if (i >= 2) throw new Error('connect ECONNREFUSED');
    return { content: 'Notiz zu Graufurt.' };
  };
  const out2 = await summarizeSession(md(80), { completeFn: dies });
  assert.equal(calls.length, 4, 'part 1 ok, parts 2+3 fail → stop, the merge is still tried');
  assert.match(out2, /^20:00–20:\d\d Uhr: Notiz zu Graufurt\.\n\n\(Unvollständig — LLM-Fehler: 1 von \d+ Abschnitten berücksichtigt, reicht bis etwa 20:\d\d Uhr; die Notizen wurden nicht mehr zusammengeführt\.\)$/);

  assert.equal(await summarizeSession(md(80), { completeFn: async () => { throw new Error('down'); } }), null);
});

test('partialNote wording', () => {
  assert.equal(partialNote({ covered: 7, total: 10, until: '21:47', timeUp: true }),
    '(Unvollständig — Zeitbudget aufgebraucht: 7 von 10 Abschnitten berücksichtigt, reicht bis etwa 21:47 Uhr.)');
  assert.equal(partialNote({ covered: 10, total: 10, timeUp: true, unmerged: true }),
    '(Unvollständig — Zeitbudget aufgebraucht: alle 10 Abschnitte verdichtet; die Notizen wurden nicht mehr zusammengeführt.)');
});
