// End-to-end: the real control-channel session_start path (control.js) →
// live-context rebuild from the JSONL (summarize via a stub Ollama) → vault
// briefing (stub RAG) → Discord post to the registered bot. Guards against the
// briefing being re-run by the session_start the bot re-emits after every
// reconnect.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-briefing-'));
const ENV = {
  TRANSCRIPT_DIR: path.join(tmp, 'transcripts'),
  FINALIZE_UPLOAD_DIR: path.join(tmp, 'uploads'),
  CONFIG_OVERRIDES_FILE: path.join(tmp, 'overrides.json'),
  SPEAKER_MAP_FILE: path.join(tmp, 'speaker-map.json'),
  LIVE_CONTEXT_ENABLED: 'true',
  LIVE_RAW_WINDOW_CHARS: '60', // force the rebuild to fold older turns → summary
  RAG_BRIEFING_ENABLED: 'true',
  RAG_BRIEFING_POST_CHAT: 'true',
};
const saved = {};

const SID = '1700000000000';
const SUMMARY = 'Die Gruppe verhandelte am Tor mit Baron Kelthur.';
const stubCalls = { query: [], chat: [] };
let stub;
let server;
let wss;
let url;
let sessions;
const clients = []; // every bot socket, terminated in after() even when a test fails

before(async () => {
  for (const k of [...Object.keys(ENV), 'RAG_URL', 'OLLAMA_URL']) saved[k] = process.env[k];
  Object.assign(process.env, ENV);

  // Stub RAG (/query) + Ollama (/api/chat: summarizer and briefing text).
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/query') {
        stubCalls.query.push(json);
        res.end(JSON.stringify([{ text: 'Baron Kelthur herrscht über Greyhawk.', source: 'npcs/kelthur.md', distance: 0.2 }]));
      } else {
        stubCalls.chat.push(json);
        const isBriefing = json.messages?.[0]?.content?.includes('Spielleiter-Assistenz');
        res.end(JSON.stringify({ message: { content: isBriefing ? 'Ihr steht noch am Tor.' : SUMMARY } }));
      }
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;
  process.env.RAG_URL = stubBase;
  process.env.OLLAMA_URL = stubBase;

  // A prior part of this session in the JSONL (resume after a server restart).
  fs.mkdirSync(ENV.TRANSCRIPT_DIR, { recursive: true });
  const t0 = Number(SID);
  const lines = Array.from({ length: 8 }, (_, i) => JSON.stringify({
    schemaVersion: 2, type: 'user_transcript', sessionId: SID, tsMs: t0 + i * 5000,
    userId: '42', userDisplayName: 'Alrik', text: `Wir reden mit dem Baron über das Tor, Teil ${i}.`,
  }));
  fs.writeFileSync(path.join(ENV.TRANSCRIPT_DIR, `session_${SID}.jsonl`), lines.join('\n') + '\n');

  const { initControlWSS } = await import('../src/control.js');
  ({ sessions } = await import('../src/state.js'));
  wss = initControlWSS({});
  server = http.createServer();
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const ws of clients) ws.terminate();
  for (const ws of wss?.clients ?? []) ws.terminate();
  wss?.close();
  server?.close();
  stub?.closeAllConnections();
  stub?.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Connect + register like the bot does; collects every server message.
async function connectBot() {
  const ws = new WebSocket(url);
  clients.push(ws);
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.send(JSON.stringify({ type: 'register', botId: 'test', protoVersion: 1 }));
  await waitFor(() => inbox.some((m) => m.type === 'registered'));
  return { ws, inbox };
}

async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sessionStart = (cmdId, resume) => JSON.stringify({
  type: 'session_start', cmdId, sessionId: SID, guildId: 'g1', channelId: 'c1', resume,
});

test('session_start re-emitted on reconnect does not repeat the briefing', async () => {
  // First connection: session_start (resume after a server restart).
  const a = await connectBot();
  a.ws.send(sessionStart('s1', true));
  await waitFor(() => a.inbox.some((m) => m.type === 'ack' && m.cmdId === 's1'));

  // Control reconnect while the rebuild/briefing may still be running: the
  // bot re-emits the pending session_start on the new connection.
  a.ws.close();
  const b = await connectBot();
  b.ws.send(sessionStart('s2', true));
  await waitFor(() => b.inbox.some((m) => m.type === 'ack' && m.cmdId === 's2'));

  await waitFor(() => stubCalls.query.length >= 1 && b.inbox.concat(a.inbox).some((m) => m.briefing));

  // Later: /leave → /join resumes the same session → another session_start.
  b.ws.send(sessionStart('s3', true));
  await waitFor(() => b.inbox.some((m) => m.type === 'ack' && m.cmdId === 's3'));
  await new Promise((r) => setTimeout(r, 300)); // give a (buggy) second briefing time to land

  const session = sessions.get(BigInt(SID));
  assert.equal(session.liveContext.summary, SUMMARY, 'rebuild folded the JSONL history into a summary');
  assert.equal(stubCalls.query.length, 1, 'exactly one RAG query');
  assert.equal(stubCalls.query[0].query, SUMMARY, 'briefing searches with the rebuilt summary');
  const sys = session.conversationHistory.filter((m) => m.role === 'system');
  assert.equal(sys.length, 1, 'exactly one briefing system message');
  assert.match(sys[0].content, /Baron Kelthur herrscht über Greyhawk\./);
  const posts = [...a.inbox, ...b.inbox].filter((m) => m.type === 'chat_message' && m.briefing);
  assert.equal(posts.length, 1, 'exactly one Discord briefing post');
  assert.equal(posts[0].channelId, 'c1');
});
