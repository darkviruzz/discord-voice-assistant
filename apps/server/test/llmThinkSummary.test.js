// LLM thinking control (LLM_THINK, LLM_REASONING_EFFORT, LLM_CHAT_TEMPLATE_KWARGS)
// and the optional summary endpoint (SUMMARY_PROVIDER / _BASE_URL / _API_KEY),
// against a fake server speaking both dialects.
//
// Live evidence 2026-10-18: Ollama /api/chat without `think` let gemma4:12b
// reason first — 1506 generated tokens (42.6 s) for a 290-char answer.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  complete, warmUp, llmConfig, llmEndpoint, summaryModel, summaryConfig, thinkSetting, _resetLlmState,
} from '../src/providers/llm.js';
import { summarizeSession } from '../src/finalize/summary.js';

const seen = [];
let reply = null; // (req, body) => [status, json]
const srv = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ url: req.url, auth: req.headers.authorization ?? null, body });
    const [status, json] = reply(req, body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const OLLAMA_OK = () => [200, { message: { content: 'ok' } }];
const OPENAI_OK = () => [200, { choices: [{ message: { content: 'ok' } }] }];
const USER = [{ role: 'user', content: 'q' }];

const KEYS = ['LLM_PROVIDER', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'LLM_THINK', 'LLM_REASONING_EFFORT',
  'LLM_CHAT_TEMPLATE_KWARGS', 'OLLAMA_URL', 'OLLAMA_MODEL', 'OLLAMA_KEEP_ALIVE',
  'SUMMARY_PROVIDER', 'SUMMARY_BASE_URL', 'SUMMARY_API_KEY', 'SUMMARY_MODEL', 'SESSION_SUMMARY_ENABLED'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  seen.length = 0;
  reply = OLLAMA_OK;
  _resetLlmState();
});

async function quietWarn(fn) {
  const orig = console.warn;
  const lines = [];
  console.warn = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.warn = orig; }
  return lines;
}

// ── think (Ollama) ───────────────────────────────────────────────────────────

test('ollama: think:false by default — answers, warm-up and summary calls', async () => {
  process.env.OLLAMA_URL = BASE;
  process.env.OLLAMA_MODEL = 'gemma4:12b';
  await complete({ messages: USER });
  await complete({ messages: USER, role: 'summary' });
  assert.equal(await warmUp(), true);
  assert.equal(seen.length, 3);
  for (const s of seen) {
    assert.equal(s.url, '/api/chat');
    assert.equal(s.body.think, false);
  }
  assert.deepEqual(seen[2].body.messages, [], 'warm-up shape unchanged');
  assert.equal(llmConfig().think, false);
});

test('LLM_THINK: true / level / auto (omitted); unknown values count as false', async () => {
  process.env.OLLAMA_URL = BASE;
  const cases = [['true', true], ['TRUE', true], ['high', 'high'], ['low', 'low'], ['false', false], ['', false], ['nein', false]];
  for (const [raw, want] of cases) {
    process.env.LLM_THINK = raw;
    assert.equal(thinkSetting(), want, `LLM_THINK=${raw}`);
    seen.length = 0;
    await complete({ messages: USER });
    assert.equal(seen[0].body.think, want, `LLM_THINK=${raw} sent`);
  }
  process.env.LLM_THINK = 'auto';
  seen.length = 0;
  await complete({ messages: USER });
  assert.equal('think' in seen[0].body, false, 'auto → field not sent (model default)');
});

test('a model that rejects think is asked again without it, once per model+value', async () => {
  process.env.OLLAMA_URL = BASE;
  process.env.OLLAMA_MODEL = 'llama3.2';
  process.env.LLM_THINK = 'true';
  // Ollama 0.40.6, verbatim: think:true on a model without the capability.
  reply = (_req, body) => ('think' in body
    ? [400, { error: '"llama3.2" does not support thinking' }]
    : [200, { message: { content: 'hallo' } }]);
  const warns = await quietWarn(async () => {
    assert.equal((await complete({ messages: USER })).content, 'hallo');
    assert.equal((await complete({ messages: USER })).content, 'hallo');
  });
  assert.deepEqual(seen.map((s) => 'think' in s.body), [true, false, false], 'second answer: one request, no think');
  assert.equal(warns.filter((l) => l.includes('rejects think')).length, 1);
  // Switching back to false sends false again (not stuck on "omit").
  process.env.LLM_THINK = 'false';
  reply = OLLAMA_OK;
  seen.length = 0;
  await complete({ messages: USER });
  assert.equal(seen[0].body.think, false);
});

test('other HTTP 400s are not retried', async () => {
  process.env.OLLAMA_URL = BASE;
  reply = () => [400, { error: 'invalid options' }];
  await assert.rejects(() => complete({ messages: USER }), /llm: HTTP 400/);
  assert.equal(seen.length, 1);
});

// ── OpenAI-compatible reasoning opt-ins ──────────────────────────────────────

test('openai: no think / reasoning fields unless configured', async () => {
  process.env.LLM_PROVIDER = 'openai';
  process.env.LLM_BASE_URL = `${BASE}/v1`;
  reply = OPENAI_OK;
  await complete({ messages: USER });
  assert.deepEqual(Object.keys(seen[0].body).sort(), ['messages', 'model', 'stream']);
  assert.equal(llmConfig().reasoningEffort, null);
  assert.equal(llmConfig().chatTemplateKwargs, null);
});

test('openai: LLM_REASONING_EFFORT and LLM_CHAT_TEMPLATE_KWARGS are sent when set', async () => {
  process.env.LLM_PROVIDER = 'openai';
  process.env.LLM_BASE_URL = `${BASE}/v1`;
  process.env.LLM_REASONING_EFFORT = 'none';
  process.env.LLM_CHAT_TEMPLATE_KWARGS = '{"enable_thinking":false}';
  reply = OPENAI_OK;
  await complete({ messages: USER });
  assert.equal(seen[0].body.reasoning_effort, 'none');
  assert.deepEqual(seen[0].body.chat_template_kwargs, { enable_thinking: false });
  assert.equal('think' in seen[0].body, false);
  assert.deepEqual(llmConfig().chatTemplateKwargs, { enable_thinking: false });
});

test('openai: invalid LLM_CHAT_TEMPLATE_KWARGS is not sent and warned about once', async () => {
  process.env.LLM_PROVIDER = 'openai';
  process.env.LLM_BASE_URL = `${BASE}/v1`;
  reply = OPENAI_OK;
  const warns = await quietWarn(async () => {
    for (const bad of ['{enable_thinking:false}', '{enable_thinking:false}', '[1]']) {
      process.env.LLM_CHAT_TEMPLATE_KWARGS = bad;
      await complete({ messages: USER });
    }
  });
  assert.ok(seen.every((s) => !('chat_template_kwargs' in s.body)));
  assert.equal(warns.filter((l) => l.includes('LLM_CHAT_TEMPLATE_KWARGS')).length, 2, 'once per bad value');
});

// ── summary endpoint ─────────────────────────────────────────────────────────

test('summary: defaults to the answer server, SUMMARY_MODEL as model', async () => {
  process.env.OLLAMA_URL = BASE;
  process.env.OLLAMA_MODEL = 'gemma4:12b';
  assert.equal(summaryModel(), 'gemma4:12b');
  process.env.SUMMARY_MODEL = ' qwen3:14b ';
  assert.equal(summaryModel(), 'qwen3:14b');
  await complete({ messages: USER, role: 'summary' });
  assert.equal(seen[0].url, '/api/chat');
  assert.equal(seen[0].body.model, 'qwen3:14b');
  assert.deepEqual(summaryConfig(), { provider: 'ollama', url: BASE, model: 'qwen3:14b', sameServer: true, apiKey: false });
});

test('summary: a separate openai server gets SUMMARY_API_KEY, never LLM_API_KEY or the LLM extras', async () => {
  process.env.LLM_PROVIDER = 'openai';
  process.env.LLM_BASE_URL = `${BASE}/main/v1`;
  process.env.LLM_API_KEY = 'sk-main';
  process.env.LLM_REASONING_EFFORT = 'none';
  process.env.SUMMARY_BASE_URL = `${BASE}/sum/v1/`;
  process.env.SUMMARY_MODEL = 'big-model';
  reply = OPENAI_OK;
  await complete({ messages: USER, role: 'summary' });
  assert.equal(seen[0].url, '/sum/v1/chat/completions');
  assert.equal(seen[0].auth, null, 'LLM_API_KEY stays with LLM_BASE_URL');
  assert.equal(seen[0].body.model, 'big-model');
  assert.equal('reasoning_effort' in seen[0].body, false);
  process.env.SUMMARY_API_KEY = 'sk-sum';
  await complete({ messages: USER, role: 'summary' });
  assert.equal(seen[1].auth, 'Bearer sk-sum');
  // Answers are untouched.
  await complete({ messages: USER });
  assert.equal(seen[2].url, '/main/v1/chat/completions');
  assert.equal(seen[2].auth, 'Bearer sk-main');
  assert.equal(seen[2].body.reasoning_effort, 'none');
});

test('summary: same openai server → LLM_API_KEY and extras are reused', async () => {
  process.env.LLM_PROVIDER = 'openai';
  process.env.LLM_BASE_URL = `${BASE}/v1`;
  process.env.LLM_API_KEY = 'sk-main';
  process.env.LLM_CHAT_TEMPLATE_KWARGS = '{"enable_thinking":false}';
  process.env.SUMMARY_BASE_URL = `${BASE}/v1/`; // same server, other spelling
  reply = OPENAI_OK;
  await complete({ messages: USER, role: 'summary' });
  assert.equal(seen[0].auth, 'Bearer sk-main');
  assert.deepEqual(seen[0].body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(llmEndpoint('summary').main, true);
});

test('summary: SUMMARY_PROVIDER=openai next to an Ollama answer LLM', async () => {
  process.env.OLLAMA_URL = `${BASE}/ollama`;
  process.env.OLLAMA_MODEL = 'gemma4:12b';
  process.env.SUMMARY_PROVIDER = 'openai';
  await assert.rejects(() => complete({ messages: USER, role: 'summary' }), /SUMMARY_PROVIDER=openai but neither SUMMARY_BASE_URL nor LLM_BASE_URL/);
  process.env.SUMMARY_BASE_URL = `${BASE}/cloud/v1`;
  process.env.SUMMARY_API_KEY = 'sk-sum';
  process.env.SUMMARY_MODEL = 'cloud-model';
  reply = OPENAI_OK;
  await complete({ messages: USER, role: 'summary' });
  assert.equal(seen[0].url, '/cloud/v1/chat/completions');
  assert.equal(seen[0].auth, 'Bearer sk-sum');
  assert.equal('think' in seen[0].body, false, 'no Ollama field on an OpenAI server');
  assert.deepEqual(summaryConfig(), { provider: 'openai', url: `${BASE}/cloud/v1`, model: 'cloud-model', sameServer: false, apiKey: true });
});

test('summary: SUMMARY_PROVIDER=ollama on another host keeps think:false; empty = LLM_PROVIDER', async () => {
  process.env.LLM_PROVIDER = 'openai';
  process.env.LLM_BASE_URL = `${BASE}/v1`;
  process.env.LLM_API_KEY = 'sk-main';
  process.env.OLLAMA_MODEL = 'qwen3:32b';
  process.env.SUMMARY_PROVIDER = 'ollama';
  process.env.SUMMARY_BASE_URL = `${BASE}/gpu2`;
  await complete({ messages: USER, role: 'summary' });
  assert.equal(seen[0].url, '/gpu2/api/chat');
  assert.equal(seen[0].body.model, 'qwen3:32b');
  assert.equal(seen[0].body.think, false);
  assert.equal(seen[0].auth, null);
  process.env.SUMMARY_PROVIDER = '';
  assert.equal(llmEndpoint('summary').provider, 'openai');
});

// OLLAMA_URL is panel-editable: a SUMMARY_API_KEY sent there could be
// redirected to any host from the settings panel.
test('summary: SUMMARY_API_KEY never goes to the panel-editable OLLAMA_URL', async () => {
  process.env.OLLAMA_URL = `${BASE}/ollama`;
  process.env.SUMMARY_API_KEY = 'sk-sum';
  await complete({ messages: USER, role: 'summary' });
  assert.equal(seen[0].url, '/ollama/api/chat');
  assert.equal(seen[0].auth, null);
  assert.equal(summaryConfig().apiKey, false);
  process.env.SUMMARY_BASE_URL = `${BASE}/gpu2`; // env-only → the key may go there
  await complete({ messages: USER, role: 'summary' });
  assert.equal(seen[1].url, '/gpu2/api/chat');
  assert.equal(seen[1].auth, 'Bearer sk-sum');
});

test('finalize session summary calls go to the summary endpoint', async () => {
  const roles = [];
  const fake = async ({ role, model }) => { roles.push([role, model]); return { content: 'Zusammenfassung' }; };
  process.env.SUMMARY_MODEL = 'sum-model';
  const md = Array.from({ length: 10 }, (_, i) => `[20:0${i}:00] **Anna:** Wir reden mit Baron Kelthur über den Vertrag Nummer ${i}.`).join('\n');
  assert.equal(await summarizeSession(md, { completeFn: fake }), 'Zusammenfassung');
  assert.deepEqual(roles, [['summary', 'sum-model']]);
});
