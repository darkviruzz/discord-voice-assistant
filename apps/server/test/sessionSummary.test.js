import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptBody, chunkLines, capText, summarizeSession, writeSummaryToVault, latestSessionSummary } from '../src/finalize/summary.js';

const KEYS = ['SESSION_SUMMARY_ENABLED', 'SESSION_SUMMARY_CHUNK_CHARS', 'SESSION_SUMMARY_MAX_CHARS', 'SESSION_SUMMARY_VAULT_DIR', 'OBSIDIAN_VAULT_PATH', 'SUMMARY_MODEL'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
beforeEach(() => { for (const k of KEYS) delete process.env[k]; });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sess-sum-'));
const line = (i) => `\`20:${String(i % 60).padStart(2, '0')}\` **Anna (Mira):** Wir gehen nach Graufurt und reden mit Baron Kelthur über den Vertrag Nummer ${i}.`;
const md = (n) => ['# Session', '', '- **Beginn:** 20:00 · **Dauer:** 3h', '- **Teilnehmer:** Anna', '', '---', '', ...Array.from({ length: n }, (_, i) => line(i))].join('\n');

test('transcriptBody keeps spoken lines, drops header facts', () => {
  const b = transcriptBody(md(3));
  assert.equal(b.split('\n').length, 3);
  assert.ok(!b.includes('Beginn'));
});

test('chunkLines respects the budget at line boundaries; capText cuts at a sentence', () => {
  const chunks = chunkLines('aaaa\nbbbb\ncccc', 9);
  assert.deepEqual(chunks, ['aaaa\nbbbb', 'cccc']);
  assert.deepEqual(chunkLines('x'.repeat(25), 10), ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  assert.equal(capText('Eins zwei drei. Vier fünf sechs sieben acht.', 30), 'Eins zwei drei.');
});

test('short transcript → single final call; long → map-reduce with progress', async () => {
  const calls = [];
  const fake = async ({ messages }) => { calls.push(messages[1].content); return { content: `Zusammenfassung ${calls.length}` }; };
  assert.equal(await summarizeSession(md(5), { completeFn: fake }), 'Zusammenfassung 1');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^Transkript:/);

  calls.length = 0;
  process.env.SESSION_SUMMARY_CHUNK_CHARS = '2000';
  const progress = [];
  const out = await summarizeSession(md(80), { completeFn: fake, onProgress: (p) => progress.push(p.done) });
  const parts = calls.length - 1;
  assert.ok(parts >= 3, `expected several partial calls, got ${parts}`);
  assert.equal(out, `Zusammenfassung ${calls.length}`);
  assert.match(calls.at(-1), /^Notizen:\nTeil 1: Zusammenfassung 1/);
  assert.deepEqual(progress, Array.from({ length: parts }, (_, i) => i));
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
