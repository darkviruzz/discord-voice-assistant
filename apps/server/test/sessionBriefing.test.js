import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { maybeSessionBriefing } from '../src/sessionBriefing.js';

let savedEnv;

beforeEach(() => {
  savedEnv = {
    RAG_URL: process.env.RAG_URL,
    RAG_BRIEFING_ENABLED: process.env.RAG_BRIEFING_ENABLED,
    RAG_BRIEFING_POST_CHAT: process.env.RAG_BRIEFING_POST_CHAT,
  };
  delete process.env.RAG_URL;
  delete process.env.RAG_BRIEFING_ENABLED;
  delete process.env.RAG_BRIEFING_POST_CHAT;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function withRagServer(chunks, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(chunks));
      });
    });
    server.listen(0, '127.0.0.1', async () => {
      process.env.RAG_URL = `http://127.0.0.1:${server.address().port}`;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally { server.close(); }
    });
  });
}

function makeSession(summary) {
  return { liveContext: { summary }, conversationHistory: [] };
}

test('no-op when RAG is unconfigured', async () => {
  const session = makeSession('Die Gruppe steht vor dem Tor.');
  await maybeSessionBriefing(session, 1n, { channelId: 'c1' });
  assert.equal(session.conversationHistory.length, 0);
});

test('no-op when there is no prior summary', async () => {
  await withRagServer([{ text: 'irrelevant', source: 'x.md' }], async () => {
    const session = makeSession('   ');
    await maybeSessionBriefing(session, 1n, { channelId: 'c1' });
    assert.equal(session.conversationHistory.length, 0);
  });
});

test('no-op when briefing is disabled', async () => {
  process.env.RAG_BRIEFING_ENABLED = 'false';
  await withRagServer([{ text: 'Baron Kelthur.', source: 'k.md' }], async () => {
    const session = makeSession('Wir trafen Baron Kelthur.');
    await maybeSessionBriefing(session, 1n, { channelId: 'c1' });
    assert.equal(session.conversationHistory.length, 0);
  });
});

test('injects vault context as a leading system message', async () => {
  await withRagServer([{ text: 'Baron Kelthur herrscht.', source: 'npcs/kelthur.md' }], async () => {
    const session = makeSession('Wir trafen Baron Kelthur.');
    session.conversationHistory.push({ role: 'user', content: 'hallo' });
    await maybeSessionBriefing(session, 1n, { channelId: 'c1' });
    assert.equal(session.conversationHistory[0].role, 'system');
    assert.ok(session.conversationHistory[0].content.includes('Baron Kelthur herrscht.'));
    assert.ok(session.conversationHistory[0].content.includes('letzte'));
    // existing history is preserved after the prepended briefing
    assert.equal(session.conversationHistory[1].content, 'hallo');
  });
});
