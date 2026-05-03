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

// Split on any whitespace/newline run; keeps punctuation attached to words
// (normalize() strips it during comparison).
function tokenize(text) {
  return text.trim().split(/[\s\n\r]+/);
}

// Checks whether `transcript` contains `wakeWord` within the first `maxPosition` words.
//   maxPosition = 0 → anywhere in the transcript
//   maxPosition = 1 → first word only  (original behaviour)
//   maxPosition = N → within first N words  (e.g. 3 catches "Hey Rabenauge")
//
// Returns { detected: false } or { detected: true, query: "text after wake word" }
export function detectWakeWord(transcript, wakeWord, fuzzy = false, maxPosition = 1) {
  if (!transcript || !wakeWord) return { detected: false };

  const normWake = normalize(wakeWord);
  const words    = tokenize(transcript.trim());
  const limit    = maxPosition === 0 ? words.length : Math.min(maxPosition, words.length);

  for (let i = 0; i < limit; i++) {
    const normWord = normalize(words[i]);
    if (!normWord) continue; // skip empty tokens (e.g. leading newlines)
    let matched = normWord === normWake;
    if (!matched && fuzzy) {
      matched = levenshtein(normWord, normWake) <= 2;
    }
    if (matched) {
      // Everything after the matched token, stripped of leading punctuation.
      const query = words.slice(i + 1).join(' ').replace(/^[\s,.…!?]+/, '').trim();
      return { detected: true, query };
    }
  }

  return { detected: false };
}
