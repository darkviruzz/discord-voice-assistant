import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanAnswerText } from '../src/answerText.js';

// The answer text is read aloud: stage directions and markdown markers must
// not reach Piper, normal sentences must stay exactly as written.

test('live test 2026-10-20: the asterisk/parenthesis direction in front is dropped', () => {
  assert.equal(cleanAnswerText('*(Mit zitternder Stimme und hastiger Atmung)* Oh Gott... bitte...'), 'Oh Gott... bitte...');
});

test('directions at the start: (…), […], *…*, _…_, *[…]*, (*…*)', () => {
  for (const [input, want] of [
    ['(flüstert) Komm näher.', 'Komm näher.'],
    ['[flüstert] Komm näher.', 'Komm näher.'],
    ['*seufzt* Na gut.', 'Na gut.'],
    ['_seufzt_ Na gut.', 'Na gut.'],
    ['*[räuspert sich]* Hört zu.', 'Hört zu.'],
    ['(*räuspert sich*) Hört zu.', 'Hört zu.'],
    ['**(leise)** Hier entlang.', 'Hier entlang.'],
    ['*(Mit zitternder Stimme) Oh Gott, nein.', 'Oh Gott, nein.'], // closing * missing
  ]) assert.equal(cleanAnswerText(input), want, input);
});

test('directions as whole segments between and after sentences', () => {
  for (const [input, want] of [
    ['Oh nein! *(weicht zurück)* Bitte nicht!', 'Oh nein! Bitte nicht!'],
    ['Na gut. *seufzt* Dann los.', 'Na gut. Dann los.'],
    ['Na gut. *seufzt*. Dann los.', 'Na gut. Dann los.'],
    ['Na gut. *seufzt*', 'Na gut.'],
    ['Ich warte. (lächelt)', 'Ich warte.'],
    ['„Hilfe!“ *zittert am ganzen Körper* „Lasst mich gehen!“', '„Hilfe!“ „Lasst mich gehen!“'],
    ['*(schluckt)* *(blickt zur Tür)* Sie kommen.', 'Sie kommen.'],
    ['Erste Zeile.\n*(seufzt)*\nZweite Zeile.', 'Erste Zeile.\nZweite Zeile.'],
  ]) assert.equal(cleanAnswerText(input), want, input);
});

test('a marked direction inside a sentence goes, its commas are tidied', () => {
  for (const [input, want] of [
    ['Oh nein, *(weicht zurück)*, bitte nicht!', 'Oh nein, bitte nicht!'],
    ['Oh nein, *(weicht zurück)*.', 'Oh nein.'],
    ['Hallo *(lächelt)*, Freund.', 'Hallo, Freund.'],
  ]) assert.equal(cleanAnswerText(input), want, input);
});

test('emphasis markers go, the words stay', () => {
  for (const [input, want] of [
    ['Das ist **sehr** wichtig.', 'Das ist sehr wichtig.'],
    ['Das ist __sehr__ wichtig.', 'Das ist sehr wichtig.'],
    ['Das ist *sehr* wichtig.', 'Das ist sehr wichtig.'],
    ['Er nennt sich _der Schatten_.', 'Er nennt sich der Schatten.'],
    ['**Achtung!** Die Brücke bricht.', 'Achtung! Die Brücke bricht.'],
    ['Die Brücke *bricht*.', 'Die Brücke bricht.'],
    ['Oh Gott*', 'Oh Gott'], // stray asterisk
  ]) assert.equal(cleanAnswerText(input), want, input);
});

test('content in brackets and normal sentences stay as written', () => {
  for (const s of [
    'Baron Kelthur (der Herr von Burg Rabenstein) herrscht mit eiserner Faust.',
    'Die Tür ist zu. (Das wisst ihr aus der letzten Sitzung.)',
    'Oh Gott … bitte , nein.', // odd spacing the model wrote is not "fixed"
    'Er sagte: „Wir sehen uns in Graufurt.“ Dann ging er.',
    'Der Schlüssel heißt key_rabenstein_2.',
    'Erste Zeile.\n\nZweite Zeile.',
    'Ihr habt 3 Tränke (2 Heiltränke, 1 Gift) im Gepäck.',
  ]) assert.equal(cleanAnswerText(s), s, s);
  assert.equal(cleanAnswerText('  Ich weiß es nicht.  '), 'Ich weiß es nicht.');
});

test('a long bracketed segment is kept as content', () => {
  const s = 'Die Gruppe zog weiter. (Sie kamen an der alten Mühle, dem Fluss, der Brücke, dem Wald und den drei Hügeln am Rand der Stadt vorbei)';
  assert.equal(cleanAnswerText(s), s);
});

test('an answer that is only a direction keeps its words instead of going silent', () => {
  assert.equal(cleanAnswerText('*(schweigt)*'), 'schweigt');
  assert.equal(cleanAnswerText('*nickt langsam*'), 'nickt langsam');
  assert.equal(cleanAnswerText(''), '');
  assert.equal(cleanAnswerText(null), '');
});
