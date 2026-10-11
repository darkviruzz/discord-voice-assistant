// Word/character error rate + proper-name recall for the STT benchmark
// (scripts/stt-bench.mjs). Pure functions, no I/O.

// Normalise for scoring: lower-case, unify quotes/dashes, drop punctuation
// (keeps letters incl. umlauts/ß, digits and intra-word apostrophes/hyphens),
// collapse whitespace. Both reference and hypothesis go through this, so
// punctuation/casing differences don't count as recognition errors.
export function normalizeForWer(text) {
  return String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[„“”«»‚‘’`´]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[^\p{L}\p{N}'\-\s]/gu, ' ')
    .replace(/(^|\s)['-]+|['-]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text) {
  const n = normalizeForWer(text);
  return n ? n.split(' ') : [];
}

// Levenshtein over arrays with full S/D/I breakdown (two-row DP + op counts).
export function editOps(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => ({ cost: j, s: 0, d: 0, i: j }));
  for (let a = 1; a <= n; a++) {
    const cur = [{ cost: a, s: 0, d: a, i: 0 }];
    for (let b = 1; b <= m; b++) {
      const same = ref[a - 1] === hyp[b - 1];
      const sub = prev[b - 1];
      const del = prev[b];
      const ins = cur[b - 1];
      const cSub = sub.cost + (same ? 0 : 1);
      const cDel = del.cost + 1;
      const cIns = ins.cost + 1;
      if (cSub <= cDel && cSub <= cIns) cur.push({ cost: cSub, s: sub.s + (same ? 0 : 1), d: sub.d, i: sub.i });
      else if (cDel <= cIns) cur.push({ cost: cDel, s: del.s, d: del.d + 1, i: del.i });
      else cur.push({ cost: cIns, s: ins.s, d: ins.d, i: ins.i + 1 });
    }
    prev = cur;
  }
  const r = prev[m];
  return { distance: r.cost, substitutions: r.s, deletions: r.d, insertions: r.i };
}

export function wer(reference, hypothesis) {
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);
  const ops = editOps(ref, hyp);
  return { ...ops, refWords: ref.length, wer: ref.length ? ops.distance / ref.length : (hyp.length ? 1 : 0) };
}

export function cer(reference, hypothesis) {
  const ref = [...normalizeForWer(reference).replace(/ /g, '')];
  const hyp = [...normalizeForWer(hypothesis).replace(/ /g, '')];
  const ops = editOps(ref, hyp);
  return ref.length ? ops.distance / ref.length : (hyp.length ? 1 : 0);
}

// Proper-name recall: of the names that occur in the reference, how many
// occurrences also appear in the hypothesis (multi-word names matched as
// phrases, counted per occurrence). This is the number that matters for a
// fantasy campaign — WER barely moves when "Kelthur" becomes "Kelt Ur".
export function nameRecall(reference, hypothesis, names) {
  const ref = ` ${normalizeForWer(reference)} `;
  const hyp = ` ${normalizeForWer(hypothesis)} `;
  const perName = [];
  let expected = 0;
  let found = 0;
  for (const raw of names) {
    const name = normalizeForWer(raw);
    if (!name) continue;
    const needle = ` ${name} `;
    const inRef = countOccurrences(ref, needle);
    if (inRef === 0) continue;
    const inHyp = Math.min(inRef, countOccurrences(hyp, needle));
    expected += inRef;
    found += inHyp;
    perName.push({ name: raw, expected: inRef, found: inHyp });
  }
  return { recall: expected ? found / expected : null, expected, found, perName };
}

function countOccurrences(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) { n++; i = haystack.indexOf(needle, i + needle.length - 1); }
  return n;
}
