// Settings-catalog contract for the RAG + embedding variables: every RAG_* /
// EMBED_* the server reads is a catalog entry, documented in .env.example /
// docker-compose with the same default the code falls back to, and the panel
// can store an optional number as "empty" (= feature off) instead of 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG, catalogEntry, isSecretEntry } from '../src/configCatalog.js';
import { coerce } from '../src/configStore.js';
import { ragConfig } from '../src/rag/index.js';
import { embedPrefixes } from '../src/providers/embed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const repoDir = path.resolve(serverDir, '../..');
const RAG_GROUP = 'Server · RAG (Vault-Suche)';

// Keys are read as process.env.KEY or through the small env helpers
// (envStr('KEY'), env('KEY', 'fallback'), …) — both forms are collected.
const KEY_RE = /process\.env\.((?:RAG|EMBED)_[A-Z0-9_]+)|\b(?:env|envStr|envPositiveInt)\(\s*'((?:RAG|EMBED)_[A-Z0-9_]+)'/g;

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) { if (name !== 'public') walk(p); continue; }
      if (p.endsWith('.js') && name !== 'configCatalog.js') out.push(p);
    }
  };
  walk(path.join(serverDir, 'src'));
  return out;
}

function ragKeysUsedInServerCode() {
  const keys = new Set();
  for (const p of sourceFiles()) {
    for (const m of fs.readFileSync(p, 'utf8').matchAll(KEY_RE)) keys.add(m[1] ?? m[2]);
  }
  return [...keys].sort();
}

function withEnvCleared(fn) {
  const keys = [...CATALOG.filter((x) => /^(RAG|EMBED)_/.test(x.key)).map((x) => x.key), 'DATA_DIR', 'OBSIDIAN_VAULT_PATH'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test('every RAG_* / EMBED_* read by the server is a server-scope catalog entry in the RAG group', () => {
  const used = ragKeysUsedInServerCode();
  for (const k of ['RAG_ENABLED', 'RAG_INDEX_DIR', 'RAG_TIMEOUT_MS', 'RAG_SCORE_THRESHOLD', 'RAG_MAX_CHUNK_CHARS',
    'RAG_RESCAN_INTERVAL_MS', 'EMBED_PROVIDER', 'EMBED_MODEL', 'EMBED_API_KEY',
    'EMBED_BASE_URL', 'EMBED_KEEP_ALIVE', 'EMBED_QUERY_PREFIX', 'EMBED_DOC_PREFIX']) {
    assert.ok(used.includes(k), `scan should find ${k} (found ${used.join(', ')})`);
  }
  for (const key of used) {
    const e = catalogEntry('server', key);
    assert.ok(e, `${key} missing from configCatalog.js`);
    assert.equal(e.group, RAG_GROUP, `${key} group`);
    assert.ok(e.label && e.desc && e.type && e.applyMode, `${key} incomplete catalog entry`);
  }
});

test('the removed Python service left no trace in the catalog', () => {
  assert.equal(catalogEntry('server', 'RAG_URL'), undefined);
  for (const e of CATALOG) assert.ok(!/apps\/rag|RAG_URL|Python-RAG/.test(e.desc), `${e.key} desc mentions the old service`);
});

test('EMBED_API_KEY is a secret; EMBED_PROVIDER is an enum', () => {
  assert.equal(isSecretEntry(catalogEntry('server', 'EMBED_API_KEY')), true);
  assert.throws(() => coerce('server', 'EMBED_API_KEY', 'sk-x'), /Secret/);
  assert.equal(coerce('server', 'EMBED_PROVIDER', 'openai'), 'openai');
  assert.throws(() => coerce('server', 'EMBED_PROVIDER', 'chroma'), /ollama, openai/);
});

test('RAG/EMBED catalog defaults == code fallbacks', () => withEnvCleared(() => {
  const def = (k) => catalogEntry('server', k).def;
  process.env.OBSIDIAN_VAULT_PATH = '/vault';
  const rag = ragConfig();
  assert.equal(String(rag.enabled), def('RAG_ENABLED'));
  assert.equal(String(rag.timeoutMs), def('RAG_TIMEOUT_MS'));
  assert.equal(rag.scoreThreshold, def('RAG_SCORE_THRESHOLD') === '' ? null : Number(def('RAG_SCORE_THRESHOLD')));
  assert.equal(String(rag.maxChunkChars), def('RAG_MAX_CHUNK_CHARS'));
  assert.equal(String(rag.rescanIntervalMs), def('RAG_RESCAN_INTERVAL_MS'));
  assert.equal(rag.indexDir, path.resolve(def('RAG_INDEX_DIR')));
  assert.equal(rag.provider, def('EMBED_PROVIDER'));
  assert.equal(rag.model, def('EMBED_MODEL'));
  // Empty prefix settings (the catalog default) mean "automatic", not "off".
  process.env.EMBED_QUERY_PREFIX = def('EMBED_QUERY_PREFIX');
  process.env.EMBED_DOC_PREFIX = def('EMBED_DOC_PREFIX');
  assert.deepEqual(embedPrefixes(), { query: 'search_query: ', doc: 'search_document: ' });
}));

test('env(\'EMBED_*\', fallback) defaults in providers/embed.js == catalog defaults', () => {
  const src = fs.readFileSync(path.join(serverDir, 'src/providers/embed.js'), 'utf8');
  const found = [...src.matchAll(/\benv\('(EMBED_[A-Z_]+)'(?:,\s*'([^']*)')?\)/g)];
  assert.ok(found.length >= 4);
  for (const [, key, fallback = ''] of found) {
    assert.equal(fallback, catalogEntry('server', key).def, `${key} fallback`);
  }
});

test('RAG/EMBED vars are documented in apps/server/.env.example with the catalog default', () => {
  const example = fs.readFileSync(path.join(serverDir, '.env.example'), 'utf8');
  assert.ok(!/^#?\s*RAG_URL=/m.test(example), 'RAG_URL is gone');
  for (const key of ragKeysUsedInServerCode()) {
    const m = example.match(new RegExp(`^(#\\s*)?${key}=(.*)$`, 'm'));
    assert.ok(m, `${key} missing from apps/server/.env.example`);
    // Commented-out examples (RAG_SCORE_THRESHOLD, EMBED_BASE_URL, …) show a
    // sample value; active lines must equal the catalog default.
    if (!m[1]) assert.equal(m[2].trim(), catalogEntry('server', key).def, `${key} default in .env.example`);
  }
});

test('RAG/EMBED vars are passed through to the server container with the catalog default', () => {
  const compose = fs.readFileSync(path.join(repoDir, 'deploy/docker-compose.yml'), 'utf8');
  assert.ok(!/^\s+rag:\s*$/m.test(compose), 'no separate rag service any more');
  assert.ok(!/rag-chroma|va-rag|RAG_URL|apps\/rag/.test(compose), 'no leftovers of the Python service');
  const serverBlock = compose.slice(compose.indexOf('\n  server:'), compose.indexOf('\nnetworks:'));
  // Container-specific fixed values instead of `${KEY:-default}`.
  const FIXED = { RAG_INDEX_DIR: '/data/rag' };
  for (const key of ragKeysUsedInServerCode()) {
    if (FIXED[key]) {
      assert.match(serverBlock, new RegExp(`^\\s+${key}: ${FIXED[key]}$`, 'm'), `${key} in compose`);
      continue;
    }
    const m = serverBlock.match(new RegExp(`^\\s+${key}: \\$\\{${key}:-([^}]*)\\}`, 'm'));
    assert.ok(m, `${key} missing from the server service environment in deploy/docker-compose.yml`);
    assert.equal(m[1], catalogEntry('server', key).def, `${key} compose default`);
  }
  // The index dir must live on a persistent volume.
  assert.match(serverBlock, /- server-data:\/data$/m);
});

test('every compose passthrough is documented in deploy/.env.example (no stale RAG_* keys)', () => {
  const example = fs.readFileSync(path.join(repoDir, 'deploy/.env.example'), 'utf8');
  for (const key of ragKeysUsedInServerCode()) {
    if (key === 'RAG_INDEX_DIR') continue; // fixed to /data/rag in compose
    const m = example.match(new RegExp(`^(#\\s*)?${key}=(.*)$`, 'm'));
    assert.ok(m, `${key} missing from deploy/.env.example`);
    if (!m[1]) assert.equal(m[2].trim(), catalogEntry('server', key).def, `${key} default in deploy/.env.example`);
  }
  for (const stale of ['RAG_URL', 'RAG_EMBED_MODEL', 'RAG_EMBED_KEEP_ALIVE']) {
    assert.ok(!new RegExp(`^${stale}=`, 'm').test(example), `${stale} still set in deploy/.env.example`);
  }
});

test('panel: clearing an optional number (def "") stores "" — not 0', () => {
  // RAG_SCORE_THRESHOLD=0 would drop every hit but exact duplicates, i.e.
  // silently turn RAG off; "" means "no filter".
  assert.equal(coerce('server', 'RAG_SCORE_THRESHOLD', ''), '');
  assert.equal(coerce('server', 'RAG_SCORE_THRESHOLD', '   '), '');
  assert.equal(coerce('server', 'RAG_SCORE_THRESHOLD', '0.8'), '0.8');
  assert.equal(coerce('server', 'RAG_SCORE_THRESHOLD', '0'), '0', 'an explicit 0 stays 0');
});

test('panel: a required number (non-empty def) rejects an empty value instead of storing 0', () => {
  assert.throws(() => coerce('server', 'RAG_TIMEOUT_MS', ''), /Zahl/);
  assert.throws(() => coerce('server', 'CAMPAIGN_CONTEXT_MAX_CHARS', '  '), /Zahl/);
  assert.throws(() => coerce('server', 'RAG_TIMEOUT_MS', 'abc'), /Zahl/);
  assert.throws(() => coerce('server', 'RAG_MAX_CHUNK_CHARS', ''), /Zahl/);
  assert.equal(coerce('server', 'RAG_TIMEOUT_MS', ' 1500 '), '1500');
});
