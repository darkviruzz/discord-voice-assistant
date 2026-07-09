import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanWhisperText } from '../src/stt.js';

test('joins whisper mid-word token breaks (no leading space after \\n)', () => {
  assert.equal(cleanWhisperText('Entwicklung befind\nliche'), 'Entwicklung befindliche');
  assert.equal(cleanWhisperText('des 20. Jahr\nhunderts'), 'des 20. Jahrhunderts');
  assert.equal(cleanWhisperText('Universums besch\nreibt'), 'Universums beschreibt');
  assert.equal(cleanWhisperText('Elementarkrä\nfte'), 'Elementarkräfte');
  assert.equal(cleanWhisperText('Rel\nativitätstheorie'), 'Relativitätstheorie');
});

test('keeps a space at real word boundaries (leading space / uppercase after \\n)', () => {
  assert.equal(cleanWhisperText('allgemeine\n Relativitätstheorie'), 'allgemeine Relativitätstheorie');
  assert.equal(cleanWhisperText('der\n vier fundamentalen'), 'der vier fundamentalen');
  assert.equal(cleanWhisperText('Ende.\nNeuer Satz'), 'Ende. Neuer Satz');
});

test('collapses surrounding whitespace and trims', () => {
  assert.equal(cleanWhisperText('  hallo   welt \n test  '), 'hallo welt test');
  assert.equal(cleanWhisperText(''), '');
  assert.equal(cleanWhisperText(null), '');
});
