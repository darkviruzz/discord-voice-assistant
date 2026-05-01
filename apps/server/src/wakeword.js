function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function normalize(str) {
  return str.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Checks whether `transcript` starts with `wakeWord`.
// Returns { detected: false } or { detected: true, query: "..." }
// `query` is the text after the wake word (original casing, punctuation stripped from the prefix).
export function detectWakeWord(transcript, wakeWord, fuzzy = false) {
  if (!transcript || !wakeWord) return { detected: false };

  const normWake = normalize(wakeWord);
  const trimmed  = transcript.trim();

  // Isolate the first token (everything before the first whitespace or punctuation boundary).
  const firstEnd = trimmed.search(/[\s,.…!?]/);
  const firstWord = firstEnd === -1 ? trimmed : trimmed.slice(0, firstEnd);
  const normFirst = normalize(firstWord);

  let matched = normFirst === normWake;
  if (!matched && fuzzy) {
    matched = levenshtein(normFirst, normWake) <= 2;
  }
  if (!matched) return { detected: false };

  // Strip the matched token and any trailing punctuation/spaces to get the query.
  const rest = trimmed.slice(firstWord.length).replace(/^[\s,.…!?]+/, '').trim();
  return { detected: true, query: rest };
}
