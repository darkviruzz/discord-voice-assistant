// LLM_PROMPT_BUDGET_CHARS: the trim order and minimums (fitPrompt with a fake
// measure), and the answer prompt built from fake sessions, a fake archive and
// fake RAG hits (answerPrompt.js): the front is trimmed ahead of time for the
// prime, the answer trims its tail first and keeps the primed front, dropped
// session summaries stay dropped, and a trim change is logged once.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fitPrompt, promptBudgetChars, kChars } from '../src/promptBudget.js';
import { createAnswerPrompt, TAIL_RESERVE_CHARS } from '../src/answerPrompt.js';
import { answerMessages, promptChars } from '../src/llm.js';
import { resetLastSessionCache } from '../src/lastSession.js';

// ── fitPrompt (pure) ─────────────────────────────────────────────────────────

// Fake prompt: 1000 fixed + 2000 per session + 500 per turn + 1000 per hit +
// the live parts (as capped).
const LIVE = 3000;
const FRESH = 400;
function fakeMeasure(calls = []) {
  return (plan) => {
    calls.push({ ...plan });
    const live = Math.min(LIVE, plan.live);
    const fresh = Math.min(FRESH, plan.fresh);
    return { chars: 1000 + plan.sessions * 2000 + plan.history * 500 + plan.rag * 1000 + live + fresh, live, fresh };
  };
}
const START = { sessions: 3, history: 10, rag: 3, live: Infinity, fresh: Infinity };
const ORDER = ['sessions', 'history', 'rag', 'live', 'fresh'];
// Untrimmed: 1000 + 6000 + 5000 + 3000 + 3000 + 400 = 18400.

test('fitPrompt: within budget or budget 0 → untouched', () => {
  for (const budget of [18400, 0]) {
    const { plan, chars } = fitPrompt({ budget, start: START, measure: fakeMeasure(), order: ORDER });
    assert.deepEqual(plan, START);
    assert.equal(chars, 18400);
  }
});

test('fitPrompt: trims one key after the other and stops as soon as it fits', () => {
  // 1.5k over → two sessions go (one is not enough), nothing else.
  let r = fitPrompt({ budget: 16900, start: START, measure: fakeMeasure(), order: ORDER });
  assert.deepEqual(r.plan, { ...START, sessions: 2 });
  r = fitPrompt({ budget: 14000, start: START, measure: fakeMeasure(), order: ORDER });
  assert.deepEqual(r.plan, { ...START, sessions: 1, history: 9 }, 'sessions down to 1, then the history');
  r = fitPrompt({ budget: 10000, start: START, measure: fakeMeasure(), order: ORDER });
  assert.deepEqual(r.plan, { ...START, sessions: 1, history: 2, rag: 2 }, 'history down to 2, then RAG');
  assert.equal(r.chars, 9400);
});

test('fitPrompt: minimums 1 session / 2 turns / 1 hit, then the live parts by the overflow', () => {
  const calls = [];
  const r = fitPrompt({ budget: 6500, start: START, measure: fakeMeasure(calls), order: ORDER });
  // At the minimums: 1000 + 2000 + 1000 + 1000 + 3000 + 400 = 8400 → 1900 over.
  assert.equal(r.plan.sessions, 1);
  assert.equal(r.plan.history, 2);
  assert.equal(r.plan.rag, 1);
  assert.equal(r.plan.live, 3000 - 1900, 'the primed live part is cut by the overflow in one step');
  assert.equal(r.plan.fresh, Infinity, 'the newest lines are not touched while the rest fits');
  assert.equal(r.chars, 6500);
  assert.equal(calls.filter((c) => c.live !== Infinity).length, 1);

  const tiny = fitPrompt({ budget: 1000, start: START, measure: fakeMeasure(), order: ORDER });
  assert.deepEqual(tiny.plan, { sessions: 1, history: 2, rag: 1, live: 0, fresh: 0 });
  assert.equal(tiny.chars, 1000 + 2000 + 1000 + 1000, 'still over the budget when everything is at its minimum');
});

test('fitPrompt: the order decides — tail first leaves sessions and history alone', () => {
  const r = fitPrompt({ budget: 16400, start: START, measure: fakeMeasure(), order: ['rag', 'sessions', 'history', 'live', 'fresh'] });
  assert.deepEqual(r.plan, { ...START, rag: 1 });
});

test('LLM_PROMPT_BUDGET_CHARS: default 22000, 0/invalid = off', () => {
  const saved = process.env.LLM_PROMPT_BUDGET_CHARS;
  try {
    delete process.env.LLM_PROMPT_BUDGET_CHARS;
    assert.equal(promptBudgetChars(), 22000);
    process.env.LLM_PROMPT_BUDGET_CHARS = '0';
    assert.equal(promptBudgetChars(), 0);
    process.env.LLM_PROMPT_BUDGET_CHARS = 'viel';
    assert.equal(promptBudgetChars(), 0);
    process.env.LLM_PROMPT_BUDGET_CHARS = '18000';
    assert.equal(promptBudgetChars(), 18000);
  } finally {
    if (saved === undefined) delete process.env.LLM_PROMPT_BUDGET_CHARS; else process.env.LLM_PROMPT_BUDGET_CHARS = saved;
  }
  assert.equal(kChars(23400), '23.4k');
  assert.equal(kChars(22000), '22k');
});

// ── answerPrompt.js with fakes ───────────────────────────────────────────────

const KEYS = ['ARCHIVE_DIR', 'FINALIZE_TZ', 'LAST_SESSION_CONTEXT_ENABLED', 'LAST_SESSION_CONTEXT_COUNT',
  'LAST_SESSION_CONTEXT_MAX_CHARS', 'LLM_PROMPT_BUDGET_CHARS', 'SYSTEM_PROMPT', 'SYSTEM_PROMPT_FILE',
  'LIVE_CONTEXT_ENABLED', 'LIVE_RENDER_MAX_CHARS', 'HISTORY_TURNS', 'OBSIDIAN_VAULT_PATH', 'RAG_ENABLED',
  'CAMPAIGN_CONTEXT_MAX_CHARS', 'CAMPAIGN_CONTEXT_FILE'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-budget-'));
after(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(root, { recursive: true, force: true });
});

function archive(dir, name, startMs, text) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'manifest.json'), JSON.stringify({ sessionStartMs: startMs }));
  fs.writeFileSync(path.join(dir, name, 'summary.md'), text);
}

// Sizes: persona 1000, three summaries sharing 6000 (~2000 each), RAG cap
// 3000 (three 900-char hits), live lines of ~100 chars, turns of ~200 chars.
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  const dir = fs.mkdtempSync(path.join(root, 'archive-'));
  archive(dir, 's1', Date.UTC(2026, 9, 1, 18), 'Ardo kämpfte am Fluss. '.repeat(100));
  archive(dir, 's2', Date.UTC(2026, 9, 8, 18), 'Bela fand die Karte. '.repeat(110));
  archive(dir, 's3', Date.UTC(2026, 9, 15, 18), 'Cora verhandelte im Hafen. '.repeat(90));
  Object.assign(process.env, {
    ARCHIVE_DIR: dir,
    FINALIZE_TZ: 'Europe/Berlin',
    LAST_SESSION_CONTEXT_COUNT: '3',
    LAST_SESSION_CONTEXT_MAX_CHARS: '6000',
    SYSTEM_PROMPT: `Du bist Rabenauge. ${'x'.repeat(981)}`,
    HISTORY_TURNS: '10',
    OBSIDIAN_VAULT_PATH: root, // RAG on; the hits come from the fake below
    CAMPAIGN_CONTEXT_MAX_CHARS: '3000',
    LLM_PROMPT_BUDGET_CHARS: '14000',
  });
  resetLastSessionCache();
});

const HITS = ['beste', 'zweite', 'dritte'].map((w) => `[Quelle: ${w}.md]\n${`${w} Notiz. `.repeat(200)}`.slice(0, 900));

function builder(lines = []) {
  return createAnswerPrompt({ campaignParts: async () => HITS, campaignStatic: async () => '', log: (l) => lines.push(l) });
}

function liveLine(i) {
  return { label: 'Greta', text: `Zeile ${String(i).padStart(3, '0')}: wir schleichen durch den Gang und lauschen an jeder Tür ganz leise.`, startMs: i, kind: 'user' };
}

function fakeSession({ lines = 10, turns = 4 } = {}) {
  const buffer = Array.from({ length: lines }, (_, i) => liveLine(i));
  const conversationHistory = [];
  for (let i = 0; i < turns; i++) {
    conversationHistory.push(
      { role: 'user', content: `Frage ${i}: wie heißt der Wirt in der Taverne am Hafen?` },
      { role: 'assistant', content: `Antwort ${i}: Der Wirt heißt Borin, ein Zwerg mit einem Bart bis zum Gürtel, der jeden Gast mit Namen begrüßt und nie vergisst.` },
    );
  }
  return { liveContext: { buffer, summary: `Die Gruppe ist in Saltmarsh. ${'Sie sucht das Schmugglerversteck. '.repeat(14)}` }, conversationHistory };
}

const lastSessionBlockOf = (blocks) => blocks.find((b) => b.startsWith('Zusammenfassung') || b.startsWith('Zusammenfassungen'));
const sessionDates = (blocks) => [...lastSessionBlockOf(blocks).matchAll(/\((\d\d\.\d\d\.2026)\)/g)].map((m) => m[1]);
const liveBlockOf = (blocks) => blocks.find((b) => b.startsWith('Aktuelles Live-Transkript'));
const chars = (prompt, query) => promptChars(answerMessages(prompt.systemBlocks, prompt.history, query, prompt.contextBlocks));

test('early in a session everything fits: three sessions, full history, all hits', async () => {
  const lines = [];
  const prompts = builder(lines);
  const session = fakeSession();
  const front = await prompts.front(session);
  assert.deepEqual(sessionDates(front.systemBlocks), ['15.10.2026', '08.10.2026', '01.10.2026']);
  assert.equal(front.history.length, 8);
  const answer = await prompts.answer(session, session.conversationHistory, 'wer ist Borin?', { cut: front.last, primed: true });
  assert.deepEqual(answer.systemBlocks, front.systemBlocks);
  assert.equal(answer.contextBlocks.at(-1).split('[Quelle:').length - 1, 3, 'all three RAG hits');
  assert.deepEqual(lines, [], 'nothing trimmed → nothing logged');
});

test('a growing live transcript drops the oldest session at the prime; the answer keeps that front', async () => {
  const lines = [];
  const prompts = builder(lines);
  const session = fakeSession({ lines: 30 });
  const front = await prompts.front(session);
  assert.deepEqual(sessionDates(front.systemBlocks), ['15.10.2026', '08.10.2026'], 'oldest summary dropped ahead of time');
  assert.equal(front.history.length, 8, 'history untouched: the sessions go first');
  assert.match(liveBlockOf(front.systemBlocks), /Zeile 000/, 'live transcript untouched');

  // The question's own line arrives after the prime.
  session.liveContext.buffer.push(liveLine(30));
  const query = 'wer ist Borin?';
  const answer = await prompts.answer(session, session.conversationHistory, query, { cut: front.last, primed: true });
  assert.deepEqual(answer.systemBlocks, front.systemBlocks, 'the answer starts with the primed front');
  assert.deepEqual(answer.history, front.history);
  assert.match(answer.contextBlocks[0], /^Neueste Beiträge im Live-Transkript \(Fortsetzung\):\n\[Greta\] Zeile 030/);
  assert.equal(answer.contextBlocks[1].split('[Quelle:').length - 1, 3, 'the reserve covers all three hits');
  assert.ok(chars(answer, query) <= 14000);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^prompt budget: [\d.]+k ≤ 14k chars — dropped session 01\.10\.2026 → [\d.]+k \(front kept short for the prime\)$/);
});

test('a tail bigger than the reserve drops the weakest RAG hits first, then touches the front', async () => {
  const prompts = builder();
  const session = fakeSession({ lines: 30 });
  const front = await prompts.front(session);
  // Many lines since the last prime: ~2.8k of fresh lines, well over TAIL_RESERVE_CHARS.
  for (let i = 30; i < 62; i++) session.liveContext.buffer.push(liveLine(i));
  assert.ok(32 * 89 > TAIL_RESERVE_CHARS);
  const query = 'was ist hinter der Tür?';
  const answer = await prompts.answer(session, session.conversationHistory, query, { cut: front.last, primed: true });
  assert.deepEqual(answer.systemBlocks, front.systemBlocks, 'front unchanged');
  assert.deepEqual(answer.history, front.history);
  const rag = answer.contextBlocks.find((b) => b.startsWith('Kampagnen-Kontext'));
  assert.ok(rag.includes('beste.md') && !rag.includes('dritte.md'), 'the weakest hit went');
  assert.ok(chars(answer, query) <= 14000);

  // Far more fresh lines: RAG down to one hit, then the front (sessions first).
  for (let i = 62; i < 100; i++) session.liveContext.buffer.push(liveLine(i));
  const big = await prompts.answer(session, session.conversationHistory, query, { cut: front.last, primed: true });
  const bigRag = big.contextBlocks.find((b) => b.startsWith('Kampagnen-Kontext'));
  assert.ok(bigRag.includes('beste.md') && !bigRag.includes('zweite.md'), 'one hit stays');
  assert.deepEqual(sessionDates(big.systemBlocks), ['15.10.2026']);
  assert.ok(chars(big, query) <= 14000);
});

test('minimums: one session, two turns, one hit; the live transcript loses its oldest lines', async () => {
  process.env.LLM_PROMPT_BUDGET_CHARS = '6400';
  const prompts = builder();
  const session = fakeSession({ lines: 30, turns: 10 });
  const query = 'wer ist Borin?';
  const answer = await prompts.answer(session, session.conversationHistory, query, { primed: false });
  assert.deepEqual(sessionDates(answer.systemBlocks), ['15.10.2026'], 'the newest summary stays');
  assert.deepEqual(answer.history.map((m) => m.content.slice(0, 9)), ['Frage 8: ', 'Antwort 8', 'Frage 9: ', 'Antwort 9']);
  const rag = answer.contextBlocks.find((b) => b.startsWith('Kampagnen-Kontext'));
  assert.ok(rag.includes('beste.md') && !rag.includes('zweite.md'));
  const live = liveBlockOf(answer.systemBlocks);
  assert.ok(live.endsWith(liveLine(29).text), 'the newest line stays');
  assert.ok(!live.includes('Zeile 000'), 'the oldest lines went');
  assert.ok(chars(answer, query) <= 6400);
});

test('hysteresis: a dropped session stays dropped in that voice session, a new session starts with all', async () => {
  const prompts = builder();
  const session = fakeSession({ lines: 30 });
  assert.deepEqual(sessionDates((await prompts.front(session)).systemBlocks), ['15.10.2026', '08.10.2026']);
  // A fold shrinks the live transcript: the front would fit with three again.
  session.liveContext.buffer.splice(0, 25);
  const after = await prompts.front(session);
  assert.deepEqual(sessionDates(after.systemBlocks), ['15.10.2026', '08.10.2026'], 'not re-added');
  const answer = await prompts.answer(session, session.conversationHistory, 'und jetzt?', { cut: after.last, primed: true });
  assert.deepEqual(answer.systemBlocks, after.systemBlocks);

  const next = fakeSession({ lines: 5 });
  assert.equal(sessionDates((await prompts.front(next)).systemBlocks).length, 3, 'a new voice session');
});

test('without priming: one pass over the real prompt, no reserve', async () => {
  const prompts = builder();
  const session = fakeSession({ lines: 30 });
  // The real tail (three hits, a short question) is smaller than the reserve:
  // with priming the oldest session goes, without it the prompt fits as is.
  const answer = await prompts.answer(session, session.conversationHistory, 'wer?', { primed: false });
  assert.equal(sessionDates(answer.systemBlocks).length, 3);
  assert.ok(chars(answer, 'wer?') <= 14000);
});

test('a text query outside a voice session is budgeted too, without hysteresis', async () => {
  process.env.LLM_PROMPT_BUDGET_CHARS = '8000';
  const prompts = builder();
  const history = fakeSession({ turns: 10 }).conversationHistory;
  const a = await prompts.answer(null, history, 'wer ist Borin?');
  assert.ok(sessionDates(a.systemBlocks).length < 3);
  assert.ok(chars(a, 'wer ist Borin?') <= 8000);
  process.env.LLM_PROMPT_BUDGET_CHARS = '30000';
  const b = await prompts.answer(null, history, 'wer ist Borin?');
  assert.equal(sessionDates(b.systemBlocks).length, 3, 'nothing sticks without a voice session');
});

test('budget 0: the untrimmed prompt', async () => {
  process.env.LLM_PROMPT_BUDGET_CHARS = '0';
  const prompts = builder();
  const session = fakeSession({ lines: 60, turns: 10 });
  const front = await prompts.front(session);
  const answer = await prompts.answer(session, session.conversationHistory, 'wer?', { cut: front.last, primed: true });
  assert.equal(sessionDates(answer.systemBlocks).length, 3);
  assert.equal(answer.history.length, 20);
  assert.match(liveBlockOf(answer.systemBlocks), /Zeile 000/);
  assert.ok(chars(answer, 'wer?') > 14000);
});

test('one INFO line when the trimming changes, none while it stays the same', async () => {
  const lines = [];
  const prompts = builder(lines);
  const session = fakeSession({ lines: 30 });
  const ask = async () => {
    const front = await prompts.front(session);
    return prompts.answer(session, session.conversationHistory, 'wer?', { cut: front.last, primed: true });
  };
  await ask();
  await ask();
  await ask();
  assert.equal(lines.length, 1, 'logged once');
  assert.match(lines[0], /dropped session 01\.10\.2026/);
  for (let i = 30; i < 70; i++) session.liveContext.buffer.push(liveLine(i));
  await ask();
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^prompt budget: [\d.]+k > 14k chars — dropped sessions 08\.10\.2026, 01\.10\.2026, history 4→\d → [\d.]+k$/);
  await ask();
  assert.equal(lines.length, 2);
});
