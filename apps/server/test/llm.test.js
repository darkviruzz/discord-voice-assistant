import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { chat, warmUp, primeChat, answerFormat, ANSWER_SCHEMA } from '../src/llm.js';

// chat() output is read aloud by TTS, so parsing the model's reply (JSON,
// fenced JSON, plain text) decides what the players hear.
let server;
let requests;
let reply; // { status?, content }

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(reply.status && reply.status !== 200 ? 'boom' : JSON.stringify({ message: { content: reply.content } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(() => server.close());

const ENV = ['OLLAMA_URL', 'OLLAMA_MODEL', 'HISTORY_TURNS', 'OLLAMA_KEEP_ALIVE', 'LLM_JSON_FORMAT'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
  requests = [];
  reply = { content: '' };
});

test('a JSON reply is parsed into text / speakerId / model', async () => {
  reply.content = '{"text":"  Baron Kelthur herrschte mit eiserner Faust. ","speaker_id":1,"model":"high"}';
  assert.deepEqual(await chat([], 'Wer ist Kelthur?'), { text: 'Baron Kelthur herrschte mit eiserner Faust.', speakerId: 1, model: 'high' });
});

test('JSON inside markdown fences is unwrapped', async () => {
  reply.content = '```json\n{"text":"Die Tür ist verschlossen.","speaker_id":4}\n```';
  assert.deepEqual(await chat([], 'q'), { text: 'Die Tür ist verschlossen.', speakerId: 4, model: 'emotional' });
});

test('speaker_id is clamped to 0–7 and must be an integer; unknown model → "emotional"', async () => {
  reply.content = '{"text":"Hallo zusammen dort.","speaker_id":42,"model":"ultra"}';
  assert.deepEqual(await chat([], 'q'), { text: 'Hallo zusammen dort.', speakerId: 7, model: 'emotional' });
  reply.content = '{"text":"Hallo zusammen dort.","speaker_id":-3}';
  assert.equal((await chat([], 'q')).speakerId, 0);
  reply.content = '{"text":"Hallo zusammen dort.","speaker_id":"2"}';
  assert.equal((await chat([], 'q')).speakerId, 4, 'string id → neutral default');
});

test('a plain-text reply is spoken as-is with the neutral voice', async () => {
  reply.content = '  Ich weiß es leider nicht.  ';
  assert.deepEqual(await chat([], 'q'), { text: 'Ich weiß es leider nicht.', speakerId: 4, model: 'emotional' });
});

// Live test 2026-10-20: Piper read "*(Mit zitternder Stimme …)*" aloud.
test('stage directions and markdown markers are removed from the answer text', async () => {
  reply.content = '{"text":"*(Mit zitternder Stimme und hastiger Atmung)* Oh Gott... bitte...","speaker_id":7,"model":"emotional"}';
  assert.deepEqual(await chat([], 'q'), { text: 'Oh Gott... bitte...', speakerId: 7, model: 'emotional' });
  reply.content = '*seufzt* Das ist **sehr** ärgerlich.';
  assert.equal((await chat([], 'q')).text, 'Das ist sehr ärgerlich.', 'plain-text fallback too');
});

test('request: base system prompt, non-blank system blocks in order, trimmed history, then the query', async () => {
  process.env.OLLAMA_MODEL = 'qwen2.5';
  process.env.HISTORY_TURNS = '1';
  process.env.OLLAMA_KEEP_ALIVE = '-1';
  reply.content = '{"text":"ok ok ok"}';
  const history = [
    { role: 'user', content: 'alt-1' }, { role: 'assistant', content: 'alt-2' },
    { role: 'user', content: 'neu-1' }, { role: 'assistant', content: 'neu-2' },
  ];
  await chat(history, 'Frage?', { systemBlocks: ['Kampagne: Greyhawk', '', '   ', null, 'Live: [Greta] Hallo'] });
  const body = requests[0];
  assert.equal(body.model, 'qwen2.5');
  assert.equal(body.stream, false);
  assert.equal(body.keep_alive, -1); // a bare number goes out as a number (Ollama: string "-1" = 400)
  const roles = body.messages.map((m) => `${m.role}:${m.role === 'system' && m === body.messages[0] ? 'BASE' : m.content}`);
  assert.deepEqual(roles, [
    'system:BASE',
    'system:Kampagne: Greyhawk',
    'system:Live: [Greta] Hallo',
    'user:neu-1',
    'assistant:neu-2',
    'user:Frage?',
  ]);
  assert.ok(body.messages[0].content.length > 0, 'base system prompt (default or SYSTEM_PROMPT[_FILE])');
  assert.equal(history.length, 4, 'caller history is not mutated');
});

test('question context goes into the user message after the cached front and the history', async () => {
  reply.content = '{"text":"ok ok ok","speaker_id":4,"model":"high"}';
  const history = [{ role: 'user', content: 'alt' }, { role: 'assistant', content: 'antwort' }];
  await chat(history, 'Wer ist Spugnoir?', {
    systemBlocks: ['Live: [Greta] Hallo'],
    contextBlocks: ['Neueste Beiträge: [Markus] Rabenauge, wer ist Spugnoir?', '', 'Kampagnen-Kontext: Spugnoir, Magierlehrling'],
  });
  const msgs = requests[0].messages;
  assert.deepEqual(msgs.slice(1).map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(msgs.at(-1).content,
    'Neueste Beiträge: [Markus] Rabenauge, wer ist Spugnoir?\n\nKampagnen-Kontext: Spugnoir, Magierlehrling\n\nFrage: Wer ist Spugnoir?');
});

test('Ollama answers are constrained to the answer JSON schema (LLM_JSON_FORMAT=auto)', async () => {
  delete process.env.LLM_JSON_FORMAT;
  reply.content = '{"text":"Ja, so ist es.","speaker_id":4,"model":"emotional"}';
  await chat([], 'q');
  assert.deepEqual(requests[0].format, ANSWER_SCHEMA);
  assert.deepEqual(ANSWER_SCHEMA.required, ['text', 'speaker_id', 'model']);
  process.env.LLM_JSON_FORMAT = 'off';
  await chat([], 'q');
  assert.equal('format' in requests[1], false, 'off → free text');
  process.env.LLM_JSON_FORMAT = 'json';
  await chat([], 'q');
  assert.equal(requests[2].format, 'json');
  delete process.env.LLM_JSON_FORMAT;
});

test('openai: no response_format unless LLM_JSON_FORMAT asks for it', () => {
  const saved = { p: process.env.LLM_PROVIDER, f: process.env.LLM_JSON_FORMAT };
  try {
    process.env.LLM_PROVIDER = 'openai';
    delete process.env.LLM_JSON_FORMAT;
    assert.equal(answerFormat(), null);
    process.env.LLM_JSON_FORMAT = 'schema';
    assert.deepEqual(answerFormat(), ANSWER_SCHEMA);
  } finally {
    if (saved.p === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = saved.p;
    if (saved.f === undefined) delete process.env.LLM_JSON_FORMAT; else process.env.LLM_JSON_FORMAT = saved.f;
  }
});

test('primeChat sends exactly the front of the next answer prompt, one token', async () => {
  process.env.HISTORY_TURNS = '1';
  reply.content = '{"text":"Die Antwort lautet so.","speaker_id":4,"model":"high"}';
  const history = [{ role: 'user', content: 'alt' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'neu' }, { role: 'assistant', content: 'a2' }];
  const blocks = ['Letzte Session: …', 'Live: [Greta] Hallo'];
  await primeChat(blocks, history);
  await chat(history, 'Frage?', { systemBlocks: blocks, contextBlocks: ['RAG'] });
  const [prime, answer] = requests;
  assert.equal(prime.options.num_predict, 1);
  assert.deepEqual(prime.messages, answer.messages.slice(0, -1), 'prime = answer prompt without its last user message');
  assert.deepEqual(prime.messages.slice(-2).map((m) => m.content), ['neu', 'a2'], 'recent history is part of the front');
  assert.deepEqual(prime.format, answer.format);
});

test('HTTP and connection errors are thrown with context', async () => {
  reply = { status: 500 };
  await assert.rejects(() => chat([], 'q'), /llm: HTTP 500 \(http:.*\/api\/chat\): boom/);
  process.env.OLLAMA_URL = 'http://127.0.0.1:1';
  await assert.rejects(() => chat([], 'q'), /llm: connection failed/);
});

test('warmUp never throws and reports success as a boolean', async () => {
  reply.content = '';
  assert.equal(await warmUp(), true);
  assert.deepEqual(requests.at(-1).messages, [], 'empty messages = load model only');
  reply = { status: 404 };
  assert.equal(await warmUp(), false);
  process.env.OLLAMA_URL = 'http://127.0.0.1:1';
  assert.equal(await warmUp(), false);
});
