import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { complete, warmUp, llmConfig, defaultModel } from '../src/providers/llm.js';
import { embed, embedSignature, embedPrefixes } from '../src/providers/embed.js';

// One fake inference server speaking both dialects (Ollama native + OpenAI).
const seen = [];
let reply = null; // (req, body) => [status, json]
const srv = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ url: req.url, auth: req.headers.authorization ?? null, body });
    const [status, json, delayMs = 0] = reply(req, body);
    setTimeout(() => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); }, delayMs);
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const KEYS = ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'OLLAMA_URL', 'OLLAMA_MODEL', 'OLLAMA_KEEP_ALIVE',
  'EMBED_PROVIDER', 'EMBED_BASE_URL', 'EMBED_MODEL', 'EMBED_API_KEY', 'EMBED_QUERY_PREFIX', 'EMBED_DOC_PREFIX', 'EMBED_KEEP_ALIVE'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
beforeEach(() => { for (const k of KEYS) delete process.env[k]; seen.length = 0; });

test('ollama (default): native /api/chat with keep_alive and options', async () => {
  process.env.OLLAMA_URL = `${BASE}/`;
  process.env.OLLAMA_MODEL = 'qwen3:14b';
  reply = () => [200, { model: 'qwen3:14b', message: { content: '  hallo  ' } }];
  const r = await complete({ messages: [{ role: 'user', content: 'x' }], temperature: 0.3, maxTokens: 50 });
  assert.deepEqual(r, { content: 'hallo', model: 'qwen3:14b' });
  assert.equal(seen[0].url, '/api/chat');
  assert.equal(seen[0].body.model, 'qwen3:14b');
  assert.equal(seen[0].body.keep_alive, '30m');
  assert.equal(seen[0].body.stream, false);
  assert.deepEqual(seen[0].body.options, { temperature: 0.3, num_predict: 50 });
  assert.equal(llmConfig().provider, 'ollama');
});

test('openai: /chat/completions on LLM_BASE_URL with bearer, model override wins', async () => {
  process.env.LLM_PROVIDER = 'OpenAI';
  process.env.LLM_BASE_URL = ` ${BASE}/v1/ `;
  process.env.LLM_MODEL = 'mistral-small';
  process.env.LLM_API_KEY = 'sk-test';
  reply = () => [200, { model: 'x', choices: [{ message: { content: 'antwort' } }] }];
  assert.equal(defaultModel(), 'mistral-small');
  const r = await complete({ messages: [{ role: 'user', content: 'q' }], model: 'summary-model', maxTokens: 10 });
  assert.equal(r.content, 'antwort');
  assert.equal(seen[0].url, '/v1/chat/completions');
  assert.equal(seen[0].auth, 'Bearer sk-test');
  assert.equal(seen[0].body.model, 'summary-model');
  assert.equal(seen[0].body.max_tokens, 10);
  assert.equal(seen[0].body.keep_alive, undefined);
});

test('openai: missing base URL and malformed replies fail loudly', async () => {
  process.env.LLM_PROVIDER = 'openai';
  await assert.rejects(() => complete({ messages: [] }), /LLM_BASE_URL is empty/);
  process.env.LLM_BASE_URL = BASE;
  reply = () => [200, { choices: [] }];
  await assert.rejects(() => complete({ messages: [] }), /no choices\[0\]\.message\.content/);
  reply = () => [503, { error: 'loading' }];
  await assert.rejects(() => complete({ messages: [] }), /llm: HTTP 503/);
});

test('timeout covers a slow server and is reported as such', async () => {
  process.env.OLLAMA_URL = BASE;
  reply = () => [200, { message: { content: 'late' } }, 300];
  await assert.rejects(() => complete({ messages: [], timeoutMs: 50 }), /llm: timeout after 50 ms/);
});

test('caller cancel is re-thrown as AbortError, not wrapped as failure', async () => {
  process.env.OLLAMA_URL = BASE;
  reply = () => [200, { message: { content: 'late' } }, 300];
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(() => complete({ messages: [], signal: ctrl.signal, timeoutMs: 5000 }), (e) => e.name === 'AbortError');
});

test('warmUp: ollama preloads, openai is a no-op, failures never throw', async () => {
  process.env.OLLAMA_URL = BASE;
  reply = () => [200, { message: { content: '' } }];
  assert.equal(await warmUp(), true);
  assert.deepEqual(seen[0].body.messages, []);
  process.env.LLM_PROVIDER = 'openai';
  seen.length = 0;
  assert.equal(await warmUp(), true);
  assert.equal(seen.length, 0);
  delete process.env.LLM_PROVIDER;
  process.env.OLLAMA_URL = 'http://127.0.0.1:1';
  assert.equal(await warmUp(), false);
});

test('embed (ollama): /api/embed, nomic prefixes per kind, keep_alive', async () => {
  process.env.OLLAMA_URL = BASE;
  reply = (_req, body) => [200, { embeddings: body.input.map((_, i) => [i, 1]) }];
  const v = await embed(['a', 'b'], { kind: 'document' });
  assert.deepEqual(v, [[0, 1], [1, 1]]);
  assert.equal(seen[0].url, '/api/embed');
  assert.deepEqual(seen[0].body.input, ['search_document: a', 'search_document: b']);
  assert.equal(seen[0].body.model, 'nomic-embed-text');
  assert.equal(seen[0].body.keep_alive, '30m');
  await embed('frage', { kind: 'query' });
  assert.deepEqual(seen[1].body.input, ['search_query: frage']);
});

test('embed (openai): /embeddings, results re-ordered by index, no prefixes for other models', async () => {
  process.env.EMBED_PROVIDER = 'openai';
  process.env.EMBED_BASE_URL = `${BASE}/v1`;
  process.env.EMBED_MODEL = 'bge-m3';
  reply = () => [200, { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }];
  assert.deepEqual(await embed(['x', 'y']), [[1], [2]]);
  assert.equal(seen[0].url, '/v1/embeddings');
  assert.deepEqual(seen[0].body.input, ['x', 'y']);
  assert.deepEqual(embedPrefixes(), { query: '', doc: '' });
});

test('embed: count mismatch / empty vectors are errors; empty input is free', async () => {
  process.env.OLLAMA_URL = BASE;
  reply = () => [200, { embeddings: [[1]] }];
  await assert.rejects(() => embed(['a', 'b']), /expected 2 vector/);
  reply = () => [200, { embeddings: [[]] }];
  await assert.rejects(() => embed(['a']), /expected 1 vector/);
  seen.length = 0;
  assert.deepEqual(await embed([]), []);
  assert.equal(seen.length, 0);
});

test('embedSignature changes with model and prefixes (index must rebuild)', () => {
  const a = embedSignature();
  process.env.EMBED_MODEL = 'other';
  const b = embedSignature();
  process.env.EMBED_QUERY_PREFIX = 'q: ';
  const c = embedSignature();
  assert.notEqual(a, b);
  assert.notEqual(b, c);
});

test('embed prefixes: unset/empty → model default, whitespace only → off, else verbatim', () => {
  assert.deepEqual(embedPrefixes(), { query: 'search_query: ', doc: 'search_document: ' });
  // '' is what an empty .env line, a compose `${EMBED_QUERY_PREFIX:-}` or a
  // cleared settings field produces — it must not disable the nomic prefixes.
  process.env.EMBED_QUERY_PREFIX = '';
  process.env.EMBED_DOC_PREFIX = ' ';
  assert.deepEqual(embedPrefixes(), { query: 'search_query: ', doc: '' });
  process.env.EMBED_QUERY_PREFIX = 'query: ';
  assert.equal(embedPrefixes().query, 'query: ');
});
