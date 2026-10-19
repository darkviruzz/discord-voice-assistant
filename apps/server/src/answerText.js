// Cleanup of the answer text before it is spoken, posted and stored. The
// persona asks for plain spoken sentences, but in roleplay gemma4:12b still
// writes stage directions — live test 2026-10-20, "spiele den verängstigten
// Gefangenen": "*(Mit zitternder Stimme und hastiger Atmung)* Oh Gott...
// bitte..." — and Piper read them aloud. Voice and mood already come from
// speaker_id/model, so a direction is dropped, not translated.
//
// - **…** / __…__ (bold): markers removed, words kept.
// - *(…)* / _(…)_ / (*…*), also with [ ]: always a direction, dropped.
// - *…* / _…_ as a whole segment (start of the text or after a sentence end,
//   followed by the end or a new sentence): an action like *seufzt*, dropped.
//   Inside a sentence it is emphasis: markers removed, words kept.
// - (…) / […] as a whole segment, without a sentence of its own inside and at
//   most DIRECTION_MAX_WORDS words: dropped. Inside a sentence, or a full
//   sentence in brackets, it is content and stays.
// - Stray asterisks go. Spaces and punctuation are only tidied where something
//   was removed, so normal sentences stay as they are.

const DIRECTION_MAX_WORDS = 15;

// Placeholder for a removed piece until the final tidy-up.
const CUT = '\u0001';

// Skipped when looking for the sentence boundary around a candidate: quotes,
// markers of a half-removed direction, an already removed one.
const TRANSPARENT = new Set(['"', '\'', '„', '“', '”', '‚', '‘', '’', '»', '«', '*', '_', CUT]);
const SENTENCE_END = new Set(['.', '!', '?', '…', ':', ';']);

// Start of the text / a line or a sentence boundary before index `i`.
function boundaryBefore(str, i) {
  let j = i - 1;
  while (j >= 0 && (/[ \t]/.test(str[j]) || TRANSPARENT.has(str[j]))) j--;
  return j < 0 || str[j] === '\n' || SENTENCE_END.has(str[j]);
}

// End of the text / a line or the start of a new sentence at index `i`.
function boundaryAfter(str, i) {
  let j = i;
  while (j < str.length && /[ \t]/.test(str[j])) j++;
  if (j >= str.length || str[j] === '\n') return true;
  const c = str[j];
  return /[\p{Lu}\p{N}]/u.test(c) || TRANSPARENT.has(c) || c === '(' || c === '[' || SENTENCE_END.has(c);
}

const isSegment = (str, start, len) => boundaryBefore(str, start) && boundaryAfter(str, start + len);

// A bracketed segment reads as a direction: no sentence of its own inside
// ("(Das wisst ihr aus Session 3.)" stays), short.
function looksLikeDirection(inner) {
  const t = inner.replace(/\.{3}|…/g, ' ').trim();
  if (!t || /[.!?]/.test(t)) return false;
  return t.split(/\s+/).length <= DIRECTION_MAX_WORDS;
}

// Close the gaps the removed pieces left.
function closeCuts(t) {
  return t
    .replace(/[ \t]*\u0001(?:[ \t]*\u0001)*[ \t]*/g, CUT)
    .replace(/(^|\n)\u0001(?:\n|$)/g, '$1') // a line that was only a direction
    .replace(/(^|\n)\u0001[,;:]*[ \t]*/g, '$1') // at the start of a line, with an orphaned comma
    .replace(/\u0001(?=$|\n)/g, '') // at the end of a line
    .replace(/[,;:]\u0001(?=[,;:.!?…])/g, '') // "nein, ␁, bitte" / "nein, ␁."
    .replace(/([.!?…])\u0001[,;:]+[ \t]*/g, '$1 ') // "Halt. ␁, bitte"
    .replace(/\u0001(?=[,;:.!?…])/g, '') // "Hallo ␁, Freund"
    .replace(/\u0001/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// → the text to speak; never empty for a non-empty input (an answer that is
// nothing but a direction keeps its words without the markers).
export function cleanAnswerText(raw) {
  const original = String(raw ?? '').trim();
  let t = original;
  // Bold first, so a single * below is always italic or an action.
  t = t.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)([^\n]*?\S)__(?![\p{L}\p{N}_])/gu, '$1');
  // *(…)*, _[…]_, (*…*): marked twice, always a direction.
  t = t.replace(/[*_]+[ \t]*(?:\([^()\n]*\)|\[[^[\]\n]*\])[ \t]*[*_]+/g, CUT)
    .replace(/[([][ \t]*\*[^*()[\]\n]+\*[ \t]*[)\]]/g, CUT);
  // *…* / _…_: an action as a whole segment (with its own full stop), else
  // emphasis.
  t = t.replace(/\*(?=\S)([^*\n]*?\S)\*([.!?…]*)/g,
    (m, inner, stop, off, str) => (isSegment(str, off, m.length) ? CUT : inner + stop));
  t = t.replace(/(?<![\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])([.!?…]*)/gu,
    (m, inner, stop, off, str) => (isSegment(str, off, m.length) ? CUT : inner + stop));
  // (…) / […]: a short direction as a whole segment.
  t = t.replace(/(?:\(([^()\n]*)\)|\[([^[\]\n]*)\])([.!?…]*)/g, (m, round, square, stop, off, str) =>
    (isSegment(str, off, m.length) && looksLikeDirection(round ?? square) ? CUT : m));
  t = closeCuts(t.replace(/\*+/g, CUT));
  if (/[\p{L}\p{N}]/u.test(t)) return t;
  // Nothing but directions: keep the words rather than answer with silence.
  const words = original.replace(/[*_()[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words || original;
}
