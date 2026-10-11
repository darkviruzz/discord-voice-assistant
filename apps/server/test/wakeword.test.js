import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectWakeWord } from '../src/wakeword.js';

// pipeline.js calls detectWakeWord(chunk, WAKE_WORD, fuzzy=WAKE_WORD_FUZZY(true),
// maxPosition=WAKE_WORD_POSITION(3)) for every STT chunk.
const W = 'Rabenauge';

test('exact match at the start: query is the rest, leading punctuation stripped', () => {
  assert.deepEqual(detectWakeWord('Rabenauge, wer ist Baron Kelthur?', W), { detected: true, query: 'wer ist Baron Kelthur?' });
  assert.deepEqual(detectWakeWord('Rabenauge… was nun?', W), { detected: true, query: 'was nun?' });
  assert.deepEqual(detectWakeWord('  Rabenauge  ', W), { detected: true, query: '' });
});

test('matching ignores case, surrounding punctuation and newlines', () => {
  assert.equal(detectWakeWord('RABENAUGE! Hilfe', W).detected, true);
  assert.equal(detectWakeWord('Rabe-Nauge hilf', W).detected, true, 'inner punctuation is stripped too');
  assert.equal(detectWakeWord('„Rabenauge“ hilf uns', W).query, 'hilf uns');
  assert.deepEqual(detectWakeWord('\nRabenauge\nwas ist\ndas', W), { detected: true, query: 'was ist das' });
});

test('maxPosition bounds where the wake word may appear (default: first word only)', () => {
  const t = 'Hey du Rabenauge, sag mal';
  assert.equal(detectWakeWord(t, W).detected, false, 'maxPosition=1');
  assert.equal(detectWakeWord(t, W, false, 2).detected, false);
  assert.deepEqual(detectWakeWord(t, W, false, 3), { detected: true, query: 'sag mal' });
  assert.deepEqual(detectWakeWord('ja also gut dann Rabenauge hilf', W, false, 0), { detected: true, query: 'hilf' }, '0 = anywhere');
});

test('a wake word said late in a sentence does not trigger with the pipeline default (3)', () => {
  assert.equal(detectWakeWord('Ja gut, ich hätte Rabenauge fast vergessen', W, true, 3).detected, false);
});

test('fuzzy matching tolerates up to two STT edits, exact mode tolerates none', () => {
  for (const heard of ['Rabenaug', 'Rabenaugen', 'Rabenauga', 'Rabnauge', 'Rabenaugee!']) {
    assert.equal(detectWakeWord(`${heard} hilf`, W, true).detected, true, `fuzzy: ${heard}`);
    assert.equal(detectWakeWord(`${heard} hilf`, W, false).detected, false, `exact: ${heard}`);
  }
  assert.equal(detectWakeWord('Rabenkrähe hilf', W, true).detected, false, '3+ edits never match');
  assert.equal(detectWakeWord('Regenbogen hilf', W, true).detected, false);
});

test('umlauts / non-ASCII letters are part of the word, not stripped', () => {
  assert.equal(detectWakeWord('Großauge, hörst du?', 'Großauge').detected, true);
  assert.equal(detectWakeWord('Grossauge, hörst du?', 'Großauge').detected, false, 'ß ≠ ss without fuzzy');
});

test('the first matching token wins; the query keeps a later repetition', () => {
  assert.deepEqual(detectWakeWord('Rabenauge Rabenauge was ist', W, false, 3), { detected: true, query: 'Rabenauge was ist' });
});

test('punctuation-only tokens are skipped for matching (but still count towards the position)', () => {
  assert.equal(detectWakeWord('… Rabenauge hilf', W, false, 2).detected, true);
  assert.equal(detectWakeWord('… Rabenauge hilf', W, false, 1).detected, false);
});

test('empty transcript or empty wake word never detects', () => {
  for (const [t, w] of [['', W], [null, W], [undefined, W], ['Rabenauge', ''], ['Rabenauge', null]]) {
    assert.deepEqual(detectWakeWord(t, w, true, 0), { detected: false });
  }
});
