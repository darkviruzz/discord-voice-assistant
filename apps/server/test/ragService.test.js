// Integration: the server-facing RAG API (src/rag/index.js) end to end —
// settings from process.env, the real providers/embed.js talking to a fake
// Ollama /api/embed over HTTP (deterministic vectors), a real tmp vault and a
// real index directory. This is the path campaignContext.js and
// sessionBriefing.js use.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  queryRag, ragEnabled, ragConfig, ragStatus, startRag, stopRag, formatRagHits,
  _activeIndexer, _resetState,
} from '../src/rag/index.js';
import { makeTmpDir, writeNote, waitFor, startFakeOllama } from '../test-support/rag.js';

const DRAGON = '# Drache\n\n## Hort\nDer rote Drache bewacht seinen Hort im Feuerberg.\n';
const TAVERN = '# Taverne\n\n## Wirt\nDer Wirt der Taverne heißt Bruno und braut Bier.\n';

const ENV_KEYS = [
  'RAG_ENABLED', 'OBSIDIAN_VAULT_PATH', 'RAG_INDEX_DIR', 'RAG_TIMEOUT_MS', 'RAG_SCORE_THRESHOLD',
  'RAG_MAX_CHUNK_CHARS', 'RAG_RESCAN_INTERVAL_MS', 'OLLAMA_URL', 'DATA_DIR',
  'EMBED_PROVIDER', 'EMBED_BASE_URL', 'EMBED_MODEL', 'EMBED_API_KEY', 'EMBED_KEEP_ALIVE',
  'EMBED_QUERY_PREFIX', 'EMBED_DOC_PREFIX',
];
const FAST = { debounceMs: 50, saveDelayMs: 10, retryBaseMs: 20, retryMaxMs: 100 };

let saved;
let tmp;
let vault;
let ollama;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmp = makeTmpDir('rag-svc-');
  vault = path.join(tmp, 'vault');
  fs.mkdirSync(vault);
  ollama = await startFakeOllama();
  process.env.OLLAMA_URL = ollama.url;
  process.env.OBSIDIAN_VAULT_PATH = vault;
  process.env.RAG_INDEX_DIR = path.join(tmp, 'index');
  _resetState();
});

afterEach(async () => {
  await stopRag();
  await ollama.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function startAndSync() {
  await startRag(FAST);
  await _activeIndexer().whenSynced();
}

const embedInputs = (pred) => ollama.calls.embed.flatMap((c) => c.input).filter(pred);

async function captureLogs(fn) {
  const lines = { warn: [], info: [] };
  const origWarn = console.warn;
  const origLog = console.log;
  console.warn = (...a) => { lines.warn.push(a.join(' ')); };
  console.log = (...a) => { lines.info.push(a.join(' ')); };
  try { await fn(); } finally { console.warn = origWarn; console.log = origLog; }
  return lines;
}

test('ragEnabled: RAG_ENABLED (default true) AND a vault path', () => {
  assert.equal(ragEnabled(), true);
  for (const off of ['false', 'FALSE', '0', ' off ']) {
    process.env.RAG_ENABLED = off;
    assert.equal(ragEnabled(), false, `RAG_ENABLED=${off}`);
  }
  process.env.RAG_ENABLED = 'true';
  process.env.OBSIDIAN_VAULT_PATH = '   ';
  assert.equal(ragEnabled(), false, 'no vault → off');
});

test('end to end: index the vault through /api/embed, query ranks the right note first', async () => {
  writeNote(vault, 'orte/drache.md', DRAGON);
  writeNote(vault, 'orte/taverne.md', TAVERN);
  await startAndSync();
  assert.equal(ragStatus().chunks, 4);

  const hits = await queryRag('Wo ist der Hort des roten Drachen?', { topK: 2 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].source, 'orte/drache.md');
  assert.match(hits[0].text, /Hort/);
  assert.ok(hits[0].distance < hits[1].distance);

  // Provider contract: nomic task prefixes per kind, model + keep_alive sent.
  const docCall = ollama.calls.embed[0];
  assert.equal(docCall.model, 'nomic-embed-text');
  assert.equal(docCall.keep_alive, '30m');
  assert.ok(docCall.input.every((t) => t.startsWith('search_document: ')));
  assert.deepEqual(embedInputs((t) => t.startsWith('search_query: ')), ['search_query: Wo ist der Hort des roten Drachen?']);
});

test('formatRagHits renders [Quelle: …] blocks and drops blank hits', () => {
  assert.equal(formatRagHits([
    { text: 'Baron Kelthur herrscht.', source: 'npcs/kelthur.md', distance: 0.21 },
    { text: '  ', source: 'leer.md' },
    { text: 'Ohne Quelle.' },
  ]), '[Quelle: npcs/kelthur.md]\nBaron Kelthur herrscht.\n\nOhne Quelle.');
  assert.equal(formatRagHits(null), '');
});

test('RAG_SCORE_THRESHOLD filters far hits; a per-call threshold overrides it', async () => {
  writeNote(vault, 'drache.md', '## Hort\nroter drache hort feuerberg\n');
  writeNote(vault, 'wirt.md', '## Wirt\nbruno braut bier taverne\n');
  await startAndSync();
  const q = 'roter drache hort feuerberg';
  assert.equal((await queryRag(q, { topK: 5 })).length, 2);
  process.env.RAG_SCORE_THRESHOLD = '0.4';
  assert.deepEqual((await queryRag(q, { topK: 5 })).map((h) => h.source), ['drache.md']);
  assert.equal((await queryRag(q, { topK: 5, scoreThreshold: null })).length, 2);
  process.env.RAG_SCORE_THRESHOLD = '-1'; // invalid → no filter
  assert.equal((await queryRag(q, { topK: 5 })).length, 2);
});

test('fail-soft: blank query, disabled, slow or failing backend → [] (bounded by RAG_TIMEOUT_MS)', async () => {
  writeNote(vault, 'a.md', DRAGON);
  await startAndSync();
  assert.deepEqual(await queryRag('   '), []);
  assert.deepEqual(await queryRag(null), []);

  process.env.RAG_ENABLED = 'false';
  const before = ollama.calls.embed.length;
  assert.deepEqual(await queryRag('Drache'), []);
  assert.equal(ollama.calls.embed.length, before, 'disabled → no embedding call');
  assert.equal(_activeIndexer(), null, 'disabled → indexer stopped');
  process.env.RAG_ENABLED = 'true';
  assert.deepEqual(await queryRag('Drache'), [], 're-enabled: index loading again');
  await waitFor(() => _activeIndexer()?.ready, 3000, 'indexer back');

  process.env.RAG_TIMEOUT_MS = '60';
  ollama.opts.queryDelayMs = 1000;
  const t0 = Date.now();
  assert.deepEqual(await queryRag('Drache'), []);
  assert.ok(Date.now() - t0 < 500, `bounded by RAG_TIMEOUT_MS (took ${Date.now() - t0} ms)`);
  // An off-hot-path caller (the /join briefing) may wait longer.
  ollama.opts.queryDelayMs = 150;
  assert.equal((await queryRag('Drache', { timeoutMs: 3000 })).length, 2);

  ollama.opts.queryDelayMs = 0;
  ollama.opts.queryStatus = 500;
  assert.deepEqual(await queryRag('Drache'), []);
});

test('warns once when queries start failing and logs once when they recover', async () => {
  writeNote(vault, 'a.md', DRAGON);
  await startAndSync();
  const lines = await captureLogs(async () => {
    ollama.opts.queryStatus = 404;
    await queryRag('a');
    await queryRag('b');
    await queryRag('c');
    ollama.opts.queryStatus = 200;
    await queryRag('d');
    await queryRag('e');
  });
  const warns = lines.warn.filter((l) => l.includes('vault search unavailable'));
  assert.equal(warns.length, 1, warns.join(' | '));
  assert.match(warns[0], /HTTP 404/);
  assert.equal(lines.info.filter((l) => l.includes('vault search available again')).length, 1);
});

test('not started yet: the first query starts the indexer and returns [] until it is ready', async () => {
  writeNote(vault, 'a.md', DRAGON);
  assert.equal(_activeIndexer(), null);
  assert.deepEqual(await queryRag('Drache'), []);
  const idx = _activeIndexer();
  assert.ok(idx, 'indexer started lazily');
  await idx.whenSynced();
  assert.equal((await queryRag('Drache')).length, 2);
});

test('a changed vault path (settings panel) restarts the indexer on the next query', async () => {
  writeNote(vault, 'a.md', DRAGON);
  await startAndSync();
  const first = _activeIndexer();
  const other = path.join(tmp, 'vault2');
  writeNote(other, 'b.md', TAVERN);
  process.env.OBSIDIAN_VAULT_PATH = other;
  await queryRag('Bier');
  const second = _activeIndexer();
  assert.notEqual(second, first);
  await waitFor(() => second.lastSync, 3000, 'new vault synced');
  const hits = await queryRag('Wirt Bruno Bier', { topK: 5 });
  assert.deepEqual([...new Set(hits.map((h) => h.source))], ['b.md'], 'old vault pruned');
});

test('the index persists across stopRag/startRag: no document is re-embedded', async () => {
  writeNote(vault, 'a.md', DRAGON);
  writeNote(vault, 'b.md', TAVERN);
  await startAndSync();
  await stopRag();
  assert.deepEqual(await queryRag('Drache'), [], 'stopped: no implicit restart');
  assert.equal(_activeIndexer(), null);
  ollama.calls.embed.length = 0;
  await startAndSync();
  assert.equal(ragStatus().chunks, 4);
  assert.equal((await queryRag('Drache')).length, 3);
  assert.deepEqual(embedInputs((t) => t.startsWith('search_document: ')), []);
});

test('a live EMBED_MODEL change rebuilds the index with the new model', async () => {
  writeNote(vault, 'a.md', DRAGON);
  await startAndSync();
  process.env.EMBED_MODEL = 'mxbai-embed-large';
  assert.deepEqual(await queryRag('Drache'), [], 'old vectors are not comparable');
  await waitFor(() => ollama.calls.embed.some((c) => c.model === 'mxbai-embed-large') && !ragStatus().indexing
    && ragStatus().chunks === 2, 3000, 'rebuild');
  const hits = await queryRag('Drache');
  assert.equal(hits.length, 2);
  // No nomic prefixes for other models.
  assert.ok(ollama.calls.embed.filter((c) => c.model === 'mxbai-embed-large').every((c) => c.input.every((t) => !t.startsWith('search_'))));
});

test('ragConfig reports the effective settings and the index state', async () => {
  let cfg = ragConfig();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.provider, 'ollama');
  assert.equal(cfg.model, 'nomic-embed-text');
  assert.equal(cfg.timeoutMs, 800);
  assert.equal(cfg.scoreThreshold, null);
  assert.equal(cfg.maxChunkChars, 2000);
  assert.equal(cfg.rescanIntervalMs, 300000);
  assert.equal(cfg.indexDir, path.join(tmp, 'index'));
  assert.equal(cfg.index, null, 'not started');
  for (const v of ['abc', '0', '-5', '']) {
    process.env.RAG_TIMEOUT_MS = v;
    assert.equal(ragConfig().timeoutMs, 800, `RAG_TIMEOUT_MS=${JSON.stringify(v)}`);
  }
  process.env.RAG_TIMEOUT_MS = '5000000000';
  assert.equal(ragConfig().timeoutMs, 2_147_483_647);
  process.env.RAG_RESCAN_INTERVAL_MS = '0';
  assert.equal(ragConfig().rescanIntervalMs, 0, '0 = periodic rescan off');
  delete process.env.RAG_TIMEOUT_MS;
  delete process.env.RAG_RESCAN_INTERVAL_MS;

  writeNote(vault, 'a.md', DRAGON);
  await startAndSync();
  cfg = ragConfig();
  assert.equal(cfg.index.ready, true);
  assert.equal(cfg.index.chunks, 2);
  assert.equal(cfg.index.notes, 1);
  assert.ok(cfg.index.lastSyncAt);
  assert.ok(fs.existsSync(path.join(tmp, 'index', 'index.bin')));
});

test('default index dir is DATA_DIR/rag (./data/rag)', () => {
  delete process.env.RAG_INDEX_DIR;
  assert.equal(ragConfig().indexDir, path.resolve('./data/rag'));
  process.env.DATA_DIR = path.join(tmp, 'd');
  assert.equal(ragConfig().indexDir, path.join(tmp, 'd', 'rag'));
});
