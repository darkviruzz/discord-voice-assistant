import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForWer, tokenize, editOps, wer, cer, nameRecall } from '../lib/wer.mjs';

test('normalisation ignores case, punctuation and quote styles, keeps umlauts', () => {
  assert.equal(normalizeForWer('„Größe“, sagte Kelthur — „ist’s wahr?“'), "größe sagte kelthur ist's wahr");
  assert.deepEqual(tokenize('  Ein   Test!  '), ['ein', 'test']);
  assert.deepEqual(tokenize(''), []);
});

test('edit ops count substitutions, deletions and insertions', () => {
  assert.deepEqual(editOps(['a', 'b', 'c'], ['a', 'b', 'c']), { distance: 0, substitutions: 0, deletions: 0, insertions: 0 });
  assert.deepEqual(editOps(['a', 'b', 'c'], ['a', 'x', 'c']), { distance: 1, substitutions: 1, deletions: 0, insertions: 0 });
  assert.deepEqual(editOps(['a', 'b', 'c'], ['a', 'c']), { distance: 1, substitutions: 0, deletions: 1, insertions: 0 });
  assert.deepEqual(editOps(['a', 'c'], ['a', 'b', 'c']), { distance: 1, substitutions: 0, deletions: 0, insertions: 1 });
  assert.equal(editOps([], ['x', 'y']).insertions, 2);
  assert.equal(editOps(['x', 'y'], []).deletions, 2);
});

test('WER and CER', () => {
  const r = wer('Der Baron herrschte mit eiserner Faust.', 'der baron herrscht mit eiserner faust');
  assert.equal(r.refWords, 6);
  assert.equal(r.substitutions, 1);
  assert.ok(Math.abs(r.wer - 1 / 6) < 1e-9);
  assert.equal(wer('', '').wer, 0);
  assert.equal(wer('', 'noise').wer, 1);
  assert.ok(cer('Kelthur', 'Keltur') > 0 && cer('Kelthur', 'Keltur') < 0.2);
});

test('name recall counts per occurrence and matches multi-word names as phrases', () => {
  const ref = 'Baron Kelthur traf Kelthur in Graufurt. Die Schwarze Hand wartete.';
  const hyp = 'Baron Keltur traf Kelthur in Graufurt. Die schwarze Hand wartete.';
  const r = nameRecall(ref, hyp, ['Kelthur', 'Graufurt', 'Schwarze Hand', 'Nirgendwo']);
  assert.equal(r.expected, 4);
  assert.equal(r.found, 3);
  assert.deepEqual(r.perName.map((p) => [p.name, p.expected, p.found]), [
    ['Kelthur', 2, 1], ['Graufurt', 1, 1], ['Schwarze Hand', 1, 1],
  ]);
  assert.equal(nameRecall('nichts', 'nichts', ['Kelthur']).recall, null);
});
