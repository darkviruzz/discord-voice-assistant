// End-to-end: the real control-channel session_start path (control.js) →
// live-context rebuild from the JSONL (summarize via a stub Ollama) → vault
// briefing (the real in-process RAG over a tmp vault, embeddings from the same
// stub Ollama) → Discord post to the registered bot. Guards against the
// briefing being re-run by the session_start the bot re-emits after every
// reconnect.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { fakeVector } from '../test-support/rag.js';

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
  OBSIDIAN_VAULT_PATH: path.join(tmp, 'vault'),
  RAG_INDEX_DIR: path.join(tmp, 'rag-index'),
  RAG_ENABLED: 'true',
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
let stopRag;
// The Discord post goes to whichever bot is connected at that moment; hold
// the briefing text back until the reconnected bot has registered, so the
// post can't fall into the gap between the two connections (in-process RAG
// answers in a few ms — fast enough to hit that gap).
let openBriefingGate;
const briefingGate = new Promise((r) => { openBriefingGate = r; });
const clients = []; // every bot socket, terminated in after() even when a test fails

before(async () => {
  for (const k of [...Object.keys(ENV), 'OLLAMA_URL', 'EMBED_PROVIDER', 'EMBED_MODEL']) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  delete process.env.EMBED_PROVIDER;
  delete process.env.EMBED_MODEL;

  // Stub Ollama: /api/embed (vault index + RAG queries, deterministic vectors)
  // and /api/chat (summarizer and briefing text).
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/embed') {
        for (const t of json.input) {
          if (t.startsWith('search_query: ')) stubCalls.query.push({ query: t.slice('search_query: '.length) });
        }
        res.end(JSON.stringify({ embeddings: json.input.map((t) => fakeVector(t)) }));
      } else {
        stubCalls.chat.push(json);
        const isBriefing = json.messages?.[0]?.content?.includes('Spielleiter-Assistenz');
        const reply = () => res.end(JSON.stringify({ message: { content: isBriefing ? 'Ihr steht noch am Tor.' : SUMMARY } }));
        if (isBriefing) briefingGate.then(reply); else reply();
      }
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${stub.address().port}`;

  // The vault the briefing searches, indexed by the real in-process RAG.
  fs.mkdirSync(path.join(tmp, 'vault', 'npcs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'vault', 'npcs', 'kelthur.md'), 'Baron Kelthur herrscht über Greyhawk.');
  const rag = await import('../src/rag/index.js');
  stopRag = rag.stopRag;
  await rag.startRag({ watch: false, saveDelayMs: 10 });
  await rag._activeIndexer().whenSynced();

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

after(async () => {
  await stopRag?.();
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
  openBriefingGate();
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
