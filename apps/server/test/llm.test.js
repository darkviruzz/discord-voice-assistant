import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { chat, warmUp } from '../src/llm.js';

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

const ENV = ['OLLAMA_URL', 'OLLAMA_MODEL', 'HISTORY_TURNS', 'OLLAMA_KEEP_ALIVE'];
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
  assert.equal(body.keep_alive, '-1');
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
