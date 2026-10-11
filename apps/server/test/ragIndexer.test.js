// Vault indexer: incremental sync, failure tolerance, persistence, querying
// and the file watcher — against a real tmp vault with an injected,
// deterministic embedder (no model server). Ported from the former Python
// service's pytest suite (apps/rag/tests/test_api.py).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { RagIndexer, EmbeddingUnavailable, VaultUnavailable, MAX_TOP_K } from '../src/rag/indexer.js';
import { VaultWatcher } from '../src/rag/watcher.js';
import { INDEX_FILE } from '../src/rag/store.js';
import { makeTmpDir, writeNote, makeFakeEmbed, waitFor, SILENT_LOGGER } from '../test-support/rag.js';

const DRAGON = '# Drache\n\n## Hort\nDer rote Drache bewacht seinen Hort im Feuerberg.\n';
const TAVERN = '# Taverne\n\n## Wirt\nDer Wirt der Taverne heißt Bruno und braut Bier.\n';

let tmp;
let vault;
let indexDir;
let embed;
const indexers = [];

beforeEach(() => {
  tmp = makeTmpDir('rag-idx-');
  vault = path.join(tmp, 'vault');
  indexDir = path.join(tmp, 'index');
  fs.mkdirSync(vault);
  embed = makeFakeEmbed();
});

afterEach(async () => {
  while (indexers.length) await indexers.pop().stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeIndexer(opts = {}) {
  const idx = new RagIndexer({
    vaultPath: vault,
    indexDir,
    embed,
    signature: 'sig-A',
    logger: SILENT_LOGGER,
    watch: false,
    rescanIntervalMs: 0,
    saveDelayMs: 10,
    retryBaseMs: 20,
    retryMaxMs: 100,
    ...opts,
  });
  indexers.push(idx);
  return idx;
}

// Sorted chunk ids `<source>::<n>` currently in the index (optionally of one note).
function chunkIds(idx, source) {
  const ids = [];
  for (const [src, note] of idx.store.notes) {
    if (source && src !== source) continue;
    note.chunks.forEach((_, i) => ids.push(`${src}::${i}`));
  }
  return ids.sort();
}

const docCalls = () => embed.kinds.filter((k) => k === 'document').length;

// ── full sync ───────────────────────────────────────────────────────────────

test('empty vault', async () => {
  const idx = makeIndexer();
  assert.deepEqual(await idx.sync(), { files: 0, indexed: 0, failed: 0, pruned: 0, embedded: 0, reused: 0 });
});

test('index + query round-trip: closest chunk first, {text, source, distance}', async () => {
  writeNote(vault, 'orte/drache.md', DRAGON);
  writeNote(vault, 'orte/taverne.md', TAVERN);
  const idx = makeIndexer();
  const res = await idx.sync();
  assert.deepEqual(res, { files: 2, indexed: 4, failed: 0, pruned: 0, embedded: 2, reused: 0 });
  assert.equal(idx.status().chunks, 4);

  const hits = await idx.query('Wo ist der Hort des roten Drachen?', { topK: 2 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].source, 'orte/drache.md');
  assert.ok(hits[0].text.includes('Hort'));
  assert.deepEqual(Object.keys(hits[0]).sort(), ['distance', 'source', 'text']);
  assert.ok(hits[0].distance <= hits[1].distance);
  for (const h of hits) assert.ok(!h.text.startsWith('search_'), 'stored text carries no task prefix');
});

test('re-sync skips unchanged notes (no re-embedding)', async () => {
  writeNote(vault, 'a.md', DRAGON);
  writeNote(vault, 'b.md', TAVERN);
  const idx = makeIndexer();
  await idx.sync();
  const before = embed.calls;
  const res = await idx.sync();
  assert.equal(res.indexed, 4);
  assert.equal(res.embedded, 0);
  assert.equal(embed.calls, before);
});

test('an edit replaces the note\'s chunks without leaving stale ids', async () => {
  const p = writeNote(vault, 'a.md', '# A\n\n## Eins\nx\n\n## Zwei\ny\n\n## Drei\nz\n');
  const idx = makeIndexer();
  await idx.sync();
  assert.deepEqual(chunkIds(idx, 'a.md'), ['a.md::0', 'a.md::1', 'a.md::2', 'a.md::3']);
  fs.writeFileSync(p, '# A\n\n## Eins\nneu\n');
  await idx.sync();
  assert.deepEqual(chunkIds(idx, 'a.md'), ['a.md::0', 'a.md::1']);
  const hits = await idx.query('neu', { topK: 5 });
  assert.ok(hits.every((h) => !h.text.endsWith('\ny')));
});

test('deleted and renamed notes are pruned', async () => {
  const a = writeNote(vault, 'a.md', DRAGON);
  const b = writeNote(vault, 'b.md', TAVERN);
  const idx = makeIndexer();
  await idx.sync();
  fs.unlinkSync(a);
  fs.renameSync(b, path.join(vault, 'c.md'));
  const res = await idx.sync();
  assert.equal(res.files, 1);
  assert.equal(res.pruned, 2);
  assert.deepEqual(chunkIds(idx), ['c.md::0', 'c.md::1']);
  assert.equal(res.embedded, 0, 'a renamed note keeps its vectors');
  assert.equal(res.reused, 1);
});

test('moving a folder re-uses the vectors of its notes (no embedding calls)', async () => {
  writeNote(vault, 'ordner/a.md', DRAGON);
  writeNote(vault, 'ordner/b.md', TAVERN);
  const idx = makeIndexer();
  await idx.sync();
  const calls = embed.calls;
  fs.renameSync(path.join(vault, 'ordner'), path.join(vault, 'anders'));
  const res = await idx.sync();
  assert.deepEqual([res.embedded, res.reused, res.pruned], [0, 2, 2]);
  assert.equal(embed.calls, calls);
  assert.deepEqual(chunkIds(idx), ['anders/a.md::0', 'anders/a.md::1', 'anders/b.md::0', 'anders/b.md::1']);
  assert.equal((await idx.query('Hort des roten Drachen', { topK: 1 }))[0].source, 'anders/a.md');
});

test('quick (periodic) rescans trust size + mtime; full syncs compare content', async () => {
  const T = new Date('2026-01-01T12:00:00Z');
  const p = writeNote(vault, 'a.md', '## A\nalpha\n');
  fs.utimesSync(p, T, T);
  const idx = makeIndexer();
  await idx.sync();
  fs.writeFileSync(p, '## A\nomega\n'); // same size …
  fs.utimesSync(p, T, T); // … and the same mtime: looks unchanged
  const quick = await idx.sync({ quick: true });
  assert.equal(quick.embedded, 0);
  assert.match(idx.store.getNote('a.md').chunks[0].text, /alpha/, 'quick rescan did not even read it');
  await idx.sync();
  assert.match(idx.store.getNote('a.md').chunks[0].text, /omega/, 'a full sync compares content hashes');
  // A normal edit (new mtime) is picked up by a quick rescan too.
  fs.writeFileSync(p, '## A\nneuer Inhalt\n');
  assert.equal((await idx.sync({ quick: true })).embedded, 1);
});

test('the periodic rescan keeps the index current without a watcher', async () => {
  const idx = makeIndexer({ rescanIntervalMs: 60 });
  await idx.start();
  await idx.whenSynced();
  writeNote(vault, 'spaet.md', '## Neu\nnachgereicht\n');
  await waitFor(() => chunkIds(idx).includes('spaet.md::0'), 3000, 'periodic rescan');
  assert.equal(idx.status().watcher, 'off');
});

test('a frontmatter `source:` field neither duplicates chunks nor changes the hit source', async () => {
  const p = writeNote(vault, 'clip.md', '---\nsource: https://example.org\n---\n## A\nalt\n');
  const idx = makeIndexer();
  await idx.sync();
  fs.writeFileSync(p, '---\nsource: https://example.org\n---\n## A\nneu\n');
  await idx.sync();
  assert.deepEqual(chunkIds(idx), ['clip.md::0']);
  const [hit] = await idx.query('neu');
  assert.equal(hit.source, 'clip.md');
  assert.equal(idx.store.getNote('clip.md').meta.source, 'clip.md');
});

test('non-UTF-8 and BOM notes do not abort the sync', async () => {
  writeNote(vault, 'cp1252.md', '## Größe\nÄrger über Öl\n', 'latin1');
  writeNote(vault, 'bom.md', '﻿---\ntype: ort\n---\n## Wald\nBäume\n');
  writeNote(vault, 'ok.md', DRAGON);
  const idx = makeIndexer();
  const res = await idx.sync();
  assert.equal(res.files, 3);
  assert.equal(res.failed, 0);
  assert.equal(idx.store.getNote('bom.md').meta.type, 'ort');
  assert.ok(!idx.store.getNote('bom.md').chunks[0].text.includes('type: ort'));
});

test('dot-directories are not indexed; a note moved into .trash is pruned', async () => {
  writeNote(vault, '.trash/alt.md', DRAGON);
  writeNote(vault, '.obsidian/tpl.md', TAVERN);
  const a = writeNote(vault, 'a.md', '## X\ny\n');
  const idx = makeIndexer();
  assert.equal((await idx.sync()).files, 1);
  assert.deepEqual(chunkIds(idx), ['a.md::0']);
  fs.renameSync(a, path.join(vault, '.trash', 'a.md'));
  await idx.sync();
  assert.deepEqual(chunkIds(idx), []);
});

test('an oversized note is skipped (its old chunks dropped, not left stale)', async () => {
  const big = writeNote(vault, 'big.md', '## A\nklein\n');
  writeNote(vault, 'small.md', '## B\ny\n');
  const idx = makeIndexer({ maxFileBytes: 100 });
  await idx.sync();
  assert.deepEqual(chunkIds(idx), ['big.md::0', 'small.md::0']);
  fs.writeFileSync(big, '## A\n' + 'x '.repeat(200));
  await idx.sync();
  assert.deepEqual(chunkIds(idx), ['small.md::0']);
});

test('one failing note is skipped, not fatal', async () => {
  writeNote(vault, 'a.md', DRAGON);
  writeNote(vault, 'b.md', TAVERN);
  const idx = makeIndexer();
  const real = idx._indexNote.bind(idx);
  idx._indexNote = (full, source) => (source === 'a.md' ? Promise.reject(new Error('broken note')) : real(full, source));
  const res = await idx.sync();
  assert.deepEqual([res.files, res.indexed, res.failed], [2, 2, 1]);
  assert.match(idx.status().lastError, /1 note/);
});

// ── embedding backend failures ──────────────────────────────────────────────

test('sync while the embedding backend is down keeps the existing index; recovers later', async () => {
  writeNote(vault, 'a.md', DRAGON);
  const idx = makeIndexer();
  await idx.sync();
  const before = chunkIds(idx);
  writeNote(vault, 'a.md', DRAGON + '\n## Neu\nmehr\n');
  writeNote(vault, 'b.md', TAVERN);
  embed.fail = true;
  await assert.rejects(() => idx.sync(), EmbeddingUnavailable);
  assert.deepEqual(chunkIds(idx), before, 'nothing wiped, old chunks still searchable');
  assert.equal(idx.status().embedOk, false);
  embed.fail = false;
  assert.equal((await idx.sync()).indexed, 5);
});

test('a failed note update keeps the previous chunks (watcher path)', async () => {
  const p = writeNote(vault, 'a.md', DRAGON);
  const idx = makeIndexer();
  await idx.syncNote('a.md');
  fs.writeFileSync(p, '## Ganz neu\nanderer Text\n');
  embed.fail = true;
  await assert.rejects(() => idx.syncNote('a.md'), EmbeddingUnavailable);
  assert.ok(idx.store.getNote('a.md').chunks.some((c) => c.text.includes('Hort')));
  embed.fail = false;
  assert.equal(await idx.syncNote('a.md'), 1);
});

test('query when the backend is down throws EmbeddingUnavailable', async () => {
  writeNote(vault, 'a.md', DRAGON);
  const idx = makeIndexer();
  await idx.sync();
  embed.fail = true;
  await assert.rejects(() => idx.query('Drache'), EmbeddingUnavailable);
});

test('documents and queries are embedded with their own kind; a bad reply is a backend error', async () => {
  writeNote(vault, 'a.md', DRAGON);
  const idx = makeIndexer();
  await idx.sync();
  assert.deepEqual([...new Set(embed.kinds)], ['document']);
  embed.kinds.length = 0;
  await idx.query('bier');
  assert.deepEqual(embed.kinds, ['query']);
  embed.hook = null;
  const broken = makeIndexer({ embed: async () => [[]], indexDir: path.join(tmp, 'other') });
  await assert.rejects(() => broken.sync(), EmbeddingUnavailable);
});

// ── query parameters ────────────────────────────────────────────────────────

async function twoNotes() {
  writeNote(vault, 'drache.md', '## Hort\nroter drache hort feuerberg\n');
  writeNote(vault, 'wirt.md', '## Wirt\nbruno braut bier taverne\n');
  const idx = makeIndexer();
  await idx.sync();
  return idx;
}

test('threshold (max cosine distance) drops far hits', async () => {
  const idx = await twoNotes();
  let hits = await idx.query('roter drache hort feuerberg', { topK: 5 });
  assert.equal(hits.length, 2);
  assert.ok(hits[0].distance < 0.2 && hits[1].distance > 0.5);
  hits = await idx.query('roter drache hort feuerberg', { topK: 5, threshold: 0.3 });
  assert.deepEqual(hits.map((h) => h.source), ['drache.md']);
  assert.equal((await idx.query('roter drache hort feuerberg', { topK: 5, threshold: 2 })).length, 2);
});

test('topK is clamped to 1..20 (invalid → 3), never more than the index holds', async () => {
  for (let i = 0; i < 25; i++) writeNote(vault, `n${i}.md`, `## N${i}\nnotiz nummer ${i}\n`);
  const idx = makeIndexer();
  await idx.sync();
  assert.equal((await idx.query('notiz', { topK: 50 })).length, MAX_TOP_K);
  assert.equal((await idx.query('notiz', { topK: 0 })).length, 3);
  assert.equal((await idx.query('notiz', { topK: 'abc' })).length, 3);
  assert.equal((await idx.query('notiz', { topK: 2.7 })).length, 2);
});

test('topK larger than the index returns every chunk', async () => {
  const idx = await twoNotes();
  assert.equal((await idx.query('bier', { topK: 10 })).length, 2);
});

test('a blank query, an empty index or an index that is not loaded → [] without embedding', async () => {
  const idx = makeIndexer();
  assert.deepEqual(await idx.query('irgendwas'), [], 'not loaded yet');
  await idx.sync();
  assert.deepEqual(await idx.query('   '), []);
  assert.deepEqual(await idx.query('irgendwas'), [], 'empty index');
  assert.equal(embed.calls, 0);
});

// ── signature / chunker changes ─────────────────────────────────────────────

test('an embedding signature change rebuilds the index (also live, from a query)', async () => {
  writeNote(vault, 'a.md', DRAGON);
  let sig = 'model-A';
  const idx = makeIndexer({ signature: () => sig });
  await idx.sync();
  assert.equal(idx.status().chunks, 2);
  const docsBefore = docCalls();
  sig = 'model-B';
  assert.deepEqual(await idx.query('Drache'), [], 'old vectors are not comparable — no hits');
  await waitFor(() => idx.store.signature === 'model-B' && idx.status().chunks === 2 && !idx.indexing, 3000, 'rebuild');
  assert.ok(docCalls() > docsBefore, 're-embedded with the new model');
  assert.equal((await idx.query('Drache')).length, 2);
});

test('a persisted index from another embedding signature is discarded on load', async () => {
  writeNote(vault, 'a.md', DRAGON);
  const first = makeIndexer({ signature: 'model-A' });
  await first.sync();
  await first.stop();
  const second = makeIndexer({ signature: 'model-B' });
  await second.start();
  assert.equal(second.status().chunks, 0, 'stale vectors dropped');
  await second.whenSynced();
  assert.equal(second.status().chunks, 2);
});

test('changing the chunk size re-embeds every note once', async () => {
  writeNote(vault, 'a.md', DRAGON);
  writeNote(vault, 'b.md', TAVERN);
  const first = makeIndexer({ maxChunkChars: 2000 });
  await first.sync();
  await first.stop();
  const second = makeIndexer({ maxChunkChars: 1500 });
  assert.equal((await second.sync()).embedded, 2);
  assert.equal((await second.sync()).embedded, 0);
});

test('a different vector size under the same signature resets and rebuilds', async () => {
  writeNote(vault, 'a.md', DRAGON);
  const b = writeNote(vault, 'b.md', TAVERN);
  const idx = makeIndexer();
  await idx.sync();
  assert.equal(idx.store.dim, 64);
  embed.dim = 32; // the model behind the same name changed
  fs.appendFileSync(b, '\nmehr\n');
  await idx.syncNote('b.md');
  await waitFor(() => !idx.indexing && idx.status().chunks === 4 && idx.store.dim === 32, 3000, 'rebuild');
  assert.equal((await idx.query('Drache')).length, 3);
});

// ── persistence / restart ───────────────────────────────────────────────────

test('the index survives a restart: queries work before any re-sync, unchanged notes are not re-embedded', async () => {
  writeNote(vault, 'orte/drache.md', DRAGON);
  writeNote(vault, 'orte/taverne.md', TAVERN);
  const first = makeIndexer();
  await first.sync();
  await first.stop();
  assert.ok(fs.existsSync(path.join(indexDir, INDEX_FILE)));

  embed = makeFakeEmbed();
  embed.docDelayMs = 0;
  const second = makeIndexer({ retryBaseMs: 60_000 });
  // Block the background sync so the query provably runs on the loaded file.
  let release;
  const gate = new Promise((r) => { release = r; });
  second._syncOnce = ((orig) => async () => { await gate; return orig(); })(second._syncOnce.bind(second));
  await second.start();
  assert.equal(second.status().ready, true);
  assert.equal(second.status().chunks, 4);
  const hits = await second.query('Hort des roten Drachen', { topK: 1 });
  assert.equal(hits[0].source, 'orte/drache.md');
  release();
  await second.whenSynced();
  assert.equal(docCalls(), 0, 'no document re-embedded after the restart');
});

test('changes made while the server was down are picked up on start', async () => {
  writeNote(vault, 'a.md', DRAGON);
  const first = makeIndexer();
  await first.sync();
  await first.stop();
  fs.unlinkSync(path.join(vault, 'a.md'));
  writeNote(vault, 'b.md', TAVERN);
  const second = makeIndexer();
  await second.start();
  await second.whenSynced();
  assert.deepEqual(chunkIds(second), ['b.md::0', 'b.md::1']);
});

test('a corrupt index file is discarded and rebuilt — never an error', async () => {
  writeNote(vault, 'a.md', DRAGON);
  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(path.join(indexDir, INDEX_FILE), 'garbage');
  const idx = makeIndexer();
  await idx.start();
  await idx.whenSynced();
  assert.equal(idx.status().chunks, 2);
  await idx.stop();
  assert.ok(fs.readFileSync(path.join(indexDir, INDEX_FILE)).subarray(0, 7).equals(Buffer.from('VARAGIX')));
});

test('startup syncs in the background and retries until the backend is up', async () => {
  writeNote(vault, 'a.md', DRAGON);
  embed.fail = true;
  const idx = makeIndexer();
  await idx.start(); // resolves immediately (index loaded), sync keeps retrying
  assert.equal(idx.status().ready, true);
  await waitFor(() => embed.calls >= 2, 3000, 'retries');
  assert.ok(idx.status().lastError);
  embed.fail = false;
  await waitFor(() => idx.status().chunks === 2, 3000, 'index built');
});

test('a missing vault: start() works, sync reports VaultUnavailable, queries return []', async () => {
  const idx = makeIndexer({ vaultPath: path.join(tmp, 'missing') });
  await idx.start();
  await idx.whenSynced();
  assert.match(idx.status().lastError, /vault not available/);
  await assert.rejects(() => idx.sync(), VaultUnavailable);
  assert.deepEqual(await idx.query('x'), []);
});

test('stop() aborts in-flight embeddings and returns promptly', async () => {
  writeNote(vault, 'a.md', DRAGON);
  embed.docDelayMs = 10_000;
  const idx = makeIndexer();
  await idx.start();
  await waitFor(() => embed.calls >= 1, 2000, 'embedding started');
  const t0 = Date.now();
  await idx.stop();
  assert.ok(Date.now() - t0 < 1000, `stop took ${Date.now() - t0} ms`);
  assert.deepEqual(await idx.query('Drache'), []);
});

// ── concurrency ─────────────────────────────────────────────────────────────

test('a long sync does not block queries', async () => {
  writeNote(vault, 'a.md', DRAGON);
  const idx = makeIndexer();
  await idx.sync();
  writeNote(vault, 'gross.md', Array.from({ length: 10 }, (_, i) => `## Teil ${i}\ntext ${i}\n\n`).join(''));
  embed.docDelayMs = 600;
  const running = idx.sync();
  await waitFor(() => idx.indexing && docCalls() > 1, 2000, 'sync in progress');
  const t0 = Date.now();
  assert.equal(idx.status().indexing, true);
  assert.ok((await idx.query('Drache')).length > 0);
  assert.ok(Date.now() - t0 < 300, `query took ${Date.now() - t0} ms`);
  await running;
});

test('concurrent sync() calls share one run and queue exactly one more pass', async () => {
  writeNote(vault, 'a.md', DRAGON);
  const idx = makeIndexer();
  let runs = 0;
  idx._syncOnce = ((orig) => async () => { runs++; return orig(); })(idx._syncOnce.bind(idx));
  const p1 = idx.sync();
  const p2 = idx.sync();
  const p3 = idx.sync();
  assert.equal(p1, p2);
  assert.equal(p2, p3);
  await p1;
  assert.equal(runs, 2);
});

test('an older read of a note never lands last (per-note serialization)', async () => {
  // T1 reads version1 and stalls in the embedder; meanwhile the note is saved
  // again and synced (T2). Without per-note locking T1 would finish last and
  // put version1 back. With it, T2 waits for T1, then reads version2.
  const p = writeNote(vault, 'a.md', '## V\nversion1\n');
  const idx = makeIndexer();
  embed.hook = async (texts) => {
    if (texts.some((t) => t.includes('version1'))) await new Promise((r) => setTimeout(r, 300));
  };
  const t1 = idx.syncNote('a.md');
  await waitFor(() => embed.calls >= 1, 2000, 'T1 embedding');
  fs.writeFileSync(p, '## V\nversion2\n');
  const t2 = idx.syncNote('a.md');
  await Promise.all([t1, t2]);
  assert.deepEqual(idx.store.getNote('a.md').chunks.map((c) => c.text), ['## V\nversion2']);
});

// ── watcher ─────────────────────────────────────────────────────────────────

test('watcher: edits, renames, deletes, folder moves and .trash are synced (debounced)', async () => {
  const idx = makeIndexer({ watch: true, debounceMs: 50 });
  await idx.start();
  await idx.whenSynced();
  assert.equal(idx.status().watcher, 'watching');
  const ids = (want, what) => waitFor(() => JSON.stringify(chunkIds(idx)) === JSON.stringify(want), 5000, what);

  const p = writeNote(vault, 'neu.md', '## A\nalpha\n');
  await ids(['neu.md::0'], 'create');

  fs.writeFileSync(p, '## A\nalpha\n\n## B\nbeta\n');
  await ids(['neu.md::0', 'neu.md::1'], 'edit');

  fs.renameSync(p, path.join(vault, 'umbenannt.md'));
  await ids(['umbenannt.md::0', 'umbenannt.md::1'], 'rename');

  fs.unlinkSync(path.join(vault, 'umbenannt.md'));
  await ids([], 'delete');

  // Moving a whole folder triggers a reconcile of the vault.
  writeNote(vault, 'ordner/x.md', '## X\nx\n');
  await ids(['ordner/x.md::0'], 'create in new folder');
  fs.renameSync(path.join(vault, 'ordner'), path.join(vault, 'anders'));
  await ids(['anders/x.md::0'], 'folder move');

  // Notes moved to Obsidian's .trash disappear from the index.
  fs.mkdirSync(path.join(vault, '.trash'));
  fs.renameSync(path.join(vault, 'anders', 'x.md'), path.join(vault, '.trash', 'x.md'));
  await ids([], 'moved to .trash');
});

test('watcher: a burst of saves to one note costs one sync', async () => {
  const idx = makeIndexer({ watch: true, debounceMs: 150 });
  await idx.start();
  await idx.whenSynced();
  const p = writeNote(vault, 'a.md', '## A\nv0\n');
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(p, `## A\nv${i}\n`);
    await new Promise((r) => setTimeout(r, 20));
  }
  await waitFor(() => idx.store.getNote('a.md')?.chunks[0].text === '## A\nv5', 3000, 'final version');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(docCalls(), 1, 'debounced into a single embedding call');
});

test('watcher: unsupported platform / runtime errors turn it off, never throw', async () => {
  const warnings = [];
  const logger = { ...SILENT_LOGGER, warn: (m) => warnings.push(m) };
  const throwing = new VaultWatcher(vault, {
    logger,
    watchFn: () => { const e = new Error('no recursive watch'); e.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'; throw e; },
  });
  assert.equal(throwing.start(), false);
  assert.equal(throwing.state, 'failed');

  const emitter = new EventEmitter();
  emitter.close = () => {};
  const failing = new VaultWatcher(vault, { logger, watchFn: () => emitter });
  assert.equal(failing.start(), true);
  emitter.emit('error', Object.assign(new Error('inotify limit'), { code: 'ENOSPC' }));
  assert.equal(failing.state, 'failed');
  assert.equal(warnings.length, 2);
});

test('watcher: ignores dot paths, debounces per note, rescans for folders and unnamed events', async () => {
  let cb;
  const emitter = new EventEmitter();
  emitter.close = () => {};
  const notes = [];
  let rescans = 0;
  const w = new VaultWatcher(vault, {
    debounceMs: 30,
    watchFn: (_root, _opts, listener) => { cb = listener; return emitter; },
    onNote: (s) => notes.push(s),
    onRescan: () => { rescans++; },
    ignore: (rel) => rel.startsWith('index/'),
  });
  w.start();
  fs.mkdirSync(path.join(vault, 'ordner'));
  cb('change', path.join('.obsidian', 'workspace.json'));
  cb('rename', '.trash/x.md');
  cb('change', 'index/x.md');
  cb('change', 'a.md');
  cb('change', 'a.md');
  cb('rename', path.join('npc', 'b.md'));
  cb('rename', 'ordner');
  cb('rename', null);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(notes.sort(), ['a.md', 'npc/b.md']);
  assert.equal(rescans, 1, 'folder + unnamed event coalesce into one rescan');
  w.close();
});
