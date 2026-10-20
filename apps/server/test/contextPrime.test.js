// Prompt priming scheduler (contextPrime.js): one prime per burst of changes,
// none while an answer is being built, no repeat of an unchanged front, and
// the cut of the last primed front for the next answer's split.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createPrimer, primeEnabledFor, primeDelayMs } from '../src/contextPrime.js';

const ENV = ['LLM_PRIME', 'LLM_PRIME_DELAY_MS'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

let primed;
let front;
let failNext;
let gate; // when set, prime() waits for it
beforeEach(() => { primed = []; front = { blocks: ['a'], cut: 'e1' }; failNext = false; gate = null; });

const primer = () => createPrimer({
  buildPrefix: async () => ({ prefix: { blocks: [...front.blocks] }, cut: front.cut }),
  prime: async (prefix) => {
    if (gate) await gate;
    if (failNext) { failNext = false; throw new Error('boom'); }
    primed.push(prefix.blocks.join('|'));
  },
  delayMs: () => 0,
});
const session = () => ({});

test('LLM_PRIME: auto = on for ollama only; true/false force it', () => {
  delete process.env.LLM_PRIME;
  assert.equal(primeEnabledFor('ollama'), true);
  assert.equal(primeEnabledFor('openai'), false);
  process.env.LLM_PRIME = 'true';
  assert.equal(primeEnabledFor('openai'), true);
  process.env.LLM_PRIME = 'off';
  assert.equal(primeEnabledFor('ollama'), false);
});

test('LLM_PRIME_DELAY_MS default 2500, invalid → default, 0 allowed', () => {
  delete process.env.LLM_PRIME_DELAY_MS;
  assert.equal(primeDelayMs(), 2500);
  process.env.LLM_PRIME_DELAY_MS = 'x';
  assert.equal(primeDelayMs(), 2500);
  process.env.LLM_PRIME_DELAY_MS = '0';
  assert.equal(primeDelayMs(), 0);
});

test('a burst of changes is one prime of the latest front; its cut is remembered', async () => {
  const p = primer();
  const s = session();
  assert.equal(p.cutFor(s), null, 'no cut before the first prime');
  p.schedule(s);
  front = { blocks: ['a', 'b'], cut: 'e2' };
  p.schedule(s);
  p.schedule(s);
  await p.idle(s);
  assert.deepEqual(primed, ['a|b']);
  assert.equal(p.cutFor(s), 'e2');
});

test('an unchanged front is not primed again', async () => {
  const p = primer();
  const s = session();
  p.schedule(s);
  await p.idle(s);
  p.schedule(s);
  await p.idle(s);
  assert.deepEqual(primed, ['a']);
});

test('changes during a running prime are primed once afterwards', async () => {
  const p = primer();
  const s = session();
  let open;
  gate = new Promise((r) => { open = r; });
  p.schedule(s);
  await new Promise((r) => setTimeout(r, 10)); // the first prime is now waiting at the gate
  front = { blocks: ['a', 'b'], cut: 'e2' };
  p.schedule(s);
  front = { blocks: ['a', 'b', 'c'], cut: 'e3' };
  p.schedule(s);
  gate = null;
  open();
  await p.idle(s);
  assert.deepEqual(primed, ['a', 'a|b|c']);
  assert.equal(p.cutFor(s), 'e3');
});

test('nothing is primed while an answer is being built; pending changes follow it', async () => {
  const p = primer();
  const s = session();
  p.answerStarted(s);
  p.schedule(s);
  await new Promise((r) => setTimeout(r, 10));
  await p.idle(s);
  assert.deepEqual(primed, [], 'no prime during the answer');
  front = { blocks: ['a', 'reply'], cut: 'e2' };
  p.answerFinished(s);
  await p.idle(s);
  assert.deepEqual(primed, ['a|reply']);
});

test('an answer without changes does not trigger a prime', async () => {
  const p = primer();
  const s = session();
  p.schedule(s);
  await p.idle(s);
  p.answerStarted(s);
  p.answerFinished(s);
  await p.idle(s);
  assert.deepEqual(primed, ['a']);
});

test('a failed prime does not throw and is retried on the next change', async () => {
  const p = primer();
  const s = session();
  failNext = true;
  p.schedule(s);
  await p.idle(s);
  assert.deepEqual(primed, []);
  assert.equal(p.cutFor(s), null, 'the cut only moves with a successful prime');
  p.schedule(s);
  await p.idle(s);
  assert.deepEqual(primed, ['a']);
});

test('disabled → nothing is scheduled', async () => {
  const p = createPrimer({
    buildPrefix: async () => ({ prefix: ['x'], cut: null }),
    prime: async () => primed.push('x'),
    enabled: () => false,
    delayMs: () => 0,
  });
  const s = session();
  p.schedule(s);
  await p.idle(s);
  assert.deepEqual(primed, []);
});
