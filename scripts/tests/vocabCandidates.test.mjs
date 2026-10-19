import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryOf, collectCandidates, rankCandidates, renderCandidates, spokenName } from '../lib/vocabCandidates.mjs';
import { parseVocabulary, vocabularyPrompt, VOCAB_MAX_CHARS } from '../../apps/server/src/sttVocabulary.js';

const fm = (fields, body = '') => `---\n${fields}\n---\n${body}`;

// A small vault in the shape of the campaign vault.
const NOTES = [
  { source: '20_Party/Characters/Gaglath Matho.md', text: fm('type: PC\naliases: Gaglath', '# Gaglath Matho') },
  { source: '20_Party/Characters/Faylith Tarneth.md', text: fm('type: PC\naliases: [Faylith]') },
  { source: '20_Party/Characters/Faylith Tarneth – Hintergrund.md', text: fm('type: PC') },
  { source: '20_Party/Characters/Ceros Reales.md', text: fm('type: PC\nstatus: Tot') },
  { source: '20_Party/Sidekicks/Brida.md', text: fm('type: Sidekick') },
  { source: '30_NPCs/Thalerta Vor-Mael.md', text: fm('type: NPC\naliases:\n  - Fanaticca\n  - Thalerta') },
  { source: '30_NPCs/Elsbeth (Piratin).md', text: fm('type: NPC\naliases: []') },
  { source: '30_NPCs/Kjartan.md', text: 'kein Frontmatter, Ordner reicht' },
  { source: '40_World/Locations/Hommlet.md', text: fm('type: Location') },
  { source: '40_World/Factions/Nachtwache.md', text: fm('type: Faction') },
  { source: '40_World/Lore/Geografie.md', text: fm('type: Lore', 'Hommlet liegt im Süden.') },
  { source: 'Templates/NPC-Vorlage.md', text: fm('type: NPC') },
  { source: '02_Charakterübersicht.md', text: fm('type: Index', '[[Gaglath Matho]] [[Kjartan]] [[Kjartan|der Kapitän]]') },
  // Session notes: oldest first by path; only the last `recent` count.
  { source: '10_Campaign/Session Notes/2025/20251201_S1.md', text: 'Kjartan Kjartan Kjartan, Elsbeth.' },
  { source: '10_Campaign/Session Notes/2026/20260105_S2.md', text: fm('type: Session', '[[Gaglath Matho]] trifft Fanaticca in [[Hommlet]].') },
  { source: '10_Campaign/Session Notes/2026/20260112_S3.md', text: 'Gaglath, Brida und Faylith. Die Nachtwache. Hommlets Tore.' },
  { source: '10_Campaign/Session Notes/2026/20260119_S4.md', text: 'Brida und Elsbeth am Hafen; [[30_NPCs/Kjartan|Kjartan]].' },
];

const byName = (entries) => Object.fromEntries(entries.map((e) => [e.name, e]));

test('categoryOf: frontmatter type first, then the folder (sort prefixes ignored)', () => {
  assert.equal(categoryOf('30_NPCs/X.md', { type: 'NPC' }), 'npc');
  assert.equal(categoryOf('30_NPCs/X.md', {}), 'npc');
  assert.equal(categoryOf('irgendwo/X.md', { type: 'Location' }), 'place');
  assert.equal(categoryOf('20_Party/Characters/X.md', { type: 'Unbekannt' }), 'pc');
  assert.equal(categoryOf('40_World/Lore/X.md', { type: 'Lore' }), null);
  assert.equal(categoryOf('X.md', {}), null);
  assert.equal(spokenName('Elsbeth (Piratin)'), 'Elsbeth');
});

test('collectCandidates: entity notes only, sub-pages and templates skipped, aliases, recent-session counts, links', () => {
  const { entries, recent } = collectCandidates(NOTES, { recent: 3 });
  assert.equal(recent, 3);
  const e = byName(entries);
  assert.deepEqual(Object.keys(e).sort(), [
    'Brida', 'Ceros Reales', 'Elsbeth', 'Fanaticca', 'Faylith Tarneth', 'Gaglath Matho', 'Hommlet', 'Kjartan', 'Nachtwache', 'Thalerta Vor-Mael',
  ]);
  // "Gaglath" (alias inside the name) and "Thalerta" are no entries of their own…
  assert.equal(e.Gaglath, undefined);
  // …but count as mentions: S2 ([[Gaglath Matho]]) and S3 ("Gaglath").
  assert.equal(e['Gaglath Matho'].sessions, 2);
  assert.equal(e['Gaglath Matho'].links, 2, 'vault-wide [[wikilinks]]');
  assert.deepEqual(e.Fanaticca, { name: 'Fanaticca', category: 'npc', alias: true, of: 'Thalerta Vor-Mael', sessions: 1, links: 0 });
  assert.equal(e['Thalerta Vor-Mael'].sessions, 1, 'via its alias');
  // S1 is outside the last 3 sessions; S4 links Kjartan with a path + alias.
  assert.equal(e.Kjartan.sessions, 1);
  assert.equal(e.Kjartan.links, 3);
  assert.equal(e.Elsbeth.sessions, 1);
  assert.equal(e.Hommlet.sessions, 1, 'whole words only: "Hommlets" is no mention');
  assert.equal(e.Nachtwache.category, 'faction');
  assert.equal(e['Faylith Tarneth'].sessions, 1, 'first name only via the alias');
  assert.equal(e['Ceros Reales'].sessions, 0);

  assert.equal(collectCandidates(NOTES, { recent: 10 }).recent, 4);
  assert.equal(byName(collectCandidates(NOTES, { recent: 10 }).entries).Kjartan.sessions, 2);
});

test('rankCandidates: player characters, companions, then the rest by sessions, links, name', () => {
  const ranked = rankCandidates(collectCandidates(NOTES, { recent: 3 }).entries).map((x) => x.name);
  assert.deepEqual(ranked, [
    'Gaglath Matho', 'Faylith Tarneth', 'Ceros Reales',
    'Brida',
    'Kjartan', 'Hommlet', 'Elsbeth', 'Fanaticca', 'Nachtwache', 'Thalerta Vor-Mael',
  ]);
});

test('renderCandidates: active lines = recently mentioned names in rank order, within the prompt budget; the server parses exactly those', () => {
  const { entries, recent } = collectCandidates(NOTES, { recent: 3 });
  const { text, active } = renderCandidates(entries, { vault: '/vault', recent, now: new Date('2026-10-18T12:00:00Z') });
  assert.match(text, /^# STT-Vokabular — Kandidaten aus \/vault \(npm run vocab:stt, 2026-10-18\)/);
  assert.match(text, /^# Ceros Reales +# Spielercharakter · 0\/3 Sessions/m, 'unmentioned → commented out');
  assert.deepEqual(active, ['Gaglath Matho', 'Faylith Tarneth', 'Brida', 'Kjartan', 'Hommlet', 'Elsbeth', 'Fanaticca', 'Nachtwache', 'Thalerta Vor-Mael']);
  assert.deepEqual(parseVocabulary(text), active, 'comments, headings and notes are ignored by the server');
  assert.deepEqual(vocabularyPrompt(parseVocabulary(text)).dropped, []);

  // Many candidates: the active part still fits the budget exactly as the server cuts it.
  const many = Array.from({ length: 80 }, (_, i) => ({ name: `Nichtspieler ${i}`, category: 'npc', sessions: 80 - i, links: 0 }));
  const big = renderCandidates(many, { recent: 10 });
  const parsed = parseVocabulary(big.text);
  assert.deepEqual(parsed, big.active);
  assert.ok(parsed.length > 5 && parsed.length < 80);
  assert.deepEqual(vocabularyPrompt(parsed).dropped, [], 'nothing active is cut by the server');
  assert.ok(vocabularyPrompt(parsed).text.length <= VOCAB_MAX_CHARS);
  assert.match(big.text, new RegExp(`# ${parsed.length} Namen aktiv, ${vocabularyPrompt(parsed).text.length} Zeichen Prompt\\.`));
});
