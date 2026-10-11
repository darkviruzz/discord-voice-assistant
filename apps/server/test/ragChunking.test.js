// Vault RAG building blocks: frontmatter, chunking, vault scanning and the
// vector store (search + persistence format). Ported from the former Python
// service's pytest suite (apps/rag/tests/test_frontmatter.py,
// test_chunking.py), which was the behavioural spec for this module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseFrontmatter, flattenMeta } from '../src/rag/frontmatter.js';
import { chunkMarkdown, splitLong, DEFAULT_MAX_CHUNK_CHARS } from '../src/rag/chunker.js';
import { listNotes, isHidden, readNote, noteState } from '../src/rag/scanner.js';
import { VectorStore, IndexFormatError, writeFileAtomic, cleanupTempFiles } from '../src/rag/store.js';
import { makeTmpDir, writeNote, fakeVector } from '../test-support/rag.js';

// ── frontmatter ─────────────────────────────────────────────────────────────

test('frontmatter: parses a mapping and strips the block', () => {
  const { meta, body } = parseFrontmatter('---\ntitle: Graf Zahl\ntags: [npc, adel]\n---\n# Graf\n\nText');
  assert.deepEqual(meta, { title: 'Graf Zahl', tags: ['npc', 'adel'] });
  assert.equal(body, '# Graf\n\nText');
});

test('frontmatter: none → text unchanged', () => {
  const text = '# Title\n\nbody';
  assert.deepEqual(parseFrontmatter(text), { meta: {}, body: text });
});

test('frontmatter: empty block, `...` close, CRLF, BOM', () => {
  assert.deepEqual(parseFrontmatter('---\n---\nbody'), { meta: {}, body: 'body' });
  assert.deepEqual(parseFrontmatter('---\na: 1\n...\nbody'), { meta: { a: 1 }, body: 'body' });
  const crlf = parseFrontmatter('---\r\na: 1\r\n---\r\nbody\r\n');
  assert.deepEqual(crlf.meta, { a: 1 });
  assert.equal(crlf.body.trim(), 'body');
  assert.deepEqual(parseFrontmatter('﻿---\na: 1\n---\nbody'), { meta: { a: 1 }, body: 'body' });
});

test('frontmatter: a horizontal rule at the top is not frontmatter and loses nothing', () => {
  // The "YAML" between the two rules is prose; it must stay in the body.
  const text = '---\nDer Drache schläft.\n---\nMehr Text';
  assert.deepEqual(parseFrontmatter(text), { meta: {}, body: text });
});

test('frontmatter: invalid YAML, a YAML list, `----`, unclosed → full text kept', () => {
  for (const text of [
    '---\na: [unclosed\n---\nbody',
    '---\n- a\n- b\n---\nbody',
    '----\na: 1\n----\nbody',
    '---\na: 1\nbody without close',
  ]) {
    assert.deepEqual(parseFrontmatter(text), { meta: {}, body: text }, JSON.stringify(text));
  }
});

test('frontmatter: the closing delimiter must be a line of its own', () => {
  // "--- not a close" belongs to the YAML block → a second YAML document →
  // error → not frontmatter.
  const { meta, body } = parseFrontmatter('---\na: 1\n--- not a close\nb: 2\n---\nbody');
  assert.deepEqual(meta, {});
  assert.ok(body.startsWith('---\na: 1'));
});

test('frontmatter: an opening delimiter later in the note is not frontmatter', () => {
  const text = 'Intro\n---\na: 1\n---\nbody';
  assert.deepEqual(parseFrontmatter(text), { meta: {}, body: text });
});

test('frontmatter: block scalars, quoted colons, duplicate keys (last wins)', () => {
  const { meta } = parseFrontmatter('---\ndesc: |\n  Zeile 1\n  Zeile 2\nk: "x: y"\nk2: 1\nk2: 2\n---\nbody');
  assert.equal(meta.desc, 'Zeile 1\nZeile 2\n');
  assert.equal(meta.k, 'x: y');
  assert.equal(meta.k2, 2);
});

test('flattenMeta: scalars, lists, dates, nested, null, numeric keys', () => {
  const out = flattenMeta({
    title: 'X', level: 3, cr: 0.5, alive: false, tags: ['npc', 'adel'],
    date: '2026-06-14', when: new Date(Date.UTC(2026, 5, 14)), stats: { ac: 15 },
    empty: null, 42: 'int key', big: 2n ** 70n, nan: NaN, inf: Infinity, '': 1,
  }, 'npc/x.md');
  assert.equal(out.title, 'X');
  assert.equal(out.level, 3);
  assert.equal(out.cr, 0.5);
  assert.equal(out.alive, false);
  assert.equal(out.tags, 'npc, adel');
  assert.equal(out.date, '2026-06-14');
  assert.equal(out.when, '2026-06-14');
  assert.equal(out.stats, '{"ac":15}');
  assert.ok(!('empty' in out));
  assert.equal(out['42'], 'int key');
  assert.equal(out.big, String(2n ** 70n));
  assert.equal(out.nan, 'nan');
  assert.equal(out.inf, 'inf');
  assert.ok(!('' in out));
  assert.equal(out.source, 'npc/x.md');
  assert.doesNotThrow(() => JSON.stringify(out));
});

test('flattenMeta: a frontmatter `source:` field cannot shadow the note path', () => {
  assert.equal(flattenMeta({ source: 'https://example.org/clip' }, 'clips/a.md').source, 'clips/a.md');
});

// ── chunking ───────────────────────────────────────────────────────────────

const NOTE = `---
type: npc
tags: [adel]
---
# Graf Zahl

Intro über den Grafen.

## Aussehen
Groß, blass.

### Kleidung
Schwarzer Umhang.

## Motive
Will die Krone.
`;

test('chunker: splits at ## and keeps the intro; ### stays inside its section', () => {
  const { chunks } = chunkMarkdown(NOTE, 'npc/graf.md');
  assert.deepEqual(chunks.map((c) => c.text.split('\n')[0]), ['# Graf Zahl', '## Aussehen', '## Motive']);
  assert.ok(chunks[1].text.includes('### Kleidung'));
  assert.equal(chunks[0].heading, '');
  assert.equal(chunks[1].heading, 'Aussehen');
});

test('chunker: ids are sequential, unique and stable', () => {
  const a = chunkMarkdown(NOTE, 'npc/graf.md').chunks.map((c) => c.id);
  const b = chunkMarkdown(NOTE, 'npc/graf.md').chunks.map((c) => c.id);
  assert.deepEqual(a, ['npc/graf.md::0', 'npc/graf.md::1', 'npc/graf.md::2']);
  assert.deepEqual(a, b);
});

test('chunker: frontmatter becomes note metadata, not chunk text', () => {
  const { meta, chunks } = chunkMarkdown(NOTE, 'npc/graf.md');
  assert.equal(meta.source, 'npc/graf.md');
  assert.equal(meta.type, 'npc');
  assert.equal(meta.tags, 'adel');
  for (const c of chunks) assert.ok(!c.text.includes('type: npc'));
});

test('chunker: empty and frontmatter-only notes yield no chunks', () => {
  assert.deepEqual(chunkMarkdown('', 'a.md').chunks, []);
  assert.deepEqual(chunkMarkdown('   \n\n', 'a.md').chunks, []);
  assert.deepEqual(chunkMarkdown('---\na: 1\n---\n', 'a.md').chunks, []);
});

test('chunker: ## inside a code fence does not split', () => {
  const text = '## Befehle\n```bash\n## kein Heading\necho hi\n```\nnach dem Block\n## Zweite\nx';
  const { chunks } = chunkMarkdown(text, 'a.md');
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].text.includes('## kein Heading'));
  assert.ok(chunks[0].text.includes('nach dem Block'));
  assert.equal(chunks[1].heading, 'Zweite');
});

test('chunker: ~~~ fence with an unrelated ``` marker inside', () => {
  const { chunks } = chunkMarkdown('~~~\n```\n## drin\n~~~\n## Draußen\ny', 'a.md');
  assert.deepEqual(chunks.map((c) => c.heading), ['', 'Draußen']);
});

test('chunker: a long section is split with its heading repeated, nothing lost', () => {
  const paras = Array.from({ length: 20 }, (_, i) => `Absatz ${i} ` + 'wort '.repeat(40));
  const text = '## Chronik\n' + paras.join('\n\n');
  const { chunks } = chunkMarkdown(text, 'log.md', { maxChars: 500 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.text.length <= 500, `chunk of ${c.text.length} chars`);
    assert.ok(c.text.startsWith('## Chronik'));
    assert.equal(c.heading, 'Chronik');
  }
  const joined = chunks.map((c) => c.text).join('\n');
  for (let i = 0; i < 20; i++) assert.ok(joined.includes(`Absatz ${i} `), `Absatz ${i}`);
  assert.deepEqual(chunks.map((c) => c.id), chunks.map((_, i) => `log.md::${i}`));
});

test('chunker: a single unbroken line is hard-cut', () => {
  const { chunks } = chunkMarkdown('x'.repeat(2500), 'blob.md', { maxChars: 1000 });
  assert.deepEqual(chunks.map((c) => c.text.length), [1000, 1000, 500]);
});

test('chunker: a hard cut never splits a surrogate pair', () => {
  const pieces = splitLong('a'.repeat(9) + '🐉' + 'b'.repeat(5), 10);
  assert.equal(pieces[0], 'a'.repeat(9));
  assert.ok(pieces[1].startsWith('🐉'));
});

test('chunker: the default limit bounds a huge note', () => {
  const text = '# Riesig\n\n' + ('Lorem ipsum dolor sit amet. '.repeat(20) + '\n\n').repeat(500);
  const { chunks } = chunkMarkdown(text, 'big.md');
  assert.ok(chunks.length > 1);
  assert.ok(Math.max(...chunks.map((c) => c.text.length)) <= DEFAULT_MAX_CHUNK_CHARS);
});

// ── vault scanning ──────────────────────────────────────────────────────────

test('scanner: skips dot-directories, dot-files and non-.md; forward-slash sources', async () => {
  const root = makeTmpDir('rag-scan-');
  try {
    writeNote(root, 'npc/a.md', 'a');
    writeNote(root, 'B.MD', 'b');
    writeNote(root, 'bild.png', 'x');
    writeNote(root, '.obsidian/tpl.md', 'x');
    writeNote(root, '.trash/old.md', 'x');
    writeNote(root, '.hidden.md', 'x');
    writeNote(root, 'tief/er/c.md', 'c');
    const found = (await listNotes(root)).map((n) => n.source);
    assert.deepEqual(found, ['B.MD', 'npc/a.md', 'tief/er/c.md']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scanner: a missing vault root throws (unavailable, not empty)', async () => {
  await assert.rejects(() => listNotes(path.join(makeTmpDir(), 'missing')));
});

test('scanner: isHidden', () => {
  assert.ok(isHidden('.trash/a.md'));
  assert.ok(isHidden('x/.obsidian/a.md'));
  assert.ok(isHidden('../outside.md'));
  assert.ok(!isHidden('npc/a.md'));
});

test('scanner: readNote strips the BOM, replaces bad bytes, skips oversized notes', async () => {
  const root = makeTmpDir('rag-read-');
  try {
    const bom = writeNote(root, 'bom.md', '﻿---\ntype: ort\n---\n## Wald\nBäume\n');
    assert.ok((await readNote(bom)).startsWith('---\ntype: ort'));
    const cp = writeNote(root, 'cp1252.md', '## Größe\nÄrger\n', 'latin1');
    assert.match(await readNote(cp), /^## Gr��e/);
    const big = writeNote(root, 'big.md', 'x '.repeat(200));
    const warnings = [];
    assert.equal(await readNote(big, { maxBytes: 100, onWarn: (m) => warnings.push(m) }), '');
    assert.equal(warnings.length, 1);
    assert.equal(await readNote(path.join(root, 'nope.md'), { onWarn: () => {} }), null);
    assert.equal(await noteState(bom), 'file');
    assert.equal(await noteState(path.join(root, 'nope.md')), 'missing');
    fs.mkdirSync(path.join(root, 'ordner.md'));
    assert.equal(await noteState(path.join(root, 'ordner.md')), 'missing', 'a directory is not a note');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── vector store ────────────────────────────────────────────────────────────

function storeWith(notes) {
  const s = new VectorStore('sig');
  for (const [source, texts] of Object.entries(notes)) {
    s.setNote(source, {
      hash: `h-${source}`,
      meta: { source },
      chunks: texts.map((text) => ({ text, heading: '' })),
      vectors: texts.map((t) => fakeVector(t)),
    });
  }
  return s;
}

test('store: closest first, cosine distance 0..2 with 4 decimals, top-k bound', () => {
  const s = storeWith({ 'drache.md': ['roter drache hort feuerberg'], 'wirt.md': ['bruno braut bier taverne'] });
  const hits = s.search(fakeVector('roter drache hort feuerberg'), { topK: 5 });
  assert.deepEqual(hits.map((h) => h.source), ['drache.md', 'wirt.md']);
  assert.equal(hits[0].distance, 0);
  assert.ok(hits[1].distance > 0.5 && hits[1].distance <= 2);
  assert.deepEqual(Object.keys(hits[0]).sort(), ['distance', 'source', 'text']);
  assert.equal(s.search(fakeVector('bier'), { topK: 1 }).length, 1);
});

test('store: threshold drops hits above it and keeps equal ones (inclusive)', () => {
  const s = storeWith({ 'a.md': ['alpha beta'], 'b.md': ['gamma delta'] });
  const all = s.search(fakeVector('alpha beta'), { topK: 5 });
  const far = all[1].distance;
  assert.equal(s.search(fakeVector('alpha beta'), { topK: 5, threshold: far }).length, 2);
  assert.equal(s.search(fakeVector('alpha beta'), { topK: 5, threshold: far - 0.001 }).length, 1);
  assert.equal(s.search(fakeVector('alpha beta'), { topK: 5, threshold: 0 }).length, 1, 'exact match only');
  assert.equal(s.search(fakeVector('alpha beta'), { topK: 5, threshold: null }).length, 2);
});

test('store: replacing a note swaps its chunks atomically; delete; dimension guard', () => {
  const s = storeWith({ 'a.md': ['eins', 'zwei'], 'b.md': ['drei'] });
  assert.equal(s.chunkCount, 3);
  s.setNote('a.md', { hash: 'x', chunks: [{ text: 'neu' }], vectors: [fakeVector('neu')] });
  assert.equal(s.chunkCount, 2);
  assert.ok(s.deleteNote('b.md'));
  assert.ok(!s.deleteNote('b.md'));
  assert.equal(s.chunkCount, 1);
  assert.throws(() => s.setNote('c.md', { hash: 'y', chunks: [{ text: 'z' }], vectors: [[1, 2, 3]] }), /dimension/);
  // The only note may change dimension (whole space replaced by one note).
  s.setNote('a.md', { hash: 'z', chunks: [{ text: 'z' }], vectors: [[1, 2, 3]] });
  assert.equal(s.dim, 3);
});

test('store: serialize → deserialize round-trips notes, meta and vectors', () => {
  const s = storeWith({ 'npc/graf.md': ['## A\nGraf Zahl', '## B\nKrone'], 'leer.md': [] });
  const back = VectorStore.deserialize(s.serialize(), { signature: 'sig' });
  assert.equal(back.chunkCount, 2);
  assert.equal(back.noteCount, 2);
  assert.equal(back.dim, s.dim);
  assert.deepEqual(back.getNote('npc/graf.md').meta, { source: 'npc/graf.md' });
  assert.equal(back.getNote('leer.md').chunks.length, 0);
  assert.deepEqual(
    back.search(fakeVector('Krone'), { topK: 2 }),
    s.search(fakeVector('Krone'), { topK: 2 }),
  );
});

test('store: a foreign signature, bad magic, truncation or size mismatch is rejected', () => {
  const buf = storeWith({ 'a.md': ['alpha'] }).serialize();
  assert.throws(() => VectorStore.deserialize(buf, { signature: 'other' }), (e) => e instanceof IndexFormatError && e.stale);
  assert.throws(() => VectorStore.deserialize(Buffer.from('nonsense'), { signature: 'sig' }), IndexFormatError);
  assert.throws(() => VectorStore.deserialize(buf.subarray(0, buf.length - 4), { signature: 'sig' }), IndexFormatError);
  const bad = Buffer.from(buf);
  bad.writeUInt32LE(99, 8);
  assert.throws(() => VectorStore.deserialize(bad, { signature: 'sig' }), (e) => e.stale);
});

test('store: atomic write replaces the file and leaves no temp files', async () => {
  const dir = makeTmpDir('rag-atomic-');
  try {
    const file = path.join(dir, 'sub', 'index.bin');
    await writeFileAtomic(file, Buffer.from('eins'));
    await writeFileAtomic(file, Buffer.from('zwei'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'zwei');
    fs.writeFileSync(path.join(dir, 'sub', 'index.bin.123.abc.tmp'), 'crash leftover');
    await cleanupTempFiles(path.join(dir, 'sub'));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'sub')), ['index.bin']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
