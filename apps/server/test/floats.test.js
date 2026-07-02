import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../src/transcriptView.js';
import { buildAssistantSpans, buildModelFromEvents } from '../src/finalize/merge.js';

const { attachFloats, anchorWordIndex } = _internal;

// words in ms relative to span start (the JSONL user_transcript shape)
const w = (word, t0, t1) => ({ w: word, t0, t1 });

function userSpan(startMs, durMs, text, words = null, userId = '1') {
  return { type: 'user', userId, label: `U${userId}`, startMs, endMs: startMs + durMs, text, words };
}

test('attachFloats: interrupter floats into the running monolog at the word anchor', () => {
  const host = userSpan(1000, 20000, 'eins zwei drei vier fünf', [
    w('eins', 0, 3000), w('zwei', 4000, 7000), w('drei', 8000, 11000),
    w('vier', 12000, 15000), w('fünf', 16000, 19000),
  ], '1');
  const interrupter = userSpan(9500, 2000, 'kurz dazwischen', null, '2');
  const bystander = userSpan(30000, 2000, 'danach', null, '3'); // outside the window
  attachFloats([host, interrupter, bystander]);

  assert.deepEqual(interrupter.floatInto, { hostStartMs: 1000, atWordIndex: 3 }); // after "drei" (t0 8000 ≤ 8500)
  assert.equal(host.floatInto, undefined);
  assert.equal(bystander.floatInto, undefined);
});

test('attachFloats: nested interruption anchors to the INNERMOST talker', () => {
  const host = userSpan(0, 60000, 'lang', Array.from({ length: 60 }, (_, i) => w(`w${i}`, i * 1000, i * 1000 + 900)), '1');
  const first = userSpan(10500, 8000, 'längere nebenrede läuft hier', null, '2');
  const second = userSpan(12000, 2000, 'kurzer einwurf', null, '3'); // inside `first`
  attachFloats([host, first, second]);

  assert.equal(first.floatInto.hostStartMs, 0);
  // `second` interrupts the side conversation, not the monolog — the chain is
  // resolved client-side (escalates when `first` renders as a small bubble).
  assert.equal(second.floatInto.hostStartMs, 10500);
});

test('attachFloats: separate later interruption still anchors to the monolog', () => {
  const host = userSpan(0, 60000, 'lang', Array.from({ length: 60 }, (_, i) => w(`w${i}`, i * 1000, i * 1000 + 900)), '1');
  const first = userSpan(10500, 3000, 'erste', null, '2');
  const second = userSpan(30000, 2000, 'zweite viel später', null, '3'); // outside `first`
  attachFloats([host, first, second]);
  assert.equal(first.floatInto.hostStartMs, 0);
  assert.equal(second.floatInto.hostStartMs, 0);
  assert.ok(second.floatInto.atWordIndex > first.floatInto.atWordIndex);
});

test('attachFloats: assistant host uses its playback interruption anchor', () => {
  const host = {
    type: 'assistant', label: 'Rabenauge', startMs: 0, endMs: 10000,
    text: 'eins zwei drei vier fünf sechs sieben acht neun zehn', words: null,
    interruptions: [{ byUserId: '2', atMs: 4200, atRatio: 0.4 }],
  };
  const interrupter = userSpan(4200, 1500, 'stopp mal', null, '2');
  attachFloats([host, interrupter]);
  assert.equal(interrupter.floatInto.hostStartMs, 0);
  assert.equal(interrupter.floatInto.atWordIndex, 4); // 0.4 × 10 words
});

test('anchorWordIndex: clamps and interpolates without word timestamps', () => {
  const host = { type: 'user', startMs: 0, endMs: 10000, text: 'a b c d', words: null };
  assert.equal(anchorWordIndex(host, -500), 0);
  assert.equal(anchorWordIndex(host, 5000), 2);
  assert.equal(anchorWordIndex(host, 99999), 4);
});

test('buildAssistantSpans: whole turn with interruption anchors (no splitting)', () => {
  const events = [
    { type: 'assistant_response', turnId: 't1', tsMs: 1000, text: 'Eine lange Antwort über vieles.' },
    { type: 'tts_start', turnId: 't1', id: 'tts1', tsMs: 1100 },
    { type: 'playback_paused', id: 'tts1', tsMs: 3000, msPlayed: 1800, interruptedByUserId: '7' },
    { type: 'playback_resumed', id: 'tts1', tsMs: 5000, rewoundMs: 500 },
    { type: 'tts_done', turnId: 't1', id: 'tts1', tsMs: 8000, durationMs: 6000 },
  ];
  const spans = buildAssistantSpans(events, { clockOffsetMs: 0, assistantName: 'Rabenauge' });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].text, 'Eine lange Antwort über vieles.');
  assert.equal(spans[0].interruptions.length, 1);
  assert.equal(spans[0].interruptions[0].byUserId, '7');
  assert.ok(Math.abs(spans[0].interruptions[0].atRatio - 0.3) < 0.01);
});

test('buildModelFromEvents weave:false keeps user spans and full assistant turns', () => {
  const events = [
    { type: 'session_meta', sessionId: '100' },
    { type: 'user_transcript', sessionId: '100', userId: '1', text: 'Hallo Welt', startTsMs: 100, endTsMs: 2000, tsMs: 2100 },
    { type: 'assistant_response', turnId: 't1', tsMs: 3000, text: 'Antwort.' },
  ];
  const model = buildModelFromEvents(events, { weave: false, sessionStartMs: 0 });
  const kinds = model.spans.map((s) => s.type).sort();
  assert.deepEqual(kinds, ['assistant', 'user']);
  assert.equal(model.spans.find((s) => s.type === 'assistant').text, 'Antwort.');
});
