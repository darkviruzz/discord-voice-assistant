// Shared fixtures for the vault-RAG tests (test/rag*.test.js and the
// campaignContext/control tests that go through the real
// in-process RAG). Deliberately NOT under test/: `node --test` runs every .js
// file below a `test` directory as a test file of its own.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const DIM = 64;

// Deterministic bag-of-words embedding (the scheme of the former pytest
// suite): every word adds 1 to dimension md5(word) % DIM, so texts sharing
// words are close (distance ~0 for the same words) and texts with disjoint
// words are ~1 apart — meaningful cosine distances without any model server.
// A tiny constant keeps it from ever being the zero vector.
export function fakeVector(text, dim = DIM) {
  const vec = new Array(dim).fill(0);
  for (const word of String(text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    const h = BigInt(`0x${crypto.createHash('md5').update(word, 'utf8').digest('hex')}`);
    vec[Number(h % BigInt(dim))] += 1;
  }
  vec[0] += 1e-3;
  return vec;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});

// Injectable stand-in for providers/embed.js#embed: counts calls and texts,
// can fail or stall per kind. Set `.fail = true` to simulate a down backend.
export function makeFakeEmbed() {
  const fn = async (texts, { kind = 'document', signal } = {}) => {
    fn.calls++;
    fn.kinds.push(kind);
    fn.texts.push(...texts);
    const delay = kind === 'query' ? fn.queryDelayMs : fn.docDelayMs;
    if (delay) await sleep(delay, signal);
    if (typeof fn.hook === 'function') await fn.hook(texts, kind);
    if (fn.fail) throw new Error('embedding backend down (test)');
    return texts.map((t) => fakeVector(t, fn.dim));
  };
  fn.calls = 0;
  fn.kinds = [];
  fn.texts = [];
  fn.fail = false;
  fn.docDelayMs = 0;
  fn.queryDelayMs = 0;
  fn.dim = DIM;
  fn.hook = null;
  return fn;
}

export const SILENT_LOGGER = { log() {}, warn() {}, debug() {} };

export function makeTmpDir(prefix = 'rag-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeNote(vault, rel, text, encoding = 'utf8') {
  const full = path.join(vault, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.from(text, encoding));
  return full;
}

export async function waitFor(pred, ms = 5000, what = 'condition') {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// In-process stand-in for Ollama: POST /api/embed answers with fakeVector()
// of every input (prefix included, as the real model would see it), POST
// /api/chat with `chat(body)` (default 'ok'). `opts` is mutable per test:
//   embedStatus      HTTP status for /api/embed (200)
//   queryStatus      HTTP status for query embeddings only (inputs starting
//                    with "search_query: ")
//   queryDelayMs     stall query embeddings (hot-path timeout tests)
//   docDelayMs       stall document embeddings
export async function startFakeOllama({ chat } = {}) {
  const calls = { embed: [], chat: [] };
  const opts = { embedStatus: 200, queryStatus: 200, queryDelayMs: 0, docDelayMs: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch { /* keep {} */ }
      const reply = (status, payload) => {
        if (res.destroyed) return;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/api/embed') {
        calls.embed.push(json);
        const input = Array.isArray(json.input) ? json.input : [json.input];
        const isQuery = input.some((t) => String(t).startsWith('search_query: '));
        const status = isQuery && opts.queryStatus !== 200 ? opts.queryStatus : opts.embedStatus;
        setTimeout(() => {
          if (status !== 200) reply(status, { error: 'model "nomic-embed-text" not found (test)' });
          else reply(200, { model: json.model, embeddings: input.map((t) => fakeVector(t)) });
        }, isQuery ? opts.queryDelayMs : opts.docDelayMs);
      } else if (req.url === '/api/chat') {
        calls.chat.push(json);
        reply(200, { message: { content: chat ? chat(json) : 'ok' } });
      } else {
        reply(404, { error: 'not found' });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    opts,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}
