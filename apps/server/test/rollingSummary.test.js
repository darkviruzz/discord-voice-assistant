import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { summarize, maybeFold, rebuildLiveContext } from '../src/rollingSummary.js';
import { appendLive } from '../src/liveContext.js';

// A scripted stand-in for Ollama's /api/chat: each request is recorded and
// answered with the next scripted reply ({ status, content } or a function).
let server;
let requests;
let script;
let tdir;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const parsed = JSON.parse(body);
      requests.push({ url: req.url, body: parsed });
      let step = script.shift() ?? { content: 'Zusammenfassung.' };
      if (typeof step === 'function') step = await step(parsed);
      res.writeHead(step.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(step.status && step.status !== 200 ? 'model not found' : JSON.stringify({ message: { role: 'assistant', content: step.content } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rolling-summary-'));
});

after(() => {
  server.close();
  fs.rmSync(tdir, { recursive: true, force: true });
});

const ENV = ['OLLAMA_URL', 'OLLAMA_MODEL', 'SUMMARY_MODEL', 'SUMMARY_MAX_CHARS', 'LIVE_CONTEXT_ENABLED',
  'LIVE_RAW_WINDOW_CHARS', 'LIVE_FOLD_CHARS', 'LIVE_FOLD_MIN_INTERVAL_MS', 'TRANSCRIPT_DIR', 'SPEAKER_MAP_FILE'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}/`; // trailing slash is trimmed
  process.env.TRANSCRIPT_DIR = tdir;
  process.env.SPEAKER_MAP_FILE = path.join(tdir, 'no-speaker-map.json');
  requests = [];
  script = [];
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const e = (label, text, startMs, kind = 'user') => ({ label, text, startMs, kind });
const freshSession = () => ({ liveContext: { buffer: [], summary: '', summarizing: false, lastFoldAt: 0, rebuilt: false } });

// ── summarize ────────────────────────────────────────────────────────────────

test('summarize folds the previous summary + segment lines into one /api/chat call', async () => {
  process.env.OLLAMA_MODEL = 'llama3';
  process.env.SUMMARY_MODEL = '  qwen2.5:7b  ';
  script.push({ content: '  Die Gruppe betritt die Höhle.  ' });
  const out = await summarize('Bisher: Ankunft im Dorf.', [e('Greta', 'Wir gehen rein', 1), e('Rabenauge', 'Es ist dunkel.', 2, 'assistant')]);
  assert.equal(out, 'Die Gruppe betritt die Höhle.');
  assert.equal(requests.length, 1);
  const { url, body } = requests[0];
  assert.equal(url, '/api/chat');
  assert.equal(body.model, 'qwen2.5:7b', 'SUMMARY_MODEL (trimmed) wins over OLLAMA_MODEL');
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[1].content, /Bisherige Zusammenfassung:\nBisher: Ankunft im Dorf\./);
  assert.match(body.messages[1].content, /Neue Gesprächsausschnitte:\n\[Greta\] Wir gehen rein\n\[Rabenauge\] Es ist dunkel\./);
});

test('summarize without a previous summary sends only the new lines; falls back to OLLAMA_MODEL', async () => {
  process.env.OLLAMA_MODEL = 'mistral';
  process.env.SUMMARY_MODEL = '   ';
  await summarize('', [e('A', 'x', 1)]);
  assert.equal(requests[0].body.model, 'mistral');
  assert.doesNotMatch(requests[0].body.messages[1].content, /Bisherige/);
});

test('summarize caps the reply at SUMMARY_MAX_CHARS, preferring a sentence boundary', async () => {
  process.env.SUMMARY_MAX_CHARS = '40';
  script.push({ content: 'Die Gruppe erreicht das Tor. Dann folgt noch viel mehr Text.' });
  assert.equal(await summarize('', [e('A', 'x', 1)]), 'Die Gruppe erreicht das Tor.');
  // No sentence end in the last 40 %: cut at a word boundary instead.
  script.push({ content: 'Einwortiger Riesensatz ohne Punkt aber mit vielen Wörtern dazwischen' });
  assert.equal(await summarize('', [e('A', 'x', 1)]), 'Einwortiger Riesensatz ohne Punkt aber');
});

test('summarize throws on HTTP errors and connection failures (callers keep the segment)', async () => {
  script.push({ status: 404 });
  await assert.rejects(() => summarize('', [e('A', 'x', 1)]), /summarize: llm: HTTP 404 \(http:.*\): model not found/);
  process.env.OLLAMA_URL = 'http://127.0.0.1:1';
  await assert.rejects(() => summarize('', [e('A', 'x', 1)]), /summarize: llm: connection failed/);
});

// ── maybeFold ────────────────────────────────────────────────────────────────

function overBudgetSession() {
  process.env.LIVE_RAW_WINDOW_CHARS = '100';
  process.env.LIVE_FOLD_CHARS = '50';
  const s = freshSession();
  for (let i = 0; i < 5; i++) appendLive(s, { label: `P${i}`, text: `Zeile ${i} ${'x'.repeat(20)}`, startMs: i });
  return s; // 5 × ~33 chars ≈ 165 > 100
}

test('maybeFold does nothing while the raw buffer is within budget', async () => {
  process.env.LIVE_RAW_WINDOW_CHARS = '10000';
  const s = freshSession();
  appendLive(s, { label: 'A', text: 'kurz', startMs: 1 });
  await maybeFold(s);
  assert.equal(requests.length, 0);
  assert.equal(s.liveContext.buffer.length, 1);
});

test('maybeFold folds the OLDEST entries into the summary and drops exactly those', async () => {
  const s = overBudgetSession();
  s.liveContext.summary = 'Alt.';
  script.push({ content: 'Neu zusammengefasst.' });
  const t0 = Date.now();
  await maybeFold(s);
  assert.equal(requests.length, 1);
  const sent = requests[0].body.messages[1].content;
  assert.match(sent, /Bisherige Zusammenfassung:\nAlt\./);
  assert.match(sent, /\[P0\] Zeile 0/);
  assert.match(sent, /\[P1\] Zeile 1/);
  assert.doesNotMatch(sent, /\[P2\]/, 'only ~LIVE_FOLD_CHARS worth of oldest lines');
  assert.equal(s.liveContext.summary, 'Neu zusammengefasst.');
  assert.deepEqual(s.liveContext.buffer.map((x) => x.label), ['P2', 'P3', 'P4']);
  assert.ok(s.liveContext.lastFoldAt >= t0);
  assert.equal(s.liveContext.summarizing, false);
});

test('maybeFold keeps the buffer intact when the summarizer fails', async () => {
  const s = overBudgetSession();
  script.push({ status: 500 });
  await maybeFold(s);
  assert.equal(s.liveContext.buffer.length, 5, 'nothing dropped');
  assert.equal(s.liveContext.summary, '');
  assert.equal(s.liveContext.summarizing, false, 'single-flight lock released after failure');
});

test('maybeFold keeps the buffer when the model returns an empty summary (no silent context loss)', async () => {
  const s = overBudgetSession();
  s.liveContext.summary = 'Bisheriger Stand.';
  script.push({ content: '   ' });
  await maybeFold(s);
  assert.equal(s.liveContext.buffer.length, 5, 'segment must not vanish without being summarized');
  assert.equal(s.liveContext.summary, 'Bisheriger Stand.');
});

test('maybeFold is single-flight: overlapping turns trigger one summarizer call', async () => {
  const s = overBudgetSession();
  let release;
  script.push(() => new Promise((r) => { release = () => r({ content: 'Eins.' }); }));
  const a = maybeFold(s);
  const b = maybeFold(s); // second STT turn arrives while the first fold is in flight
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.liveContext.summarizing, true);
  release();
  await Promise.all([a, b]);
  assert.equal(requests.length, 1);
});

test('maybeFold honours LIVE_FOLD_MIN_INTERVAL_MS and LIVE_CONTEXT_ENABLED=false', async () => {
  const s = overBudgetSession();
  process.env.LIVE_FOLD_MIN_INTERVAL_MS = '60000';
  s.liveContext.lastFoldAt = Date.now() - 1000;
  await maybeFold(s);
  assert.equal(requests.length, 0, 'throttled');

  s.liveContext.lastFoldAt = 0;
  process.env.LIVE_CONTEXT_ENABLED = 'false';
  await maybeFold(s);
  assert.equal(requests.length, 0, 'disabled');
  await maybeFold(null); // never throws on a missing session
});

// ── rebuildLiveContext ───────────────────────────────────────────────────────

const SID = '1780058709544';
function writeJsonl(events) {
  fs.writeFileSync(path.join(tdir, `session_${SID}.jsonl`), events.map((x) => JSON.stringify(x)).join('\n') + '\n{broken line\n');
}
function sessionEvents() {
  const base = Number(SID);
  const ev = [{ type: 'session_meta', sessionId: SID, tsMs: base }];
  for (let i = 0; i < 6; i++) {
    ev.push({
      type: 'user_transcript', sessionId: SID, tsMs: base + i * 10_000 + 900, userId: String(100 + i),
      userDisplayName: `Spieler${i}`, startTsMs: base + i * 10_000, endTsMs: base + i * 10_000 + 800,
      text: `Aussage Nummer ${i} über den Drachen.`,
    });
  }
  return ev;
}

test('rebuildLiveContext restores the youngest turns raw and folds the older ones into the summary', async () => {
  process.env.LIVE_RAW_WINDOW_CHARS = '150'; // each rendered line is 46 chars → the youngest 3 fit
  writeJsonl(sessionEvents());
  script.push({ content: 'Frühere Runde: Drachen besprochen.' });
  const s = freshSession();
  await rebuildLiveContext(s, SID);

  const labels = s.liveContext.buffer.map((x) => x.label);
  assert.deepEqual(labels, ['Spieler3', 'Spieler4', 'Spieler5'], 'youngest within the raw window, in order');
  assert.equal(s.liveContext.summary, 'Frühere Runde: Drachen besprochen.');
  assert.equal(requests.length, 1);
  const sent = requests[0].body.messages[1].content;
  for (const i of [0, 1, 2]) assert.match(sent, new RegExp(`\\[Spieler${i}\\] Aussage Nummer ${i}`));
  assert.doesNotMatch(sent, /Spieler3/);
  assert.equal(s.liveContext.rebuilt, true);

  await rebuildLiveContext(s, SID); // runs at most once per session
  assert.equal(requests.length, 1);
});

test('rebuildLiveContext keeps all history raw when the summarizer fails (or returns nothing)', async () => {
  process.env.LIVE_RAW_WINDOW_CHARS = '150';
  writeJsonl(sessionEvents());
  for (const step of [{ status: 503 }, { content: '' }]) {
    script.push(step);
    const s = freshSession();
    await rebuildLiveContext(s, SID);
    assert.equal(s.liveContext.buffer.length, 6, `history kept raw after ${JSON.stringify(step)}`);
    assert.equal(s.liveContext.buffer[0].label, 'Spieler0');
    assert.equal(s.liveContext.summary, '');
  }
});

test('rebuildLiveContext is a no-op for a warm buffer or a session without a log', async () => {
  writeJsonl(sessionEvents());
  const warm = freshSession();
  appendLive(warm, { label: 'Live', text: 'schon da', startMs: 1 });
  await rebuildLiveContext(warm, SID);
  assert.deepEqual(warm.liveContext.buffer.map((x) => x.label), ['Live']);

  const none = freshSession();
  await rebuildLiveContext(none, '424242');
  assert.deepEqual(none.liveContext.buffer, []);
  assert.equal(requests.length, 0);
});
