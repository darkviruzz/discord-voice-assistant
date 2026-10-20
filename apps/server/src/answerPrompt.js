import { log as infoLog } from './logger.js';
import { systemPrompt, recentHistory, prefixMessages, answerMessages, promptChars } from './llm.js';
import { liveContextEnabled, renderLiveSplit } from './liveContext.js';
import {
  getCampaignContext, getCampaignContextParts, campaignContextText, campaignContextMaxChars,
} from './campaignContext.js';
import { ragEnabled, DEFAULT_TOP_K } from './rag/index.js';
import { lastSessionSummaries, lastSessionDates, renderLastSessionBlock } from './lastSession.js';
import { promptBudgetChars, fitPrompt, kChars } from './promptBudget.js';

// The answer prompt: its blocks, in an order that lets the LLM server reuse
// its prompt cache (contextPrime.js), within LLM_PROMPT_BUDGET_CHARS
// (promptBudget.js).
//
// Front (system messages, then the history), from the least to the most often
// changing part:
//   static CAMPAIGN.md (only when RAG is off) → last session(s) → rolling
//   summary → live transcript up to the primed cut → recent history.
// Tail (the user message, llm.js): the transcript lines since the cut (the
// question's own line among them) → vault RAG hits (or the CAMPAIGN.md
// fallback when RAG finds nothing) → "Frage: …".
// The last-session block is the recap source ("Was war letztes Mal?", /recap):
// it goes in outside a voice session too, and without live context it is the
// only block besides the history.
//
// Budget. The front is primed ahead of time, so changing it costs a re-prime
// (~3 s) and, if a question changes it, that question waits for it. So:
// 1. The front is fitted ahead of time against the budget minus a reserve for
//    the largest tail: CAMPAIGN_CONTEXT_MAX_CHARS for the RAG hits plus
//    TAIL_RESERVE_CHARS for the newest lines and the question. It drops, in
//    this order, the oldest session summaries (down to the newest), the
//    oldest history turns (down to 2), part of the RAG reserve (down to one
//    hit's share) and the oldest live-transcript lines. The prime and the
//    answer compute it from the same inputs, so they get the same front. As
//    the session context grows, older sessions drop out at a prime, which runs
//    in the background, and a question never has to wait for that.
// 2. The answer then fits its real tail: the weakest RAG hits go first (down
//    to 1), which leaves the primed front alone. Only a tail bigger than the
//    reserve trims the front further, in the order of step 1, and last the
//    newest lines.
// Without priming (LLM_PRIME off, or a text query outside a voice session)
// there is no cache to keep: one pass over the real prompt, in the order of
// step 1.
// Hysteresis: a session summary dropped in a voice session stays dropped for
// that session, so the primed front does not flip back and forth.

// Reserve for the tail besides the RAG hits: the newest live lines since the
// last prime (usually the question's own line and a few more), their heading,
// "Frage: " and the question.
export const TAIL_RESERVE_CHARS = 1000;

const RAG_HEADING = 'Kampagnen-Kontext:\n';
const FRONT_ORDER = ['sessions', 'history', 'rag', 'live'];
const TAIL_FIRST_ORDER = ['rag', 'sessions', 'history', 'live', 'fresh'];
const ONE_PASS_ORDER = ['sessions', 'history', 'rag', 'live', 'fresh'];

const turnsOf = (history) => Math.ceil(history.length / 2);

// What the RAG hits may take in the tail, reserved for the front: `slots` of
// DEFAULT_TOP_K equal shares of CAMPAIGN_CONTEXT_MAX_CHARS, plus the heading.
function ragReserve(slots) {
  if (!(slots > 0)) return 0;
  return RAG_HEADING.length + 2 + Math.ceil(campaignContextMaxChars() * Math.min(slots, DEFAULT_TOP_K) / DEFAULT_TOP_K);
}

// createAnswerPrompt({ campaignParts(query) → Promise<string[]>, campaignStatic() → Promise<string>, log })
//   → { front(session), answer(session, history, query, { cut, primed }) }
// campaignParts/campaignStatic/log are replaceable for tests. State (dropped
// summaries, the last logged trim) lives per session, or per history array for
// text queries outside a voice session.
export function createAnswerPrompt({
  campaignParts = getCampaignContextParts,
  campaignStatic = () => getCampaignContext(null),
  log = infoLog,
} = {}) {
  const states = new WeakMap();
  const stateOf = (key) => {
    let st = states.get(key);
    if (!st) { st = { sessionsCap: Infinity, report: '' }; states.set(key, st); }
    return st;
  };

  // Everything one prompt can hold, fetched once (the base system prompt,
  // CAMPAIGN.md, the RAG lookup), so render() builds any plan without I/O.
  async function gather(session, history, { cut = null, query = null } = {}) {
    const live = liveContextEnabled();
    const ragTail = live && ragEnabled();
    return {
      session, cut, live, ragTail,
      system: systemPrompt(),
      summaries: lastSessionSummaries(),
      campaign: live && !ragTail ? await campaignStatic() : '',
      summary: live ? String(session?.liveContext?.summary ?? '').trim() : '',
      history: recentHistory(history),
      ragParts: query != null && ragTail ? await campaignParts(query) : [],
    };
  }

  // The blocks under `plan` (promptBudget.js fitPrompt), plus the rendered
  // length of both live parts and the newest entry of the primed one.
  function render(p, plan) {
    const lastSession = renderLastSessionBlock(p.summaries, { keep: plan.sessions });
    const history = plan.history > 0 ? p.history.slice(-plan.history * 2) : [];
    if (!p.live) return { systemBlocks: lastSession ? [lastSession] : [], history, contextBlocks: [], last: null, live: 0, fresh: 0 };
    const systemBlocks = [];
    if (p.campaign) systemBlocks.push(`${RAG_HEADING}${p.campaign}`);
    if (lastSession) systemBlocks.push(lastSession);
    if (p.summary) systemBlocks.push(`Bisheriger Gesprächsverlauf (Zusammenfassung):\n${p.summary}`);
    const { primed, fresh, last } = renderLiveSplit(p.session, p.cut, { primedMax: plan.live, freshMax: plan.fresh });
    if (primed) systemBlocks.push(`Aktuelles Live-Transkript der Runde:\n${primed}`);
    const contextBlocks = [];
    if (fresh) contextBlocks.push(`Neueste Beiträge im Live-Transkript (Fortsetzung):\n${fresh}`);
    const rag = campaignContextText(p.ragParts.slice(0, plan.rag));
    if (rag) contextBlocks.push(`${RAG_HEADING}${rag}`);
    return { systemBlocks, history, contextBlocks, last, live: primed.length, fresh: fresh.length };
  }

  const untrimmed = (p) => ({
    sessions: p.summaries.length, history: turnsOf(p.history), rag: p.ragParts.length, live: Infinity, fresh: Infinity,
  });

  // Step 1: the front, fitted with the tail reserve.
  function frontPlan(p, st, budget) {
    const start = {
      ...untrimmed(p),
      sessions: Math.min(p.summaries.length, st.sessionsCap),
      rag: p.ragTail ? DEFAULT_TOP_K : 0,
    };
    const measure = (plan) => {
      const r = render(p, plan);
      const front = promptChars(prefixMessages(r.systemBlocks, r.history, p.system));
      return { chars: front + TAIL_RESERVE_CHARS + ragReserve(plan.rag), live: r.live, fresh: 0 };
    };
    return fitPrompt({ budget, start, measure, order: FRONT_ORDER }).plan;
  }

  function noteDropped(st, plan, p) {
    if (plan.sessions < p.summaries.length) st.sessionsCap = Math.min(st.sessionsCap, plan.sessions);
  }

  // One INFO line whenever what is trimmed changes; nothing while it stays.
  function report(st, p, plan, { full, chars, budget }) {
    const parts = [];
    if (plan.sessions < p.summaries.length) {
      const dropped = lastSessionDates(p.summaries.slice(plan.sessions)).map((d) => d || '?');
      parts.push(`dropped session${dropped.length > 1 ? 's' : ''} ${dropped.join(', ')}`);
    }
    if (plan.history < turnsOf(p.history)) parts.push(`history ${turnsOf(p.history)}→${plan.history}`);
    if (plan.rag < p.ragParts.length) parts.push(`RAG hits ${p.ragParts.length}→${plan.rag}`);
    if (plan.live !== Infinity || plan.fresh !== Infinity) parts.push('live transcript shortened');
    const text = parts.join(', ');
    if (text === st.report) return;
    st.report = text;
    if (!text) log(`prompt budget: ${kChars(full)} ≤ ${kChars(budget)} chars — nothing trimmed`);
    else if (full > budget) log(`prompt budget: ${kChars(full)} > ${kChars(budget)} chars — ${text} → ${kChars(chars)}`);
    else log(`prompt budget: ${kChars(full)} ≤ ${kChars(budget)} chars — ${text} → ${kChars(chars)} (front kept short for the prime)`);
  }

  // The front a prime sends for `session`: { systemBlocks, history, last }
  // (last = the newest live entry in it, the primer's cut).
  async function front(session) {
    const budget = promptBudgetChars();
    const p = await gather(session, session?.conversationHistory);
    let plan = untrimmed(p);
    if (budget) {
      const st = stateOf(session);
      plan = frontPlan(p, st, budget);
      noteDropped(st, plan, p);
    }
    const { systemBlocks, history, last } = render(p, plan);
    return { systemBlocks, history, last };
  }

  // The prompt for one question: { systemBlocks, history, contextBlocks } for
  // llm.js chat(). `cut` = the primer's cut for the session, `primed` = whether
  // a primer keeps the session's front cached.
  async function answer(session, history, query, { cut = null, primed = false } = {}) {
    const budget = promptBudgetChars();
    const p = await gather(session, history, { cut, query });
    const full = untrimmed(p);
    let plan = full;
    if (budget) {
      const st = stateOf(session ?? history);
      const measure = (pl) => {
        const r = render(p, pl);
        return { chars: promptChars(answerMessages(r.systemBlocks, r.history, query, r.contextBlocks, p.system)), live: r.live, fresh: r.fresh };
      };
      const start = primed && session
        ? { ...frontPlan(p, st, budget), rag: p.ragParts.length, fresh: Infinity }
        : { ...full, sessions: Math.min(full.sessions, st.sessionsCap) };
      const fit = fitPrompt({ budget, start, measure, order: primed && session ? TAIL_FIRST_ORDER : ONE_PASS_ORDER });
      plan = fit.plan;
      if (session) noteDropped(st, plan, p);
      report(st, p, plan, { full: measure(full).chars, chars: fit.chars, budget });
    }
    const { systemBlocks, history: kept, contextBlocks } = render(p, plan);
    return { systemBlocks, history: kept, contextBlocks };
  }

  return { front, answer };
}
