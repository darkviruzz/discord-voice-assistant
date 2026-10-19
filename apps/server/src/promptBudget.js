// Size budget for the answer prompt.
//
// Ollama runs gemma4:12b with an 8192-token context, and German text measures
// ~3.2 chars/token. Late in a long session, with three session summaries, a
// full live transcript, ten history turns and three RAG hits, the answer prompt
// reached ~29k chars (≈ 9.1k tokens), more than the whole context before a
// single answer token. LLM_PROMPT_BUDGET_CHARS caps the chars of all messages
// together (default 22000 ≈ 6.9k tokens, which leaves room for the chat
// template and the answer). 0 = off.
//
// What gets trimmed, as decided for answerPrompt.js:
//   sessions — the oldest session summaries (never the newest),
//   history  — the oldest history turns (at least 2 stay),
//   rag      — the weakest RAG hits (at least 1 stays),
//   live     — the primed live transcript, oldest lines first,
//   fresh    — the newest lines since the last prime, oldest first.
// The order depends on where the trimming happens (answerPrompt.js): the front
// is trimmed ahead of time for the prime, the question's tail first at
// answer time, so a question rarely changes the primed front.

export function promptBudgetChars() {
  const n = Number(process.env.LLM_PROMPT_BUDGET_CHARS ?? 22000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// The fewest summaries / history turns / RAG hits trimming leaves.
export const MIN_KEEP = { sessions: 1, history: 2, rag: 1 };

// Trim `start` until measure(plan).chars fits `budget`, one key after the
// other in `order`, each as far as needed before the next one is touched.
//   plan    = { sessions, history, rag, live, fresh }: how many newest summaries,
//             newest turns and best hits stay; live/fresh = the most chars the
//             two parts of the live transcript may render to (Infinity = their
//             own cap).
//   measure = plan → { chars, live, fresh }: the chars of the whole prompt and
//             the rendered length of the two live parts.
// Counts go down one at a time (and stop at MIN_KEEP); a live part is cut by
// the overflow at once (it drops whole lines from its start, so the cut is at
// least that big). → { plan, chars } — chars may still exceed the budget when
// everything is at its minimum.
export function fitPrompt({ budget, start, measure, order, min = MIN_KEEP }) {
  const plan = { ...start };
  let m = measure(plan);
  const over = () => budget > 0 && m.chars > budget;
  for (const key of order) {
    if (key === 'live' || key === 'fresh') {
      while (over() && m[key] > 0) {
        plan[key] = Math.max(0, m[key] - (m.chars - budget));
        m = measure(plan);
      }
    } else {
      while (over() && plan[key] > (min[key] ?? 0)) {
        plan[key] -= 1;
        m = measure(plan);
      }
    }
  }
  return { plan, chars: m.chars };
}

// "23.4k" (one decimal, for logs).
export function kChars(n) {
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}
