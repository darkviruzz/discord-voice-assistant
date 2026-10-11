import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { maybeSessionBriefing, briefingConfig } from '../src/sessionBriefing.js';
import { ensureSession, dropSession } from '../src/state.js';
import { botConnections } from '../src/broadcast.js';

const ENV_KEYS = [
  'RAG_URL', 'RAG_TIMEOUT_MS', 'RAG_BRIEFING_ENABLED', 'RAG_BRIEFING_POST_CHAT',
  'RAG_BRIEFING_TOP_K', 'CAMPAIGN_CONTEXT_MAX_CHARS', 'OLLAMA_URL',
];

let savedEnv;
let nextSid = 1000n;
let fakeBot;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  // A fake registered bot connection that records every broadcast.
  fakeBot = { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
  botConnections.add(fakeBot);
});

afterEach(() => {
  botConnections.delete(fakeBot);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// One in-process HTTP server standing in for both the RAG service (/query)
// and Ollama (/api/chat). Records every request body per path.
function withStub({ chunks = [], briefing = 'Die Gruppe stand vor dem Tor.', ragDelayMs = 0 } = {}, fn) {
  const calls = { query: [], chat: [] };
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const json = JSON.parse(body || '{}');
        if (req.url === '/query') {
          calls.query.push(json);
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(chunks));
          }, ragDelayMs);
        } else if (req.url === '/api/chat') {
          calls.chat.push(json);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: { content: briefing } }));
        } else {
          res.writeHead(404); res.end();
        }
      });
    });
    server.listen(0, '127.0.0.1', async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      process.env.RAG_URL = base;
      process.env.OLLAMA_URL = base;
      try { resolve(await fn(calls)); }
      catch (e) { reject(e); }
      finally { server.close(); }
    });
  });
}

// A real, registered session (state.js) — the briefing only touches sessions
// that are still live.
function makeSession(summary) {
  const sid = nextSid++;
  const session = ensureSession(sid);
  session.liveContext.summary = summary;
  return { sid, session };
}

const systemMessages = (session) => session.conversationHistory.filter((m) => m.role === 'system');

test('no-op when RAG is unconfigured', async () => {
  const { sid, session } = makeSession('Die Gruppe steht vor dem Tor.');
  await maybeSessionBriefing(session, sid, { channelId: 'c1' });
  assert.equal(session.conversationHistory.length, 0);
  dropSession(sid);
});

test('no-op when there is no prior summary (no RAG request either)', async () => {
  await withStub({ chunks: [{ text: 'irrelevant', source: 'x.md' }] }, async (calls) => {
    const { sid, session } = makeSession('   ');
    await maybeSessionBriefing(session, sid, { channelId: 'c1' });
    assert.equal(session.conversationHistory.length, 0);
    assert.equal(calls.query.length, 0);
    dropSession(sid);
  });
});

test('no-op when briefing is disabled', async () => {
  process.env.RAG_BRIEFING_ENABLED = 'false';
  await withStub({ chunks: [{ text: 'Baron Kelthur.', source: 'k.md' }] }, async (calls) => {
    const { sid, session } = makeSession('Wir trafen Baron Kelthur.');
    await maybeSessionBriefing(session, sid, { channelId: 'c1' });
    assert.equal(session.conversationHistory.length, 0);
    assert.equal(calls.query.length, 0);
    dropSession(sid);
  });
});

test('no-op when RAG is down (connection refused)', async () => {
  process.env.RAG_URL = 'http://127.0.0.1:1';
  const { sid, session } = makeSession('Wir trafen Baron Kelthur.');
  await maybeSessionBriefing(session, sid, { channelId: 'c1' });
  assert.equal(session.conversationHistory.length, 0);
  dropSession(sid);
});

test('injects vault context as a leading system message, searching with the summary', async () => {
  process.env.RAG_BRIEFING_TOP_K = '4';
  await withStub({ chunks: [{ text: 'Baron Kelthur herrscht.', source: 'npcs/kelthur.md' }] }, async (calls) => {
    const { sid, session } = makeSession('Wir trafen Baron Kelthur.');
    session.conversationHistory.push({ role: 'user', content: 'hallo' });
    await maybeSessionBriefing(session, sid, { channelId: 'c1' });
    assert.equal(calls.query.length, 1);
    assert.equal(calls.query[0].query, 'Wir trafen Baron Kelthur.');
    assert.equal(calls.query[0].top_k, 4);
    assert.equal(session.conversationHistory[0].role, 'system');
    assert.ok(session.conversationHistory[0].content.includes('Baron Kelthur herrscht.'));
    assert.ok(session.conversationHistory[0].content.includes('[Quelle: npcs/kelthur.md]'));
    // existing history is preserved after the prepended briefing
    assert.equal(session.conversationHistory[1].content, 'hallo');
    // POST_CHAT defaults to off → no LLM call, no Discord message
    assert.equal(calls.chat.length, 0);
    assert.equal(fakeBot.sent.length, 0);
    dropSession(sid);
  });
});

test('runs at most once per session — a re-emitted session_start (reconnect) does not re-inject or re-post', async () => {
  process.env.RAG_BRIEFING_POST_CHAT = 'true';
  await withStub({ chunks: [{ text: 'Baron Kelthur herrscht.', source: 'k.md' }] }, async (calls) => {
    const { sid, session } = makeSession('Wir trafen Baron Kelthur.');
    await maybeSessionBriefing(session, sid, { channelId: 'c1' });
    await maybeSessionBriefing(session, sid, { channelId: 'c1' }); // bot reconnect
    await maybeSessionBriefing(session, sid, { channelId: 'c1' }); // /leave + /join resume
    assert.equal(systemMessages(session).length, 1, 'briefing injected exactly once');
    assert.equal(calls.query.length, 1, 'RAG queried exactly once');
    assert.equal(calls.chat.length, 1, 'briefing text generated exactly once');
    assert.equal(fakeBot.sent.filter((m) => m.briefing).length, 1, 'posted to Discord exactly once');
    dropSession(sid);
  });
});

test('a reconnect racing the first rebuild neither steals nor duplicates the briefing', async () => {
  await withStub({ chunks: [{ text: 'Baron Kelthur herrscht.', source: 'k.md' }] }, async (calls) => {
    const { sid, session } = makeSession('');
    // First session_start: the JSONL rebuild (which fills the summary) is still
    // in flight when the bot reconnects and re-emits session_start.
    let finishRebuild;
    const rebuilding = new Promise((r) => { finishRebuild = r; });
    const first = maybeSessionBriefing(session, sid, { channelId: 'c1', after: rebuilding });
    // The reconnect's rebuild call returns immediately (rebuild already started).
    await maybeSessionBriefing(session, sid, { channelId: 'c1', after: Promise.resolve() });
    assert.equal(calls.query.length, 0, 'reconnect must not query RAG with the still-empty summary');
    session.liveContext.summary = 'Wir trafen Baron Kelthur.';
    finishRebuild();
    await first;
    assert.equal(systemMessages(session).length, 1);
    assert.equal(calls.query.length, 1);
    assert.equal(calls.query[0].query, 'Wir trafen Baron Kelthur.');
    dropSession(sid);
  });
});

test('a failed rebuild skips the briefing without throwing', async () => {
  await withStub({ chunks: [{ text: 'Baron Kelthur herrscht.', source: 'k.md' }] }, async (calls) => {
    const { sid, session } = makeSession('Wir trafen Baron Kelthur.');
    await maybeSessionBriefing(session, sid, { channelId: 'c1', after: Promise.reject(new Error('jsonl kaputt')) });
    assert.equal(session.conversationHistory.length, 0);
    assert.equal(calls.query.length, 0);
    dropSession(sid);
  });
});

test('posts a generated briefing to the join channel when RAG_BRIEFING_POST_CHAT=true', async () => {
  process.env.RAG_BRIEFING_POST_CHAT = 'true';
  await withStub({ chunks: [{ text: 'Baron Kelthur herrscht.', source: 'k.md' }] }, async (calls) => {
    const { sid, session } = makeSession('Wir trafen Baron Kelthur.');
    await maybeSessionBriefing(session, sid, { channelId: 'c42' });
    assert.equal(calls.chat.length, 1);
    const userMsg = calls.chat[0].messages.find((m) => m.role === 'user').content;
    assert.ok(userMsg.includes('Wir trafen Baron Kelthur.'), 'LLM sees the summary');
    assert.ok(userMsg.includes('Baron Kelthur herrscht.'), 'LLM sees the vault context');
    const posts = fakeBot.sent.filter((m) => m.type === 'chat_message');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].channelId, 'c42');
    assert.equal(posts[0].briefing, 'Die Gruppe stand vor dem Tor.');
    dropSession(sid);
  });
});

test('does not touch a session that ended while the briefing was in flight', async () => {
  process.env.RAG_BRIEFING_POST_CHAT = 'true';
  await withStub({ chunks: [{ text: 'Baron Kelthur herrscht.', source: 'k.md' }], ragDelayMs: 100 }, async () => {
    const { sid, session } = makeSession('Wir trafen Baron Kelthur.');
    const p = maybeSessionBriefing(session, sid, { channelId: 'c1' });
    dropSession(sid); // session_end / finalize while RAG is still answering
    await p;
    assert.equal(session.conversationHistory.length, 0);
    assert.equal(fakeBot.sent.length, 0);
  });
});

test('caps the injected vault context at CAMPAIGN_CONTEXT_MAX_CHARS', async () => {
  process.env.CAMPAIGN_CONTEXT_MAX_CHARS = '200';
  // One huge chunk (e.g. a note without any `##` heading).
  const huge = 'Baron Kelthur herrscht. '.repeat(500);
  await withStub({ chunks: [{ text: huge, source: 'npcs/kelthur.md' }] }, async () => {
    const { sid, session } = makeSession('Wir trafen Baron Kelthur.');
    await maybeSessionBriefing(session, sid, { channelId: 'c1' });
    const [msg] = systemMessages(session);
    assert.ok(msg, 'briefing still injected');
    const context = msg.content.slice(msg.content.indexOf('\n') + 1);
    assert.ok(context.length <= 200, `vault context capped (got ${context.length} chars)`);
    assert.ok(context.startsWith('[Quelle: npcs/kelthur.md]'), 'keeps the most relevant (first) chunk');
    dropSession(sid);
  });
});

test('uses a generous timeout off the hot path (cold embedding model at /join)', async () => {
  // Hot-path budget is tiny, but the briefing is fire-and-forget and must not
  // be dropped just because the embedding model needs a moment to load.
  process.env.RAG_TIMEOUT_MS = '50';
  await withStub({ chunks: [{ text: 'Baron Kelthur herrscht.', source: 'k.md' }], ragDelayMs: 300 }, async () => {
    const { sid, session } = makeSession('Wir trafen Baron Kelthur.');
    await maybeSessionBriefing(session, sid, { channelId: 'c1' });
    assert.equal(systemMessages(session).length, 1);
    dropSession(sid);
  });
});

test('briefingConfig reports the effective settings (defaults match the catalog)', () => {
  assert.deepEqual(briefingConfig(), { briefingEnabled: true, briefingTopK: 3, briefingPostChat: false });
  process.env.RAG_BRIEFING_ENABLED = 'false';
  process.env.RAG_BRIEFING_TOP_K = 'abc';
  process.env.RAG_BRIEFING_POST_CHAT = 'true';
  assert.deepEqual(briefingConfig(), { briefingEnabled: false, briefingTopK: 3, briefingPostChat: true });
});
