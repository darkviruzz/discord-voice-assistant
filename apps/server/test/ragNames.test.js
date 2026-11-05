import { test } from 'node:test';
import assert from 'node:assert/strict';

import { phonetic, sameName, nameWords, buildNameIndex, matchNames, MAX_NAME_DF } from '../src/rag/names.js';
import { VectorStore } from '../src/rag/store.js';

const same = (a, b) => sameName(phonetic(a), phonetic(b));

test('speech-recognition spellings of names still match', () => {
  assert.ok(same('Phaelith', 'Faylith'));
  assert.ok(same('Tarnith', 'Tarneth'));
  assert.ok(same('Rogar', 'Rhogar'));
  assert.ok(same('Ragnarson', 'Ragnason'));
  assert.ok(same('GaGlass', 'Gaglath'));
  assert.ok(same('Grünkittel', 'Gruenkittel'));
  assert.ok(same('Witan', 'witan'));
});

test('different names do not match', () => {
  assert.equal(same('Steinkreis', 'Siehtenreis'), false);
  assert.equal(same('Nulb', 'Null'), false, 'short names must be equal');
  assert.equal(same('Burne', 'Brida'), false);
  assert.equal(same('Lareth', 'Linara'), false);
});

test('nameWords drops question words, articles, short words and anything with digits', () => {
  assert.deepEqual(nameWords('Wer ist der Bürgermeister an der Quelle?'), ['Bürgermeister', 'Quelle']);
  assert.deepEqual(nameWords('erzähl mir was über den Pilzgott'), ['Pilzgott']);
  assert.deepEqual(nameWords('20260914_SpinOffSessionJK42_Notizen'), ['Notizen'], 'the date and JK42 go; "Notizen" is dropped later as a common word');
  assert.deepEqual(nameWords("So'Rel"), ['SoRel']);
});

test('buildNameIndex: file name and aliases are names, words in many file names are not', () => {
  const notes = [
    ['30_NPCs/Spugnoir.md', {}],
    ['20_Party/Characters/Faylith Tarneth.md', { aliases: 'Faylith' }],
    ...Array.from({ length: MAX_NAME_DF }, (_, i) => [`10_Campaign/Session Notes/2026/2026090${i}_Notizen.md`, {}]),
  ];
  const idx = buildNameIndex(notes);
  assert.deepEqual(idx.map((n) => n.source), ['30_NPCs/Spugnoir.md', '20_Party/Characters/Faylith Tarneth.md'], 'session notes have no name words left');
  const faylith = idx[1];
  assert.equal(faylith.variants.length, 2, 'file name + alias');
});

test('matchNames: share of the best-matching name, alias counts on its own', () => {
  const idx = buildNameIndex([
    ['20_Party/Characters/Faylith Tarneth.md', { aliases: 'Faylith' }],
    ['40_World/Lore/Bastion_Faylith.md', { aliases: 'Falkenturm' }],
    ['30_NPCs/Bürgermeister der Quelle.md', {}],
    ['40_World/Locations/Dorf an der Quelle.md', {}],
    ['40_World/Lore/Standarte der Falken des Selintan.md', { aliases: 'Falkenstandarte, Banner der Falken' }],
  ]);
  const m1 = matchNames(idx, 'erzähl mir was über Faylith');
  assert.equal(m1.get('20_Party/Characters/Faylith Tarneth.md'), 1, 'the alias "Faylith" is matched completely');
  assert.equal(m1.get('40_World/Lore/Bastion_Faylith.md'), 0.5);
  const m2 = matchNames(idx, 'Wer ist der Bürgermeister an der Quelle?');
  assert.equal(m2.get('30_NPCs/Bürgermeister der Quelle.md'), 1);
  assert.equal(m2.get('40_World/Locations/Dorf an der Quelle.md'), 0.5);
  assert.equal(matchNames(idx, 'Was ist die Falkenstandarte?').get('40_World/Lore/Standarte der Falken des Selintan.md'), 1);
  assert.equal(matchNames(idx, 'Fasse die letzte Session zusammen.').size, 0, 'no name, no boost');
});

// Unit vectors in 3 dimensions make the distances easy to read.
const v = (...xs) => xs;

test('search: maxPerNote keeps only the best chunks of one note', () => {
  const s = new VectorStore('sig');
  s.setNote('session.md', { hash: 'a', chunks: [{ text: 's1' }, { text: 's2' }, { text: 's3' }], vectors: [v(1, 0, 0), v(0.99, 0.1, 0), v(0.98, 0.2, 0)] });
  s.setNote('npc.md', { hash: 'b', chunks: [{ text: 'n1' }], vectors: [v(0.9, 0.4, 0)] });
  s.setNote('ort.md', { hash: 'c', chunks: [{ text: 'o1' }], vectors: [v(0.5, 0.8, 0)] });
  assert.deepEqual(s.search(v(1, 0, 0), { topK: 3 }).map((h) => h.text), ['s1', 's2', 's3'], 'unchanged without a cap');
  assert.deepEqual(s.search(v(1, 0, 0), { topK: 3, maxPerNote: 1 }).map((h) => h.text), ['s1', 'n1', 'o1']);
  assert.deepEqual(s.search(v(1, 0, 0), { topK: 3, maxPerNote: 2 }).map((h) => h.text), ['s1', 's2', 'n1']);
});

test('search: a boost changes the order, not the reported distance; the threshold uses the raw distance', () => {
  const s = new VectorStore('sig');
  s.setNote('session.md', { hash: 'a', chunks: [{ text: 's1' }], vectors: [v(1, 0, 0)] });
  s.setNote('npc.md', { hash: 'b', chunks: [{ text: 'n1' }], vectors: [v(0.9, 0.44, 0)] });
  const plain = s.search(v(1, 0, 0), { topK: 2 });
  assert.deepEqual(plain.map((h) => h.source), ['session.md', 'npc.md']);
  const boosted = s.search(v(1, 0, 0), { topK: 2, boost: new Map([['npc.md', 0.15]]) });
  assert.deepEqual(boosted.map((h) => h.source), ['npc.md', 'session.md']);
  assert.equal(boosted[0].distance, plain[1].distance, 'raw distance reported');
  assert.deepEqual(s.search(v(1, 0, 0), { topK: 2, threshold: 0.05, boost: new Map([['npc.md', 0.5]]) }).map((h) => h.source), ['session.md'], 'boost cannot pull a hit past the threshold');
});

test('the name index follows the store', () => {
  const s = new VectorStore('sig');
  s.setNote('30_NPCs/Spugnoir.md', { hash: 'a', meta: {}, chunks: [{ text: 'x' }], vectors: [v(1, 0, 0)] });
  assert.deepEqual(s.nameIndex().map((n) => n.source), ['30_NPCs/Spugnoir.md']);
  const first = s.nameIndex();
  assert.equal(s.nameIndex(), first, 'cached while unchanged');
  s.setNote('30_NPCs/Lareth.md', { hash: 'b', meta: {}, chunks: [{ text: 'y' }], vectors: [v(0, 1, 0)] });
  assert.equal(s.nameIndex().length, 2);
  s.deleteNote('30_NPCs/Spugnoir.md');
  assert.deepEqual(s.nameIndex().map((n) => n.source), ['30_NPCs/Lareth.md']);
});
