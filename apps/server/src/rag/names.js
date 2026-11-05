// Name matching for the vault search.
//
// The embedding alone ranks a question that names a note ("Wer ist
// Spugnoir?") by meaning, and a session note that mentions Spugnoir in a
// long paragraph about the evening often comes out closer than the short NPC
// note itself. Measured on the campaign vault (47 test questions, 2026-11-06):
// the named note was the first hit for 23 and among the three hits for 33;
// with this boost (RAG_NAME_BOOST) and one chunk per note
// (RAG_MAX_CHUNKS_PER_NOTE) it is 45 and 46.
//
// A note's names are its file name and its frontmatter `aliases`. Words that
// are in many file names ("Notizen", "Zusammenfassung", "Session") are not
// names and are ignored, so the session notes and summaries are not boosted by
// their titles. Matching is fuzzy and phonetic because questions arrive via
// speech recognition: "Phaelith Tarnith" finds "Faylith Tarneth", "Rogar"
// finds "Rhogar", "Ragnarson" finds "Ragnason".

import path from 'node:path';

// A word in this many or more notes' names is a common word, not a name.
export const MAX_NAME_DF = 5;

// Question words, articles, prepositions and campaign filler (German +
// English) that never count as a name, even when a file name contains them.
const STOPWORDS = new Set((
  'wer was wie wo wann warum wieso weshalb welche welcher welches welchen '
  + 'erzähl erzähle erzählen erzählt mir uns euch etwas über ueber wissen weißt weiss weisst kennst kennt kannst könnt bitte '
  + 'haben hat habt hatte sind ist war waren wird werden wurde unsere unser unseren unserem euer eure '
  + 'dem den der die das des ein eine einen einem einer mit und oder von vom zum zur für fuer auf aus bei nach '
  + 'noch mal kurz gerade passiert macht machen gemacht sagen sagt gesagt zusammen fasse fassen letzte letzten '
  + 'session sitzung gruppe kampagne heute gestern dann jetzt also einfach '
  + 'what who where when which tell about with from that this have the and'
).split(' '));

// Phonetic key of one word: case and accents folded, then the spellings a
// speech recogniser or a German/English mix varies on are unified (ph/f,
// th/t, rh/r, c/k, z/s, y/i, v/f, vowel pairs, silent h, double letters).
export function phonetic(word) {
  let s = String(word).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/ß/g, 'ss')
    .replace(/ph/g, 'f').replace(/th/g, 't').replace(/rh/g, 'r').replace(/gh/g, 'g')
    .replace(/ck/g, 'k').replace(/c/g, 'k').replace(/q/g, 'k')
    .replace(/z/g, 's').replace(/y/g, 'i').replace(/v/g, 'f')
    .replace(/(ae|ai|ay|ei|ey|ie)/g, 'e')
    .replace(/(.)h/g, '$1')
    .replace(/(.)\1+/g, '$1');
  return s;
}

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Two phonetic keys name the same thing: equal, or one edit apart (two from
// 10 letters on). Short keys must be equal.
export function sameName(a, b) {
  if (a.length < 3 || b.length < 3) return false;
  if (a === b) return true;
  const len = Math.min(a.length, b.length);
  const max = len >= 10 ? 2 : len >= 5 ? 1 : 0;
  return max > 0 && levenshtein(a, b, max) <= max;
}

// Words of a text that can be names: 4+ letters, no digits, no stopword.
export function nameWords(text) {
  return String(text ?? '')
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/'/g, ''))
    .filter((w) => w.length >= 4 && !/\d/.test(w) && !STOPWORDS.has(w.toLowerCase()));
}

// The names of one note: its file name and each alias, as word lists.
function nameVariants(source, meta) {
  const base = path.posix.basename(String(source)).replace(/\.md$/i, '').replace(/_/g, ' ');
  const aliases = String(meta?.aliases ?? meta?.alias ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return [base, ...aliases].map((v) => nameWords(v)).filter((w) => w.length);
}

// notes: iterable of [source, meta] → [{ source, variants: [[phonetic key, …], …] }]
export function buildNameIndex(notes, { maxDf = MAX_NAME_DF } = {}) {
  const raw = [];
  const df = new Map();
  for (const [source, meta] of notes) {
    const variants = nameVariants(source, meta).map((ws) => ws.map(phonetic));
    raw.push({ source, variants });
    for (const key of new Set(variants.flat())) df.set(key, (df.get(key) ?? 0) + 1);
  }
  const out = [];
  for (const { source, variants } of raw) {
    const kept = variants.map((ks) => ks.filter((k) => (df.get(k) ?? 0) < maxDf)).filter((ks) => ks.length);
    if (kept.length) out.push({ source, variants: kept });
  }
  return out;
}

// How well the question names each note: source → the largest share of one
// name's words (file name or alias) that the question contains, 0..1.
export function matchNames(index, query) {
  const qk = [...new Set(nameWords(query).map(phonetic))];
  const out = new Map();
  if (!qk.length) return out;
  for (const { source, variants } of index) {
    let best = 0;
    for (const keys of variants) {
      const hit = keys.filter((k) => qk.some((q) => sameName(q, k))).length;
      if (hit) best = Math.max(best, hit / keys.length);
    }
    if (best > 0) out.set(source, best);
  }
  return out;
}
