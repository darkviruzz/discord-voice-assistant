import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getCampaignContext, _resetCache } from '../src/campaignContext.js';
import { startRag, stopRag, _activeIndexer, _resetState as _resetRagState } from '../src/rag/index.js';
import { writeNote, startFakeOllama } from '../test-support/rag.js';

let tmpDir;
let savedEnv;

const ENV_KEYS = [
  'LIVE_CONTEXT_ENABLED', 'CAMPAIGN_CONTEXT_FILE', 'CAMPAIGN_CONTEXT_MAX_CHARS', 'OBSIDIAN_VAULT_PATH',
  'RAG_ENABLED', 'RAG_TIMEOUT_MS', 'RAG_SCORE_THRESHOLD', 'RAG_INDEX_DIR', 'OLLAMA_URL',
  'EMBED_PROVIDER', 'EMBED_MODEL', 'EMBED_QUERY_PREFIX', 'EMBED_DOC_PREFIX',
];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-'));
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) if (k !== 'CAMPAIGN_CONTEXT_FILE') delete process.env[k];
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

// Real in-process RAG over a tmp vault (`notes`: { relPath: text }), with a
// fake Ollama answering /api/embed with deterministic vectors. `queries()`
// lists the query texts that reached the embedding backend.
async function withRag(notes, fn) {
  const vault = path.join(tmpDir, 'vault');
  fs.mkdirSync(vault, { recursive: true });
  for (const [rel, text] of Object.entries(notes)) writeNote(vault, rel, text);
  const ollama = await startFakeOllama();
  process.env.OLLAMA_URL = ollama.url;
  process.env.OBSIDIAN_VAULT_PATH = vault;
  process.env.RAG_INDEX_DIR = path.join(tmpDir, 'rag-index');
  const queries = () => ollama.calls.embed
    .flatMap((c) => c.input)
    .filter((t) => t.startsWith('search_query: '))
    .map((t) => t.slice('search_query: '.length));
  try {
    await startRag({ watch: false, saveDelayMs: 10 });
    await _activeIndexer().whenSynced();
    return await fn({ ollama, queries });
  } finally {
    await stopRag();
    _resetRagState();
    await ollama.close();
  }
}

test('RAG enabled: vault hits replace the static file for a query', async () => {
  writeContext('Statischer Kontext.');
  await withRag({ 'npcs/kelthur.md': 'Baron Kelthur herrscht.' }, async ({ queries }) => {
    const out = await getCampaignContext('wer ist Baron Kelthur?');
    assert.equal(out, '[Quelle: npcs/kelthur.md]\nBaron Kelthur herrscht.');
    assert.deepEqual(queries(), ['wer ist Baron Kelthur?']);
  });
});

test('RAG enabled but no query → static file, no RAG request', async () => {
  writeContext('Statischer Kontext.');
  await withRag({ 'x.md': 'egal' }, async ({ queries }) => {
    assert.equal(await getCampaignContext(), 'Statischer Kontext.');
    assert.equal(await getCampaignContext('   '), 'Statischer Kontext.');
    assert.equal(queries().length, 0);
  });
});

test('RAG_ENABLED=false → static file, no RAG request', async () => {
  writeContext('Statischer Kontext.');
  await withRag({ 'x.md': 'Baron Kelthur herrscht.' }, async ({ queries }) => {
    process.env.RAG_ENABLED = 'false';
    assert.equal(await getCampaignContext('Baron Kelthur'), 'Statischer Kontext.');
    assert.equal(queries().length, 0);
  });
});

test('RAG finds nothing (empty vault / score filter) → falls back to the static file', async () => {
  writeContext('Statischer Kontext.');
  await withRag({}, async () => {
    assert.equal(await getCampaignContext('was ist los?'), 'Statischer Kontext.');
  });
  await withRag({ 'x.md': 'Baron Kelthur herrscht.' }, async () => {
    process.env.RAG_SCORE_THRESHOLD = '0.05';
    assert.equal(await getCampaignContext('Drachen im Feuerberg'), 'Statischer Kontext.');
  });
});

test('embedding backend HTTP error → falls back to the static file', async () => {
  writeContext('Statischer Kontext.');
  await withRag({ 'x.md': 'Baron Kelthur herrscht.' }, async ({ ollama }) => {
    ollama.opts.queryStatus = 500;
    assert.equal(await getCampaignContext('Baron Kelthur'), 'Statischer Kontext.');
  });
});

test('embedding backend down → falls back to the static file', async () => {
  writeContext('Statischer Kontext.');
  await withRag({ 'x.md': 'Baron Kelthur herrscht.' }, async () => {
    process.env.OLLAMA_URL = 'http://127.0.0.1:1';
    assert.equal(await getCampaignContext('Baron Kelthur'), 'Statischer Kontext.');
  });
});

test('index not built yet → falls back to the static file', async () => {
  writeContext('Statischer Kontext.');
  const vault = path.join(tmpDir, 'vault');
  writeNote(vault, 'x.md', 'Baron Kelthur herrscht.');
  process.env.OBSIDIAN_VAULT_PATH = vault;
  process.env.RAG_INDEX_DIR = path.join(tmpDir, 'rag-index');
  process.env.OLLAMA_URL = 'http://127.0.0.1:1'; // nothing can be embedded
  try {
    await startRag({ watch: false, retryBaseMs: 60_000 });
    assert.equal(await getCampaignContext('Baron Kelthur'), 'Statischer Kontext.');
  } finally {
    await stopRag();
    _resetRagState();
  }
});

test('slow RAG: the wake-word path waits at most RAG_TIMEOUT_MS, then uses the file', async () => {
  writeContext('Statischer Kontext.');
  await withRag({ 'x.md': 'zu spät' }, async ({ ollama }) => {
    process.env.RAG_TIMEOUT_MS = '100';
    ollama.opts.queryDelayMs = 2000;
    const t0 = Date.now();
    assert.equal(await getCampaignContext('was ist los?'), 'Statischer Kontext.');
    const took = Date.now() - t0;
    assert.ok(took < 1000, `bounded by RAG_TIMEOUT_MS (took ${took} ms)`);
  });
});

test('RAG hits are capped at CAMPAIGN_CONTEXT_MAX_CHARS like the file', async () => {
  process.env.CAMPAIGN_CONTEXT_MAX_CHARS = '300';
  const huge = 'Baron Kelthur herrscht mit eiserner Faust. '.repeat(400); // a note without `##`
  await withRag({ 'a.md': 'Kelthur.', 'b.md': huge }, async () => {
    const out = await getCampaignContext('Kelthur');
    assert.ok(out.length <= 300, `capped (got ${out.length} chars)`);
    assert.ok(out.startsWith('[Quelle: a.md]\nKelthur.'), 'keeps the best hit first');
  });
});

test('LIVE_CONTEXT_ENABLED=false → no RAG request either', async () => {
  await withRag({ 'x.md': 'egal' }, async ({ queries }) => {
    process.env.LIVE_CONTEXT_ENABLED = 'false';
    assert.equal(await getCampaignContext('was ist los?'), '');
    assert.equal(queries().length, 0);
  });
});
