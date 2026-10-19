// Typed questions (/ask, /recap, @mention) through the real text pipeline:
// the answer is always posted to the asker's channel as a chat_message — also
// when the LLM fails (before, the asker only ever saw "Frage gesendet."), and
// the last finalized session's summary reaches the LLM for /recap.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTextPipeline } from '../src/pipeline.js';
import { botConnections } from '../src/broadcast.js';
import { resetLastSessionCache } from '../src/lastSession.js';

const KEYS = ['LLM_PROVIDER', 'OLLAMA_URL', 'OLLAMA_MODEL', 'LLM_TIMEOUT_MS', 'TRANSCRIPT_DIR', 'ARCHIVE_DIR',
  'OBSIDIAN_VAULT_PATH', 'DISCORD_POST_REPLIES', 'LIVE_CONTEXT_ENABLED', 'LAST_SESSION_CONTEXT_ENABLED'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'text-query-'));

let llmReply = null; // (body) → { status, json }
const llmBodies = [];
const llm = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    llmBodies.push(body);
    const r = llmReply(body);
    res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.json ?? {}));
  });
});

const sent = [];
const fakeBot = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };
const chatMessages = () => sent.filter((m) => m.type === 'chat_message');

before(async () => {
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  for (const k of KEYS) delete process.env[k];
  process.env.OLLAMA_URL = `http://127.0.0.1:${llm.address().port}`;
  process.env.TRANSCRIPT_DIR = path.join(tmp, 'transcripts');
  process.env.ARCHIVE_DIR = path.join(tmp, 'archive');
  process.env.LLM_TIMEOUT_MS = '2000';
  botConnections.add(fakeBot);
});

after(() => {
  botConnections.delete(fakeBot);
  llm.close();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => { sent.length = 0; llmBodies.length = 0; resetLastSessionCache(); });

test('a typed question is answered in its channel (DISCORD_POST_REPLIES off)', async () => {
  llmReply = () => ({ json: { message: { content: '{"text":"Baron Kelthur herrscht über Burg Rabenstein.","speaker_id":4}' } } });
  await runTextPipeline({ question: 'Wer ist Baron Kelthur?', channelId: 'c1', userDisplayName: 'Anna', source: 'slash' });
  const [m] = chatMessages();
  assert.equal(m.channelId, 'c1');
  assert.equal(m.question, 'Wer ist Baron Kelthur?');
  assert.equal(m.answer, 'Baron Kelthur herrscht über Burg Rabenstein.');
});

test('LLM failure: the typed question still gets a visible answer in its channel', async () => {
  llmReply = () => ({ status: 500, json: { error: 'model "llama3.2" not found' } });
  await runTextPipeline({ question: 'Was war letztes Mal?', channelId: 'c2', userDisplayName: 'Bert', source: 'mention' });
  const msgs = chatMessages();
  assert.equal(msgs.length, 1, 'exactly one chat_message');
  assert.equal(msgs[0].channelId, 'c2');
  assert.equal(msgs[0].question, 'Was war letztes Mal?');
  assert.match(msgs[0].answer, /Keine Antwort/);
  assert.ok(!msgs[0].answer.includes('127.0.0.1'), 'no internal URL in the channel');
});

test('/recap: the last finalized session summary reaches the LLM as a system block', async () => {
  const dir = path.join(process.env.ARCHIVE_DIR, '2026-10-01-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sessionStartMs: Date.UTC(2026, 9, 1, 18) }));
  fs.writeFileSync(path.join(dir, 'summary.md'), 'Die Gruppe floh aus den Minen von Khundrukar.\n');
  llmReply = () => ({ json: { message: { content: '{"text":"Ihr seid aus den Minen geflohen."}' } } });
  await runTextPipeline({ question: 'Fasse kurz zusammen, was in unserer letzten Sitzung passiert ist.', channelId: 'c3', source: 'slash' });
  const system = llmBodies[0].messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert.match(system, /letzten abgeschlossenen Sitzung \(01\.10\.2026\)/);
  assert.match(system, /Minen von Khundrukar/);
  assert.equal(chatMessages()[0].answer, 'Ihr seid aus den Minen geflohen.');
});

// Live test 2026-10-20: the direction in front was read aloud and posted.
test('the channel gets the answer without stage directions or markdown markers', async () => {
  llmReply = () => ({ json: { message: { content: '{"text":"*(Mit zitternder Stimme und hastiger Atmung)* Oh Gott... **bitte**...","speaker_id":7}' } } });
  await runTextPipeline({ question: 'Spiele den verängstigten Gefangenen.', channelId: 'c5', source: 'slash' });
  assert.equal(chatMessages()[0].answer, 'Oh Gott... bitte...');
});
