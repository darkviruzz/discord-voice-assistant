// Settings-catalog contract for the LLM provider variables (counterpart of
// configStt/configTts/configRag): every key providers/llm.js reads is a
// complete catalog entry, the API key is a secret, the keys are documented in
// apps/server/.env.example, and the provider keys reach the server container.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { catalogEntry, isSecretEntry } from '../src/configCatalog.js';
import { coerce } from '../src/configStore.js';
import { llmConfig, defaultModel, llmProvider } from '../src/providers/llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');
const repoDir = path.resolve(serverDir, '../..');

function llmKeysUsed() {
  const src = fs.readFileSync(path.join(serverDir, 'src/providers/llm.js'), 'utf8')
    + fs.readFileSync(path.join(serverDir, 'src/llm.js'), 'utf8');
  const keys = new Set();
  for (const m of src.matchAll(/\benv\('([A-Z0-9_]+)'/g)) keys.add(m[1]);
  for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) keys.add(m[1]);
  return [...keys].sort();
}

// The provider-layer keys introduced with LLM_PROVIDER (OLLAMA_* predate it
// and are wired in compose separately).
const PROVIDER_KEYS = () => llmKeysUsed().filter((k) => k.startsWith('LLM_'));

test('every key the LLM layer reads is a complete server catalog entry', () => {
  const used = llmKeysUsed();
  for (const k of ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'LLM_TIMEOUT_MS', 'OLLAMA_URL', 'OLLAMA_MODEL', 'OLLAMA_KEEP_ALIVE']) {
    assert.ok(used.includes(k), `${k} not read by the LLM layer? found ${used.join(', ')}`);
  }
  for (const key of used) {
    const e = catalogEntry('server', key);
    assert.ok(e, `${key} missing from configCatalog.js`);
    assert.ok(e.label && e.desc && e.type && e.applyMode, `${key} incomplete catalog entry`);
  }
  assert.equal(isSecretEntry(catalogEntry('server', 'LLM_API_KEY')), true);
  assert.throws(() => coerce('server', 'LLM_API_KEY', 'sk-x'), /Secret/);
  assert.equal(coerce('server', 'LLM_PROVIDER', 'openai'), 'openai');
  assert.throws(() => coerce('server', 'LLM_PROVIDER', 'vllm'), /ollama, openai/);
});

function withLlmEnvCleared(fn) {
  const keys = llmKeysUsed();
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// The code fell back to 'llama3' while catalog, .env.example, compose and the
// launchers (Setup/start.sh pull it) say llama3.2: a server without
// OLLAMA_MODEL asked Ollama for a model nobody pulled.
test('LLM catalog defaults == code fallbacks', () => withLlmEnvCleared(() => {
  const def = (k) => catalogEntry('server', k).def;
  assert.equal(llmProvider(), def('LLM_PROVIDER'));
  const c = llmConfig();
  assert.equal(c.model, def('OLLAMA_MODEL'));
  assert.equal(c.url, def('OLLAMA_URL'));
  assert.equal(c.keepAlive, def('OLLAMA_KEEP_ALIVE'));
  process.env.LLM_PROVIDER = 'openai';
  assert.equal(defaultModel(), def('OLLAMA_MODEL'), 'LLM_MODEL empty → OLLAMA_MODEL default');
  assert.equal(llmConfig().url, def('LLM_BASE_URL'));
  const src = fs.readFileSync(path.join(serverDir, 'src/llm.js'), 'utf8');
  assert.match(src, new RegExp(`Number\\(process\\.env\\.LLM_TIMEOUT_MS\\) \\|\\| ${Number(def('LLM_TIMEOUT_MS')).toLocaleString('en').replace(/,/g, '_')}\\b`));
}));

// A string field cleared in the settings panel is '' in process.env. Ollama
// rejects keep_alive "" (HTTP 400) — every answer failed until a restart.
test('a cleared OLLAMA_KEEP_ALIVE falls back to the default instead of sending ""', () => withLlmEnvCleared(() => {
  process.env.OLLAMA_KEEP_ALIVE = '';
  assert.equal(llmConfig().keepAlive, '30m');
  process.env.OLLAMA_KEEP_ALIVE = ' -1 ';
  assert.equal(llmConfig().keepAlive, '-1');
}));

test('LLM vars are documented in apps/server/.env.example with the catalog default', () => {
  const example = fs.readFileSync(path.join(serverDir, '.env.example'), 'utf8');
  for (const key of llmKeysUsed()) {
    const e = catalogEntry('server', key);
    const m = example.match(new RegExp(`^(#\\s*)?${key}=(.*)$`, 'm'));
    assert.ok(m, `${key} missing from apps/server/.env.example`);
    if (!m[1] && !isSecretEntry(e)) assert.equal(m[2].trim(), e.def, `${key} default in .env.example`);
  }
});

// docs/providers.md tells container users to set provider keys in deploy/.env
// — compose only passes keys listed in the server's `environment:` into the
// container, so an LLM_PROVIDER=openai there was silently ignored.
test('LLM provider vars are passed through to the server container and documented in deploy/.env.example', () => {
  const compose = fs.readFileSync(path.join(repoDir, 'deploy/docker-compose.yml'), 'utf8');
  const start = compose.indexOf('\n  server:');
  const end = compose.indexOf('\n    env_file:', start);
  const serverEnv = compose.slice(start, end);
  const deployExample = fs.readFileSync(path.join(repoDir, 'deploy/.env.example'), 'utf8');
  assert.ok(PROVIDER_KEYS().length >= 5);
  for (const key of PROVIDER_KEYS()) {
    const m = serverEnv.match(new RegExp(`^\\s+${key}: \\$\\{${key}:-([^}]*)\\}`, 'm'));
    assert.ok(m, `${key} missing from the server service environment in deploy/docker-compose.yml`);
    assert.equal(m[1], catalogEntry('server', key).def, `${key} compose default`);
    const d = deployExample.match(new RegExp(`^${key}=(.*)$`, 'm'));
    assert.ok(d, `${key} missing from deploy/.env.example`);
    assert.equal(d[1].trim(), catalogEntry('server', key).def, `${key} default in deploy/.env.example`);
  }
});
