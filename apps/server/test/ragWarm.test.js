// RAG embedding warm-up (rag/index.js warmRag, keepWarm.js).
//
// Live evidence 2026-10-18: the index was loaded from disk (nothing to
// embed), so the first wake-word query was the first request for
// nomic-embed-text. Its embed hit RAG_TIMEOUT_MS (800 ms) and was aborted;
// Ollama logged "client connection closed before llama-server finished
// loading, aborting load", the model never got loaded, and every query of the
// evening fell back to CAMPAIGN.md. The fake Ollama below behaves the same:
// a cold model needs `loadMs`, and a client that leaves before that aborts
// the load.

import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { queryRag, startRag, stopRag, warmRag, _activeIndexer, _resetState } from '../src/rag/index.js';
import { startKeepWarm, stopKeepWarm } from '../src/keepWarm.js';
import { fakeVector, makeTmpDir, writeNote, waitFor } from '../test-support/rag.js';

const DRAGON = '# Drache\n\n## Hort\nDer rote Drache bewacht seinen Hort im Feuerberg.\n';
const FAST = { debounceMs: 50, saveDelayMs: 10, retryBaseMs: 20, retryMaxMs: 100 };

const model = { loaded: false, loadMs: 300, loads: 0, aborted: 0, status: 200 };
const calls = { embed: [], chat: [] };
const ollama = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    const body = raw ? JSON.parse(raw) : {};
    let gone = false;
    res.on('close', () => { if (!res.writableFinished) gone = true; });
    const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (req.url === '/api/chat') { calls.chat.push(body); send(200, { message: { role: 'assistant', content: '' } }); return; }
    if (req.url !== '/api/embed') { send(404, { error: 'not found' }); return; }
    calls.embed.push(body);
    if (model.status !== 200) { send(model.status, { error: 'model "nomic-embed-text" not found (test)' }); return; }
    if (!model.loaded) {
      await new Promise((r) => setTimeout(r, model.loadMs));
      if (gone) { model.aborted++; return; } // aborting load
      model.loaded = true;
      model.loads++;
    }
    send(200, { model: body.model, embeddings: body.input.map((t) => fakeVector(t)) });
  });
});
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
after(() => { ollama.closeAllConnections(); ollama.close(); });

const ENV_KEYS = ['RAG_ENABLED', 'OBSIDIAN_VAULT_PATH', 'RAG_INDEX_DIR', 'RAG_TIMEOUT_MS', 'OLLAMA_URL',
  'EMBED_PROVIDER', 'EMBED_BASE_URL', 'EMBED_MODEL', 'EMBED_QUERY_PREFIX', 'EMBED_DOC_PREFIX',
  'OLLAMA_KEEP_WARM_INTERVAL_MS', 'LLM_PROVIDER', 'LLM_THINK', 'OLLAMA_MODEL'];
let saved;
let tmp;
let vault;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tmp = makeTmpDir('rag-warm-');
  vault = path.join(tmp, 'vault');
  fs.mkdirSync(vault);
  process.env.OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;
  process.env.OBSIDIAN_VAULT_PATH = vault;
  process.env.RAG_INDEX_DIR = path.join(tmp, 'index');
  Object.assign(model, { loaded: false, loadMs: 300, loads: 0, aborted: 0, status: 200 });
  calls.embed.length = 0;
  calls.chat.length = 0;
  _resetState();
});

afterEach(async () => {
  stopKeepWarm();
  await stopRag();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const warmUps = () => calls.embed.filter((b) => b.input?.[0] === 'search_query: warm-up');

async function quiet(fn) {
  const orig = { warn: console.warn, log: console.log };
  const lines = [];
  console.warn = (...a) => { lines.push(a.join(' ')); };
  console.log = () => {};
  try { await fn(); } finally { Object.assign(console, orig); }
  return lines;
}

test('a cold embedding model behind an index loaded from disk recovers after one failed query', async () => {
  writeNote(vault, 'drache.md', DRAGON);
  model.loaded = true; // build the index while the model is up
  await startRag(FAST);
  await _activeIndexer().whenSynced();
  await stopRag();
  _resetState();

  model.loaded = false; // server restart / keep_alive expired
  calls.embed.length = 0;
  await startRag(FAST);
  await _activeIndexer().whenSynced();
  assert.equal(calls.embed.length, 0, 'index from disk: nothing embedded, nothing loads the model');

  process.env.RAG_TIMEOUT_MS = '100';
  await quiet(async () => {
    assert.deepEqual(await queryRag('Drache Hort'), [], 'first query: cold model, deadline → fallback');
    await waitFor(() => model.loaded, 3000, 'background warm-up loads the model');
  });
  assert.ok(model.aborted >= 1, 'the query embed was aborted mid-load, as in the live log');
  assert.equal(warmUps().length, 1);
  const hits = await queryRag('Drache Hort');
  assert.ok(hits.length >= 1, 'next query finds the model ready');
  assert.equal(hits[0].source, 'drache.md');
});

test('warmRag loads the model without the query deadline (server start / voice join)', async () => {
  model.loadMs = 1200; // longer than RAG_TIMEOUT_MS by far
  assert.equal(await warmRag('server start'), true);
  assert.equal(model.loads, 1);
  assert.equal(model.aborted, 0);
  assert.equal(warmUps().length, 1);
  assert.equal(calls.embed[0].keep_alive, '30m', 'resets EMBED_KEEP_ALIVE like a query');
});

test('warmRag: single-flight; no-op without RAG or for EMBED_PROVIDER=openai', async () => {
  const [a, b] = [warmRag('a'), warmRag('b')];
  assert.equal(a, b, 'concurrent callers share one warm-up');
  assert.equal(await a, true);
  assert.equal(calls.embed.length, 1);

  process.env.RAG_ENABLED = 'false';
  assert.equal(await warmRag('off'), false);
  delete process.env.RAG_ENABLED;
  process.env.OBSIDIAN_VAULT_PATH = '';
  assert.equal(await warmRag('no vault'), false);
  process.env.OBSIDIAN_VAULT_PATH = vault;
  process.env.EMBED_PROVIDER = 'openai';
  assert.equal(await warmRag('openai'), false);
  assert.equal(calls.embed.length, 1, 'no further requests');
});

test('warmRag never throws; a missing model is warned about once', async () => {
  model.status = 404;
  const warns = await quiet(async () => {
    assert.equal(await warmRag('x'), false);
    assert.equal(await warmRag('y'), false);
  });
  assert.equal(warns.filter((l) => l.includes('embedding warm-up failed')).length, 1, warns.join(' | '));
  model.status = 200;
  assert.equal(await warmRag('z'), true);
});

test('keep-warm on voice join warms the LLM (think:false) and the embedding model', async () => {
  process.env.OLLAMA_MODEL = 'gemma4:12b';
  process.env.OLLAMA_KEEP_WARM_INTERVAL_MS = '0'; // no pings: only the join itself
  model.loadMs = 0;
  await quiet(async () => {
    startKeepWarm();
    await waitFor(() => warmUps().length >= 1 && calls.chat.length >= 1, 3000, 'join warm-up');
  });
  assert.deepEqual(calls.chat[0].messages, []);
  assert.equal(calls.chat[0].model, 'gemma4:12b');
  assert.equal(calls.chat[0].think, false);
});

test('each keep-warm ping warms both models again', async () => {
  process.env.OLLAMA_KEEP_WARM_INTERVAL_MS = '60';
  model.loadMs = 0;
  await quiet(async () => {
    startKeepWarm();
    await waitFor(() => warmUps().length >= 3 && calls.chat.length >= 3, 3000, 'join + two pings');
  });
  stopKeepWarm();
});

test('keep-warm without RAG only warms the LLM', async () => {
  process.env.RAG_ENABLED = 'false';
  process.env.OLLAMA_KEEP_WARM_INTERVAL_MS = '0';
  await quiet(async () => {
    startKeepWarm();
    await waitFor(() => calls.chat.length >= 1, 3000, 'LLM warm-up');
  });
  assert.equal(calls.embed.length, 0);
});
