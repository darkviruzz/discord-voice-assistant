import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeTokensToWords, agreedPrefixLen, normWord, endsSentence, endsClause,
  looksRepetitive, createSttStream,
} from '../src/sttStreaming.js';
import { stitchByTime } from '../src/pipeline.js';

const SR = 48000;

// Token helper in the shape stt.js parseWords() produces: { w, t0, t1, raw }.
// `raw` keeps whisper's convention: leading space = new word, none = sub-word
// continuation / glued punctuation.
function tok(raw, t0, t1) {
  return { w: raw.trim(), t0, t1, raw };
}

function pcmOfSeconds(sec) {
  return Buffer.alloc(Math.round(sec * SR) * 2);
}

beforeEach(() => {
  process.env.STT_STREAM_MIN_WINDOW_MS = '500';
  process.env.STT_STREAM_TRIM_SECONDS = '15';
  process.env.STT_STREAM_PROMPT = 'true';
});

// ── mergeTokensToWords ───────────────────────────────────────────────────────

test('mergeTokensToWords: sub-word pieces and punctuation glue to one word', () => {
  const words = mergeTokensToWords([
    tok(' Stop', 0.1, 0.3), tok('!', 0.3, 0.35),
    tok(' Ab', 0.5, 0.6), tok('brechen', 0.6, 0.9), tok('!', 0.9, 0.95),
  ]);
  assert.deepEqual(words.map((w) => w.text), ['Stop!', 'Abbrechen!']);
  assert.equal(words[1].t0, 0.5);
  assert.equal(words[1].t1, 0.95);
  assert.equal(words[1].norm, 'abbrechen');
});

test('mergeTokensToWords: newlines inside tokens never leak into words', () => {
  const words = mergeTokensToWords([tok(' Welt\nbild', 0, 0.4)]);
  assert.deepEqual(words.map((w) => w.text), ['Welt bild']);
});

// ── agreedPrefixLen ──────────────────────────────────────────────────────────

test('agreedPrefixLen: case/punctuation-insensitive prefix', () => {
  const a = mergeTokensToWords([tok(' Hallo', 0, 1), tok(' Welt', 1, 2), tok(' wie', 2, 3)]);
  const b = mergeTokensToWords([tok(' hallo', 0, 1), tok(' Welt,', 1, 2), tok(' geht', 2, 3)]);
  assert.equal(agreedPrefixLen(a, b), 2); // "wie" vs "geht" stops the prefix
});

test('agreedPrefixLen: diverging first word → 0', () => {
  const a = mergeTokensToWords([tok(' Weltmeer', 0, 1)]);
  const b = mergeTokensToWords([tok(' Weltbild', 0, 1)]);
  assert.equal(agreedPrefixLen(a, b), 0);
});

// ── endsSentence / normWord ──────────────────────────────────────────────────

test('endsSentence: terminators incl. trailing quotes', () => {
  assert.ok(endsSentence('ergibt.'));
  assert.ok(endsSentence('wirklich?'));
  assert.ok(endsSentence('„Kleinheit“.'));
  assert.ok(!endsSentence('Komma,'));
  assert.ok(!endsSentence('Wort'));
});

test('normWord: strips everything but letters/digits', () => {
  assert.equal(normWord('„Kleinheit“,'), 'kleinheit');
  assert.equal(normWord('3,7'), '37');
});

test('endsClause: comma/semicolon count, plain words do not', () => {
  assert.ok(endsClause('Kleinheit,'));
  assert.ok(endsClause('gibt;'));
  assert.ok(endsClause('ergibt.'));
  assert.ok(!endsClause('Wort'));
});

test('looksRepetitive: detects bigram hallucination loops', () => {
  const loop = mergeTokensToWords([
    tok(' der', 0, 1), tok(' Erkrankung', 1, 2), tok(' der', 2, 3),
    tok(' Erkrankung', 3, 4), tok(' der', 4, 5), tok(' Erkrankung', 5, 6),
  ]);
  assert.ok(looksRepetitive(loop));
  const normal = mergeTokensToWords([
    tok(' die', 0, 1), tok(' Wechselwirkung', 1, 2), tok(' zwischen', 2, 3),
    tok(' kleinsten', 3, 4), tok(' Teilchen', 4, 5), tok(' in', 5, 6), tok(' Raumgebieten', 6, 7),
  ]);
  assert.ok(!looksRepetitive(normal));
});

test('stream: bracket artifacts are never committed or displayed', async () => {
  const fn = fakeTranscriber([
    { tokens: [tok(' [SCHLÜSSE]', 0, 0.5)] },
    { tokens: [tok(' [SCHLÜSSE]', 0, 0.5)] },
    { tokens: [tok(' Quantengravitation', 0, 1.2), tok('.', 1.2, 1.3)] },
  ]);
  const s = createSttStream({ transcribeFn: fn });
  const r1 = await s.tick(pcmOfSeconds(2));
  assert.ok(r1 === null || r1.changed === false || r1.text === '',
    `artifact displayed: ${r1?.text}`);
  await s.tick(pcmOfSeconds(3));
  assert.equal(s.state.committed.length, 0); // artifact never committed
  const r3 = await s.tick(pcmOfSeconds(4));
  assert.equal(r3.text, 'Quantengravitation.');
});

// ── stitchByTime (forced-overlap dedup fix) ──────────────────────────────────

test('stitchByTime: drops all words inside the overlap window', () => {
  // 2 s overlap; the chunk re-transcribes the overlap DIFFERENTLY ("Weltbild"
  // vs the previous chunk's "Weltmeer") — text matching would fail, time cut works.
  const prev = 'bestimmt sie nicht nur das Weltmeer.';
  const tokens = [
    tok(' bestimmt', 0.1, 0.5), tok(' sie', 0.5, 0.7), tok(' das', 0.8, 1.0),
    tok(' Weltbild', 1.0, 1.9),
    tok(' der', 2.1, 2.3), tok(' Physik', 2.3, 2.9), tok(',', 2.9, 2.95),
  ];
  assert.equal(stitchByTime(prev, tokens, 2), 'bestimmt sie nicht nur das Weltmeer. der Physik,');
});

test('stitchByTime: 1-word seam duplicate is removed', () => {
  const prev = 'Eins zwei drei';
  const tokens = [tok(' zwei', 0.5, 1.0), tok(' drei', 2.1, 2.5), tok(' vier', 2.6, 3.0)];
  assert.equal(stitchByTime(prev, tokens, 2), 'Eins zwei drei vier');
});

test('stitchByTime: chunk entirely inside overlap adds nothing', () => {
  const prev = 'Eins zwei';
  const tokens = [tok(' eins', 0.2, 0.6), tok(' zwei', 0.9, 1.4)];
  assert.equal(stitchByTime(prev, tokens, 2), 'Eins zwei');
});

// ── createSttStream state machine ────────────────────────────────────────────

// Scripted fake transcriber: returns the queued hypotheses in order.
function fakeTranscriber(script) {
  const calls = [];
  const fn = async (wavBuffer, opts = {}) => {
    const windowSec = (wavBuffer.length - 44) / 2 / SR;
    calls.push({ windowSec, prompt: opts.prompt });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    return { text: next.text ?? '', meta: { segmentCount: 1 }, words: next.tokens ?? null };
  };
  fn.calls = calls;
  return fn;
}

test('stream: first hypothesis shows as unstable tail, second commits the agreed prefix', async () => {
  const fn = fakeTranscriber([
    { tokens: [tok(' Hallo', 0, 0.4), tok(' Welt', 0.5, 0.9), tok(' wie', 1.0, 1.3)] },
    { tokens: [tok(' Hallo', 0, 0.4), tok(' Welt', 0.5, 0.9), tok(' wie', 1.0, 1.3), tok(' geht', 1.4, 1.8)] },
  ]);
  const s = createSttStream({ transcribeFn: fn });

  const r1 = await s.tick(pcmOfSeconds(2));
  assert.equal(r1.changed, true);
  assert.equal(r1.text, 'Hallo Welt wie');
  assert.equal(r1.stableWords, 0); // nothing agreed yet — all tail

  const r2 = await s.tick(pcmOfSeconds(3));
  assert.equal(r2.text, 'Hallo Welt wie geht');
  assert.equal(r2.stableWords, 3); // LCP of both hypotheses
});

test('stream: identical buffer skips the tick (no redundant GPU call)', async () => {
  const fn = fakeTranscriber([{ tokens: [tok(' Hallo', 0, 0.4)] }]);
  const s = createSttStream({ transcribeFn: fn });
  await s.tick(pcmOfSeconds(2));
  const again = await s.tick(pcmOfSeconds(2));
  assert.equal(again, null);
  assert.equal(fn.calls.length, 1);
});

test('stream: committed words never retract even when the hypothesis flips', async () => {
  const fn = fakeTranscriber([
    { tokens: [tok(' Hallo', 0, 0.4), tok(' Welt', 0.5, 0.9), tok(' wie', 1.0, 1.3)] },
    { tokens: [tok(' Hallo', 0, 0.4), tok(' Welt', 0.5, 0.9), tok(' wie', 1.0, 1.3)] },
    // Later hypothesis disagrees from word 2 on:
    { tokens: [tok(' Hallo', 0, 0.4), tok(' Erde', 0.5, 0.9), tok(' was', 1.0, 1.3)] },
  ]);
  const s = createSttStream({ transcribeFn: fn });
  await s.tick(pcmOfSeconds(2));
  const r2 = await s.tick(pcmOfSeconds(3));
  assert.equal(r2.stableWords, 3);
  const r3 = await s.tick(pcmOfSeconds(4));
  // Committed prefix stays; only the tail may reflect the new hypothesis.
  assert.ok(r3 === null || r3.changed === false || r3.text.startsWith('Hallo Welt wie'),
    `committed prefix retracted: ${r3?.text}`);
  assert.equal(s.state.committed.length, 3);
});

test('stream: trim locks at sentence boundary, advances window, carries prompt', async () => {
  process.env.STT_STREAM_TRIM_SECONDS = '5';
  const sentence = [
    tok(' Das', 0.2, 0.5), tok(' ist', 0.6, 0.9), tok(' ein', 1.0, 1.3),
    tok(' Satz', 1.4, 5.4), tok('.', 5.4, 5.5),
    tok(' Und', 6.0, 6.3), tok(' mehr', 6.4, 6.8),
  ];
  const fn = fakeTranscriber([
    { tokens: sentence },
    { tokens: sentence }, // agreement → commit all 6 words → trim fires (t1=5.5 ≥ 5)
    { tokens: [tok(' Und', 0.1, 0.4), tok(' mehr', 0.5, 0.9), tok(' Text', 1.0, 1.4)] },
  ]);
  const s = createSttStream({ transcribeFn: fn });
  await s.tick(pcmOfSeconds(7));
  const r2 = await s.tick(pcmOfSeconds(8));

  assert.deepEqual(s.state.lockedGroups, ['Das ist ein Satz.']);
  assert.ok(s.state.windowStartSample > 5.4 * SR && s.state.windowStartSample < 6.1 * SR,
    `window start ${s.state.windowStartSample / SR}s not in the sentence gap`);
  // Locked group + re-based committed remainder render as two segments.
  assert.deepEqual(r2.segments, ['Das ist ein Satz.', 'Und mehr']);
  assert.equal(r2.stableWords, 6);

  // Next tick transcribes only the remaining window and gets the locked prompt.
  await s.tick(pcmOfSeconds(9));
  const last = fn.calls[fn.calls.length - 1];
  assert.ok(last.windowSec < 4, `window not trimmed: ${last.windowSec}s`);
  assert.equal(last.prompt, 'Das ist ein Satz.');
});

test('stream: finalize combines locked groups with the final tail, words in ms', async () => {
  process.env.STT_STREAM_TRIM_SECONDS = '5';
  const sentence = [
    tok(' Das', 0.2, 0.5), tok(' ist', 0.6, 0.9), tok(' ein', 1.0, 1.3),
    tok(' Satz', 1.4, 5.4), tok('.', 5.4, 5.5),
    tok(' Und', 6.0, 6.3), tok(' mehr', 6.4, 6.8),
  ];
  const fn = fakeTranscriber([
    { tokens: sentence },
    { tokens: sentence },
    { tokens: [tok(' Und', 0.1, 0.4), tok(' mehr', 0.5, 0.9), tok(' Text', 1.0, 1.4), tok('.', 1.4, 1.5)] },
  ]);
  const s = createSttStream({ transcribeFn: fn });
  await s.tick(pcmOfSeconds(7));
  await s.tick(pcmOfSeconds(8));

  const fin = await s.finalize(pcmOfSeconds(9));
  assert.equal(fin.text, 'Das ist ein Satz. Und mehr Text.');
  assert.deepEqual(fin.segments, ['Das ist ein Satz.', 'Und mehr Text.']);
  assert.deepEqual(fin.rawChunks.map((c) => c.split), ['stream-locked', 'stream-final']);
  assert.equal(fin.stt.provider, 'whisper.cpp');
  assert.equal(fin.stt.mode, 'stream');

  // Words: locked ("Das ist ein Satz.") + tail, all in ms since utterance start,
  // tail offset by the trimmed window start, times monotonic, no duplicates.
  const texts = fin.words.map((w) => w.w);
  assert.deepEqual(texts, ['Das', 'ist', 'ein', 'Satz.', 'Und', 'mehr', 'Text.']);
  for (let i = 1; i < fin.words.length; i++) {
    assert.ok(fin.words[i].t0 >= fin.words[i - 1].t0, 'word times not monotonic');
  }
  assert.ok(fin.words[4].t0 >= 5400, `tail word not offset: ${fin.words[4].t0}ms`);
});

test('finalize: committed words survive a diverging final pass (time-cut seam)', async () => {
  const committedHyp = [
    tok(' Die', 0.1, 0.3), tok(' anderen', 0.4, 0.7), tok(' Elementarkräfte', 0.8, 1.6),
    tok(' hingegen', 1.7, 2.1), tok(' sind', 2.2, 2.4),
  ];
  const fn = fakeTranscriber([
    { tokens: committedHyp },
    { tokens: committedHyp }, // agreement → all 5 committed
    // Final pass hallucinates a different sentence start but continues correctly:
    { tokens: [
      tok(' Das', 0.1, 0.3), tok(' ist', 0.4, 0.6), tok(' wohl', 0.8, 2.3),
      tok(' obwohl', 2.5, 2.9), tok(' betragsmäßig', 3.0, 3.8),
    ] },
  ]);
  const s = createSttStream({ transcribeFn: fn });
  await s.tick(pcmOfSeconds(3));
  await s.tick(pcmOfSeconds(4));
  const fin = await s.finalize(pcmOfSeconds(5));
  // Committed prefix kept verbatim; only the post-committed part (t0 ≥ 2.4-ε)
  // of the final hypothesis is appended.
  assert.equal(fin.text, 'Die anderen Elementarkräfte hingegen sind obwohl betragsmäßig');
});

test('finalize: near-empty remaining window falls back to the committed words', async () => {
  const hyp = [tok(' Hallo', 0.1, 0.4), tok(' Welt', 0.5, 0.9)];
  const fn = fakeTranscriber([{ tokens: hyp }, { tokens: hyp }]);
  const s = createSttStream({ transcribeFn: fn });
  await s.tick(pcmOfSeconds(1.5));
  await s.tick(pcmOfSeconds(2));
  // finalize with barely any audio beyond the window start (window < 0.25 s is
  // impossible here since windowStart=0 — simulate via a tiny buffer instead)
  const fin = await s.finalize(pcmOfSeconds(0.2));
  assert.equal(fin.text, 'Hallo Welt');
  assert.equal(fin.words.length, 2);
});

test('stream: detach discards a mid-flight tick result', async () => {
  let resolveTranscribe;
  const fn = async () => new Promise((res) => { resolveTranscribe = res; });
  const s = createSttStream({ transcribeFn: fn });
  const tickP = s.tick(pcmOfSeconds(2));
  s.detach();
  resolveTranscribe({ text: 'Hallo', meta: {}, words: [tok(' Hallo', 0, 0.4)] });
  const r = await tickP;
  assert.equal(r, null);
  assert.equal(s.state.committed.length, 0);
  assert.equal(s.state.ticks, 0);
});

test('stream: degraded mode without word timestamps still streams text', async () => {
  const fn = fakeTranscriber([
    { text: 'Hallo Welt', tokens: null },
    { text: 'Hallo Welt wie', tokens: null },
  ]);
  const s = createSttStream({ transcribeFn: fn });
  const r1 = await s.tick(pcmOfSeconds(2));
  assert.equal(r1.text, 'Hallo Welt');
  const r2 = await s.tick(pcmOfSeconds(3));
  assert.equal(r2.text, 'Hallo Welt wie');
  assert.equal(r2.stableWords, 2);
});
