import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { queryRag, ragEnabled } from '../src/ragClient.js';

let savedEnv;

beforeEach(() => {
  savedEnv = { RAG_URL: process.env.RAG_URL, RAG_TIMEOUT_MS: process.env.RAG_TIMEOUT_MS };
  delete process.env.RAG_URL;
  delete process.env.RAG_TIMEOUT_MS;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// Start a one-off HTTP server that replies with `handler(reqBody)`.
function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(JSON.parse(body || '{}'), res));
    });
    server.listen(0, '127.0.0.1', async () => {
      process.env.RAG_URL = `http://127.0.0.1:${server.address().port}`;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally { server.close(); }
    });
  });
}

test('returns "" and is disabled when RAG_URL is unset', async () => {
  assert.equal(ragEnabled(), false);
  assert.equal(await queryRag('wer ist Baron Kelthur?'), '');
});

test('returns "" for an empty query', async () => {
  process.env.RAG_URL = 'http://127.0.0.1:1';
  assert.equal(await queryRag('   '), '');
});

test('formats chunks with their source', async () => {
  await withServer((body, res) => {
    assert.equal(body.query, 'Greyhawk');
    assert.equal(body.top_k, 3);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { text: 'Baron Kelthur herrscht.', source: 'npcs/kelthur.md' },
      { text: '', source: 'leer.md' }, // dropped (blank)
      { text: 'Greyhawk liegt im Norden.', source: 'orte.md' },
    ]));
  }, async () => {
    const out = await queryRag('Greyhawk');
    assert.ok(out.includes('[Quelle: npcs/kelthur.md]'));
    assert.ok(out.includes('Baron Kelthur herrscht.'));
    assert.ok(out.includes('Greyhawk liegt im Norden.'));
    assert.ok(!out.includes('leer.md'));
  });
});

test('degrades to "" on HTTP error', async () => {
  await withServer((_body, res) => {
    res.writeHead(500);
    res.end('boom');
  }, async () => {
    assert.equal(await queryRag('x'), '');
  });
});

test('degrades to "" on timeout', async () => {
  process.env.RAG_TIMEOUT_MS = '50';
  await withServer((_body, res) => {
    // Never respond within the timeout window.
    setTimeout(() => { res.writeHead(200); res.end('[]'); }, 500);
  }, async () => {
    const t0 = Date.now();
    assert.equal(await queryRag('x'), '');
    assert.ok(Date.now() - t0 < 400, 'aborted well before the slow response');
  });
});
