// Settings-catalog contract for the RAG variables: every RAG_* the server
// reads is a catalog entry, documented in .env.example / docker-compose with
// the same default the code falls back to, and the panel can store an
// optional number as "empty" (= feature off) instead of 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG, catalogEntry } from '../src/configCatalog.js';
import { coerce } from '../src/configStore.js';
import { ragConfig } from '../src/ragClient.js';
import { briefingConfig } from '../src/sessionBriefing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const repoDir = path.resolve(serverDir, '../..');

function ragKeysUsedInServerCode() {
  const keys = new Set();
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) { if (name !== 'public') walk(p); continue; }
      if (!p.endsWith('.js')) continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/process\.env\.(RAG_[A-Z0-9_]+)/g)) keys.add(m[1]);
    }
  };
  walk(path.join(serverDir, 'src'));
  return [...keys].sort();
}

test('every RAG_* read by the server is a server-scope catalog entry', () => {
  const used = ragKeysUsedInServerCode();
  assert.ok(used.length >= 6, `found ${used.join(', ')}`);
  for (const key of used) {
    const e = catalogEntry('server', key);
    assert.ok(e, `${key} missing from configCatalog.js`);
    assert.equal(e.group, 'Server · Live- & Kampagnen-Kontext', `${key} group`);
    assert.ok(e.label && e.desc && e.type && e.applyMode, `${key} incomplete catalog entry`);
  }
});

test('RAG catalog defaults == code fallbacks', () => {
  const saved = {};
  for (const e of CATALOG.filter((x) => x.key.startsWith('RAG_'))) {
    saved[e.key] = process.env[e.key];
    delete process.env[e.key];
  }
  try {
    const def = (k) => catalogEntry('server', k).def;
    const rag = ragConfig();
    assert.equal(rag.url, def('RAG_URL') || null);
    assert.equal(String(rag.timeoutMs), def('RAG_TIMEOUT_MS'));
    assert.equal(rag.scoreThreshold, def('RAG_SCORE_THRESHOLD') === '' ? null : Number(def('RAG_SCORE_THRESHOLD')));
    const b = briefingConfig();
    assert.equal(String(b.briefingEnabled), def('RAG_BRIEFING_ENABLED'));
    assert.equal(String(b.briefingTopK), def('RAG_BRIEFING_TOP_K'));
    assert.equal(String(b.briefingPostChat), def('RAG_BRIEFING_POST_CHAT'));
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

test('RAG vars are documented in apps/server/.env.example with the catalog default', () => {
  const example = fs.readFileSync(path.join(serverDir, '.env.example'), 'utf8');
  for (const key of ragKeysUsedInServerCode()) {
    const m = example.match(new RegExp(`^(#\\s*)?${key}=(.*)$`, 'm'));
    assert.ok(m, `${key} missing from apps/server/.env.example`);
    // Commented-out examples (RAG_URL, RAG_SCORE_THRESHOLD) show a sample value;
    // active lines must equal the catalog default.
    if (!m[1]) assert.equal(m[2].trim(), catalogEntry('server', key).def, `${key} default in .env.example`);
  }
});

test('RAG vars are passed through to the server container with the catalog default', () => {
  const compose = fs.readFileSync(path.join(repoDir, 'deploy/docker-compose.yml'), 'utf8');
  const serverBlock = compose.slice(compose.indexOf('\n  server:'), compose.indexOf('\n  rag:'));
  for (const key of ragKeysUsedInServerCode()) {
    const m = serverBlock.match(new RegExp(`^\\s+${key}: \\$\\{${key}:-([^}]*)\\}`, 'm'));
    assert.ok(m, `${key} missing from the server service environment in deploy/docker-compose.yml`);
    if (key !== 'RAG_URL') assert.equal(m[1], catalogEntry('server', key).def, `${key} compose default`);
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
  assert.equal(coerce('server', 'RAG_TIMEOUT_MS', ' 1500 '), '1500');
});
