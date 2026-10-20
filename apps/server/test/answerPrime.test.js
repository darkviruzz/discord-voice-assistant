// Answer prompt layout + priming through the real pipeline (a session-bound
// typed question takes the same answerQuestion path as a wake-word question):
// the prime is exactly the front of the next answer prompt, the question's own
// transcript line goes into the tail next to the question, and the reply is
// primed afterwards. This is what lets the LLM server's prompt cache skip the
// front (see contextPrime.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTextPipeline, _internal } from '../src/pipeline.js';
import { ensureSession, sessions } from '../src/state.js';
import { appendLive } from '../src/liveContext.js';
import { ANSWER_SCHEMA, promptChars } from '../src/llm.js';
import { resetLastSessionCache } from '../src/lastSession.js';

const { primer } = _internal;
const KEYS = ['LLM_PROVIDER', 'OLLAMA_URL', 'OLLAMA_MODEL', 'LLM_TIMEOUT_MS', 'TRANSCRIPT_DIR', 'ARCHIVE_DIR',
  'OBSIDIAN_VAULT_PATH', 'DISCORD_POST_REPLIES', 'LIVE_CONTEXT_ENABLED', 'LLM_PRIME', 'LLM_PRIME_DELAY_MS',
  'HISTORY_TURNS', 'LLM_JSON_FORMAT', 'LLM_PROMPT_BUDGET_CHARS', 'LAST_SESSION_CONTEXT_COUNT',
  'LAST_SESSION_CONTEXT_MAX_CHARS', 'FINALIZE_TZ'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-prime-'));

const bodies = [];
const llm = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    bodies.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { content: '{"text":"Nur die alte Tür im Wind.","speaker_id":7,"model":"emotional"}' } }));
  });
});

before(async () => {
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  for (const k of KEYS) delete process.env[k];
  process.env.OLLAMA_URL = `http://127.0.0.1:${llm.address().port}`;
  process.env.TRANSCRIPT_DIR = path.join(tmp, 'transcripts');
  process.env.ARCHIVE_DIR = path.join(tmp, 'archive');
  process.env.LLM_TIMEOUT_MS = '2000';
  process.env.LLM_PRIME_DELAY_MS = '0';
});

after(() => {
  llm.close();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function waitFor(n) {
  for (let i = 0; i < 200 && bodies.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(bodies.length, n, `${n} LLM requests`);
}

test('prime = front of the answer prompt; own line + question in the tail; reply primed after', async () => {
  const sid = 4242n;
  const session = ensureSession(sid);
  try {
    session.liveContext.summary = 'Die Gruppe hat Saltmarsh erreicht.';
    appendLive(session, { label: 'Fabi (Rhogar)', text: 'Wir gehen zum alten Haus.', startMs: 1 });
    appendLive(session, { label: 'Markus', text: 'Die Tür knarrt im Wind.', startMs: 2 });
    primer.schedule(session);
    await waitFor(1);
    await primer.idle(session);
    const prime = bodies[0];
    assert.equal(prime.options?.num_predict, 1, 'one generated token');
    assert.deepEqual(prime.format, ANSWER_SCHEMA);
    assert.match(prime.messages.at(-1).content, /^Aktuelles Live-Transkript der Runde:\n\[Fabi \(Rhogar\)\] Wir gehen zum alten Haus\.\n\[Markus\] Die Tür knarrt im Wind\.$/);

    // The question's own line is in the buffer before the answer is built.
    appendLive(session, { label: 'Greta', text: 'Rabenauge, was knarrt da?', startMs: 3 });
    await runTextPipeline({ sessionId: String(sid), question: 'was knarrt da?', channelId: 'c1', source: 'slash' });
    await waitFor(2);
    const answer = bodies[1];
    assert.deepEqual(answer.messages.slice(0, -1), prime.messages, 'the answer starts with exactly the primed front');
    assert.equal(answer.messages.at(-1).role, 'user');
    assert.equal(answer.messages.at(-1).content,
      'Neueste Beiträge im Live-Transkript (Fortsetzung):\n[Greta] Rabenauge, was knarrt da?\n\nFrage: was knarrt da?');
    assert.equal(answer.options, undefined, 'the answer itself is not cut to one token');

    // The reply lands in the live transcript and the history → primed next.
    await waitFor(3);
    await primer.idle(session);
    const next = bodies[2];
    assert.equal(next.options?.num_predict, 1);
    const live = next.messages.find((m) => m.content.startsWith('Aktuelles Live-Transkript'));
    assert.match(live.content, /\[Greta\] Rabenauge, was knarrt da\?\n\[Rabenauge\] Nur die alte Tür im Wind\.$/);
    assert.deepEqual(next.messages.slice(-2), [
      { role: 'user', content: 'was knarrt da?' },
      { role: 'assistant', content: 'Nur die alte Tür im Wind.' },
    ], 'the recent history closes the primed front');
    assert.equal(primer.cutFor(session), session.liveContext.buffer.at(-1));
  } finally {
    // A failed assertion can leave a prime pending. It must not run once
    // after() has restored OLLAMA_URL: it would load a model on a real Ollama.
    process.env.LLM_PRIME = 'false';
    await new Promise((r) => setTimeout(r, 20));
    await primer.idle(session);
    sessions.delete(sid);
  }
});

// LLM_PROMPT_BUDGET_CHARS (answerPrompt.js): the prime already sends the
// trimmed front, so the answer still resumes from it.
test('prompt budget: the prime sends the trimmed front, the answer starts with exactly it', async () => {
  const sid = 4343n;
  delete process.env.LLM_PRIME; // the first test switched it off on its way out
  Object.assign(process.env, {
    LLM_PROMPT_BUDGET_CHARS: '9000', HISTORY_TURNS: '10', FINALIZE_TZ: 'Europe/Berlin',
    LAST_SESSION_CONTEXT_COUNT: '3', LAST_SESSION_CONTEXT_MAX_CHARS: '6000',
  });
  ['01', '08', '15'].forEach((day, i) => {
    const dir = path.join(process.env.ARCHIVE_DIR, `2026-10-${day}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sessionStartMs: Date.UTC(2026, 9, Number(day), 18) }));
    fs.writeFileSync(path.join(dir, 'summary.md'), `Sitzung ${i + 1}: die Gruppe zog weiter nach Norden. `.repeat(60));
  });
  resetLastSessionCache();
  const session = ensureSession(sid);
  const base = bodies.length;
  try {
    for (let i = 0; i < 10; i++) {
      session.conversationHistory.push({ role: 'user', content: `Frage ${i}?` }, { role: 'assistant', content: `Antwort ${i}: so war es.` });
    }
    for (let i = 0; i < 40; i++) appendLive(session, { label: 'Greta', text: `Zeile ${i}: wir gehen weiter durch den Gang.`, startMs: 10 + i });
    primer.schedule(session);
    await waitFor(base + 1);
    await primer.idle(session);
    const prime = bodies[base];
    const dates = prime.messages.map((m) => m.content).join('\n').match(/\(\d\d\.10\.2026\)/g);
    assert.equal(dates[0], '(15.10.2026)', 'the newest summary stays');
    assert.ok(!dates.includes('(01.10.2026)'), 'the oldest dropped ahead of time');
    assert.equal(prime.messages.filter((m) => m.role !== 'system').length, 20, 'the history stays whole');

    appendLive(session, { label: 'Greta', text: 'Rabenauge, wohin führt der Gang?', startMs: 100 });
    await runTextPipeline({ sessionId: String(sid), question: 'wohin führt der Gang?', channelId: 'c1', source: 'slash' });
    await waitFor(base + 2);
    const answer = bodies[base + 1];
    assert.deepEqual(answer.messages.slice(0, -1), prime.messages, 'the answer starts with exactly the primed front');
    assert.ok(promptChars(answer.messages) <= 9000, `${promptChars(answer.messages)} chars`);
  } finally {
    process.env.LLM_PRIME = 'false';
    await new Promise((r) => setTimeout(r, 20));
    await primer.idle(session);
    sessions.delete(sid);
  }
});
