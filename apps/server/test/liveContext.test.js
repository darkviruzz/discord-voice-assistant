import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderForLlm, windowChars, selectFoldSegment, splitForRebuild,
  makeEntry, appendLive, renderLiveContext, removeEntries,
  liveContextEnabled, rawWindowChars, foldChars, _internal,
} from '../src/liveContext.js';

const { lineFor } = _internal;

function entry(label, text, startMs, kind = 'user') {
  return { label, text, startMs, kind };
}

// ── pure render helpers ───────────────────────────────────────────────────────

test('renderForLlm renders "[Label] text" lines in order', () => {
  const out = renderForLlm([
    entry('Greta', 'Hallo', 1),
    entry('Rabenauge', 'Willkommen', 2, 'assistant'),
  ]);
  assert.equal(out, '[Greta] Hallo\n[Rabenauge] Willkommen');
});

test('renderForLlm drops OLDEST lines when over the char budget', () => {
  const entries = [
    entry('A', 'erste-zeile', 1),
    entry('B', 'zweite-zeile', 2),
    entry('C', 'dritte-zeile', 3),
  ];
  // Budget large enough for only the last two lines.
  const budget = lineFor(entries[1]).length + 1 + lineFor(entries[2]).length + 1;
  assert.equal(renderForLlm(entries, budget), '[B] zweite-zeile\n[C] dritte-zeile', 'oldest line dropped');
  assert.equal(renderForLlm(entries, budget - 1), '[C] dritte-zeile', 'one char less → only the newest fits');
  assert.equal(renderForLlm(entries, 3), '', 'not even the newest line fits');
});

test('renderForLlm returns empty string for non-positive budget', () => {
  assert.equal(renderForLlm([entry('A', 'x', 1)], 0), '');
});

test('windowChars counts each line plus a newline', () => {
  const entries = [entry('A', 'hi', 1), entry('B', 'yo', 2)];
  const expected = lineFor(entries[0]).length + 1 + lineFor(entries[1]).length + 1;
  assert.equal(windowChars(entries), expected);
});

// ── fold selection ────────────────────────────────────────────────────────────

test('selectFoldSegment returns oldest entries up to target, never the whole buffer', () => {
  const entries = [
    entry('A', 'x'.repeat(50), 1),
    entry('B', 'y'.repeat(50), 2),
    entry('C', 'z'.repeat(50), 3),
  ];
  // Each line renders to 55 chars incl. newline: 60 needs the two oldest.
  assert.deepEqual(selectFoldSegment(entries, 60), [entries[0], entries[1]]);
  assert.deepEqual(selectFoldSegment(entries, 55), [entries[0]], 'stops as soon as the target is reached');
  assert.deepEqual(selectFoldSegment(entries, 1e9), [entries[0], entries[1]], 'never the newest entry');
  assert.equal(selectFoldSegment(entries, 60)[0], entries[0], 'identity preserved (removeEntries relies on it)');
});

test('selectFoldSegment returns [] when one or zero entries', () => {
  assert.deepEqual(selectFoldSegment([], 100), []);
  assert.deepEqual(selectFoldSegment([entry('A', 'x', 1)], 100), []);
});

test('splitForRebuild keeps youngest within budget, folds the rest', () => {
  const entries = [
    entry('A', 'a'.repeat(30), 1),
    entry('B', 'b'.repeat(30), 2),
    entry('C', 'c'.repeat(30), 3),
  ];
  const keep = lineFor(entries[2]).length + 1; // room for only the youngest
  assert.deepEqual(splitForRebuild(entries, keep), { older: [entries[0], entries[1]], younger: [entries[2]] });
  assert.deepEqual(splitForRebuild(entries, keep * 3), { older: [], younger: entries }, 'everything fits');
  assert.deepEqual(splitForRebuild(entries, 0), { older: entries, younger: [] }, 'zero budget folds all');
});

// ── makeEntry normalization ───────────────────────────────────────────────────

test('makeEntry normalizes whitespace and sets kind', () => {
  const e = makeEntry({ label: 'Greta', text: '  Hallo\n  Welt ', startMs: 5, kind: 'assistant' });
  assert.equal(e.text, 'Hallo Welt');
  assert.equal(e.label, 'Greta');
  assert.equal(e.kind, 'assistant');
  assert.equal(e.startMs, 5);
});

test('makeEntry drops bracket-only / empty text', () => {
  assert.equal(makeEntry({ label: 'A', text: '[Musik]', startMs: 1 }), null);
  assert.equal(makeEntry({ label: 'A', text: '   ', startMs: 1 }), null);
  assert.equal(makeEntry({ label: 'A', text: null, startMs: 1 }), null);
});

test('makeEntry defaults: label "Spieler", kind "user", missing startMs → now', () => {
  const before = Date.now();
  const e = makeEntry({ text: 'hallo', kind: 'system', startMs: NaN });
  assert.equal(e.label, 'Spieler');
  assert.equal(e.kind, 'user', 'only "assistant" is kept as a distinct kind');
  assert.ok(e.startMs >= before && e.startMs <= Date.now());
});

// ── stateful ops over a session ───────────────────────────────────────────────

function fakeSession() {
  return { liveContext: { buffer: [], summary: '', summarizing: false, lastFoldAt: 0, rebuilt: false } };
}

let savedEnv;
beforeEach(() => { savedEnv = process.env.LIVE_CONTEXT_ENABLED; });
afterEach(() => {
  if (savedEnv === undefined) delete process.env.LIVE_CONTEXT_ENABLED;
  else process.env.LIVE_CONTEXT_ENABLED = savedEnv;
});

test('appendLive keeps the buffer sorted by startMs', () => {
  const s = fakeSession();
  appendLive(s, { label: 'A', text: 'spät', startMs: 100 });
  appendLive(s, { label: 'B', text: 'früh', startMs: 50 });
  assert.deepEqual(s.liveContext.buffer.map((e) => e.text), ['früh', 'spät']);
});

test('appendLive is a no-op when disabled', () => {
  process.env.LIVE_CONTEXT_ENABLED = 'false';
  assert.equal(liveContextEnabled(), false);
  const s = fakeSession();
  assert.equal(appendLive(s, { label: 'A', text: 'x', startMs: 1 }), null);
  assert.equal(s.liveContext.buffer.length, 0);
});

test('removeEntries removes by identity', () => {
  const s = fakeSession();
  const a = appendLive(s, { label: 'A', text: 'eins', startMs: 1 });
  appendLive(s, { label: 'B', text: 'zwei', startMs: 2 });
  removeEntries(s, [a]);
  assert.deepEqual(s.liveContext.buffer.map((e) => e.text), ['zwei']);
});

test('renderLiveContext serializes the current buffer', () => {
  const s = fakeSession();
  appendLive(s, { label: 'Greta', text: 'Hallo', startMs: 1 });
  assert.equal(renderLiveContext(s), '[Greta] Hallo');
});

test('env getters return sane defaults and survive bad values', () => {
  const keys = ['LIVE_CONTEXT_ENABLED', 'LIVE_RAW_WINDOW_CHARS', 'LIVE_FOLD_CHARS'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k]; // independent of the caller's shell env
    assert.equal(liveContextEnabled(), true);
    assert.equal(rawWindowChars(), 6000);
    assert.equal(foldChars(), 3000);
    process.env.LIVE_RAW_WINDOW_CHARS = 'viel';
    assert.equal(rawWindowChars(), 6000, 'non-numeric → default');
    process.env.LIVE_FOLD_CHARS = '-5';
    assert.equal(foldChars(), 0, 'negative clamped to 0');
    process.env.LIVE_CONTEXT_ENABLED = 'nein';
    assert.equal(liveContextEnabled(), true, 'only the literal "false" disables');
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
