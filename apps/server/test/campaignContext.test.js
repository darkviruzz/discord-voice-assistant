import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'node:http';
import { getCampaignContext, _resetCache } from '../src/campaignContext.js';

let tmpDir;
let savedEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-'));
  savedEnv = {
    LIVE_CONTEXT_ENABLED: process.env.LIVE_CONTEXT_ENABLED,
    CAMPAIGN_CONTEXT_FILE: process.env.CAMPAIGN_CONTEXT_FILE,
    CAMPAIGN_CONTEXT_MAX_CHARS: process.env.CAMPAIGN_CONTEXT_MAX_CHARS,
    OBSIDIAN_VAULT_PATH: process.env.OBSIDIAN_VAULT_PATH,
    RAG_URL: process.env.RAG_URL,
    RAG_TIMEOUT_MS: process.env.RAG_TIMEOUT_MS,
  };
  delete process.env.LIVE_CONTEXT_ENABLED;
  delete process.env.CAMPAIGN_CONTEXT_MAX_CHARS;
  delete process.env.OBSIDIAN_VAULT_PATH;
  delete process.env.RAG_URL;
  delete process.env.RAG_TIMEOUT_MS;
  _resetCache();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  _resetCache();
});

function writeContext(content) {
  const fp = path.join(tmpDir, 'CAMPAIGN.md');
  fs.writeFileSync(fp, content, 'utf8');
  process.env.CAMPAIGN_CONTEXT_FILE = fp; // absolute → no vault root needed
  return fp;
}

test('returns file content when present', async () => {
  writeContext('Baron Kelthur herrscht über Greyhawk.');
  assert.equal(await getCampaignContext(), 'Baron Kelthur herrscht über Greyhawk.');
});

test('returns empty string when file is missing', async () => {
  process.env.CAMPAIGN_CONTEXT_FILE = path.join(tmpDir, 'does-not-exist.md');
  assert.equal(await getCampaignContext(), '');
});

test('returns empty string when disabled', async () => {
  writeContext('egal');
  process.env.LIVE_CONTEXT_ENABLED = 'false';
  assert.equal(await getCampaignContext(), '');
});

test('relative file with no vault root → disabled (empty)', async () => {
  process.env.CAMPAIGN_CONTEXT_FILE = 'CAMPAIGN.md';
  delete process.env.OBSIDIAN_VAULT_PATH;
  assert.equal(await getCampaignContext(), '');
});

test('resolves relative file against OBSIDIAN_VAULT_PATH', async () => {
  fs.writeFileSync(path.join(tmpDir, 'CAMPAIGN.md'), 'Aus dem Vault.', 'utf8');
  process.env.OBSIDIAN_VAULT_PATH = tmpDir;
  process.env.CAMPAIGN_CONTEXT_FILE = 'CAMPAIGN.md';
  assert.equal(await getCampaignContext(), 'Aus dem Vault.');
});

test('truncates to CAMPAIGN_CONTEXT_MAX_CHARS, keeping the front', async () => {
  const long = 'A'.repeat(100) + '\n' + 'B'.repeat(100);
  writeContext(long);
  process.env.CAMPAIGN_CONTEXT_MAX_CHARS = '50';
  const out = await getCampaignContext();
  assert.ok(out.length <= 50);
  assert.ok(out.startsWith('A'), 'keeps the front of the file');
});

test('caches across calls and refreshes on mtime change', async () => {
  const fp = writeContext('Version eins.');
  assert.equal(await getCampaignContext(), 'Version eins.');
  // Rewrite with a bumped mtime so the cache invalidates.
  fs.writeFileSync(fp, 'Version zwei.', 'utf8');
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(fp, future, future);
  assert.equal(await getCampaignContext(), 'Version zwei.');
});

// ── RAG path ────────────────────────────────────────────────────────────────

// In-process stand-in for the RAG service: answers POST /query with `hits`
// after `delayMs`, recording each request body.
function withRag({ hits = [], status = 200, delayMs = 0 } = {}, fn) {
  const reqs = [];
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        reqs.push(JSON.parse(body || '{}'));
        setTimeout(() => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(hits));
        }, delayMs);
      });
    });
    server.listen(0, '127.0.0.1', async () => {
      process.env.RAG_URL = `http://127.0.0.1:${server.address().port}`;
      try { resolve(await fn(reqs)); }
      catch (e) { reject(e); }
      finally { server.closeAllConnections(); server.close(); }
    });
  });
}

test('RAG configured: vault hits replace the static file for a query', async () => {
  writeContext('Statischer Kontext.');
  await withRag({ hits: [{ text: 'Baron Kelthur herrscht.', source: 'npcs/kelthur.md' }] }, async (reqs) => {
    const out = await getCampaignContext('wer ist Baron Kelthur?');
    assert.equal(out, '[Quelle: npcs/kelthur.md]\nBaron Kelthur herrscht.');
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].query, 'wer ist Baron Kelthur?');
  });
});

test('RAG configured but no query → static file, no RAG request', async () => {
  writeContext('Statischer Kontext.');
  await withRag({ hits: [{ text: 'egal', source: 'x.md' }] }, async (reqs) => {
    assert.equal(await getCampaignContext(), 'Statischer Kontext.');
    assert.equal(await getCampaignContext('   '), 'Statischer Kontext.');
    assert.equal(reqs.length, 0);
  });
});

test('RAG returns no hits → falls back to the static file', async () => {
  writeContext('Statischer Kontext.');
  await withRag({ hits: [] }, async () => {
    assert.equal(await getCampaignContext('was ist los?'), 'Statischer Kontext.');
  });
});

test('RAG HTTP error → falls back to the static file', async () => {
  writeContext('Statischer Kontext.');
  await withRag({ status: 500, hits: { detail: 'boom' } }, async () => {
    assert.equal(await getCampaignContext('was ist los?'), 'Statischer Kontext.');
  });
});

test('RAG down → falls back to the static file', async () => {
  writeContext('Statischer Kontext.');
  process.env.RAG_URL = 'http://127.0.0.1:1';
  assert.equal(await getCampaignContext('was ist los?'), 'Statischer Kontext.');
});

test('slow RAG: the wake-word path waits at most RAG_TIMEOUT_MS, then uses the file', async () => {
  writeContext('Statischer Kontext.');
  process.env.RAG_TIMEOUT_MS = '100';
  await withRag({ hits: [{ text: 'zu spät', source: 'x.md' }], delayMs: 2000 }, async () => {
    const t0 = Date.now();
    assert.equal(await getCampaignContext('was ist los?'), 'Statischer Kontext.');
    const took = Date.now() - t0;
    assert.ok(took < 1000, `bounded by RAG_TIMEOUT_MS (took ${took} ms)`);
  });
});

test('RAG hits are capped at CAMPAIGN_CONTEXT_MAX_CHARS like the file', async () => {
  process.env.CAMPAIGN_CONTEXT_MAX_CHARS = '300';
  const huge = 'Baron Kelthur herrscht mit eiserner Faust. '.repeat(400); // a note without `##`
  await withRag({
    hits: [
      { text: 'Kurz und relevant.', source: 'a.md' },
      { text: huge, source: 'b.md' },
    ],
  }, async () => {
    const out = await getCampaignContext('Kelthur');
    assert.ok(out.length <= 300, `capped (got ${out.length} chars)`);
    assert.ok(out.startsWith('[Quelle: a.md]\nKurz und relevant.'), 'keeps the best hit first');
  });
});

test('LIVE_CONTEXT_ENABLED=false → no RAG request either', async () => {
  process.env.LIVE_CONTEXT_ENABLED = 'false';
  await withRag({ hits: [{ text: 'egal', source: 'x.md' }] }, async (reqs) => {
    assert.equal(await getCampaignContext('was ist los?'), '');
    assert.equal(reqs.length, 0);
  });
});
