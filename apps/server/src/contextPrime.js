import { createHash } from 'crypto';
import { debug } from './logger.js';

// Prompt priming for wake-word answers.
//
// What makes an answer slow is prompt processing, not generation. On
// 2026-10-19, gemma4:12b on Ollama/Vulkan (RX 6800 XT) read ~330 tokens/s, so a
// 5k-token answer prompt took 15 s before the first word. The llama.cpp server
// behind Ollama keeps a prompt cache, but gemma4 uses sliding-window attention.
// Its cache can only resume from a checkpoint, and checkpoints are made just
// before the end of a prompt. A question whose prompt shares the front with the
// last one, but whose own tail (RAG hits, question) is longer than ~1000
// tokens, was therefore processed from token 0 every time (measured: 5.3k of
// 5.3k tokens).
//
// So while a voice session runs, the stable front of the next answer prompt is
// sent on its own whenever it changes. llm.js primeChat sends the base system
// prompt, last session, rolling summary, live transcript and recent history,
// and asks for one generated token. That request ends exactly where the next
// question's tail begins, and its end-of-prompt checkpoint is what the question
// resumes from. Measured on the same setup:
// - a question then cost 1.5k tokens (6 s) instead of 5.3k (16 s);
// - a prime after two new transcript lines cost 0.8 s;
// - a prime after an answer, which moved the cache past the front, cost ~4 s.
//
// The checkpoint sits a few tokens before the end of the primed prompt. A
// transcript line appended to the primed live block changes the tokens right
// after its last line, so the question could only resume from the previous
// checkpoint, ~1000 tokens earlier. This hits the question's own line, which
// is in the buffer before the answer is built. The answer therefore keeps the
// live block as primed (cutFor) and moves newer lines into its tail, next to
// the RAG hits (answerPrompt.js).
//
// Scheduling, per session:
// - a change schedules one prime after LLM_PRIME_DELAY_MS;
// - changes while one is pending or running only mark the session dirty, and a
//   prime runs again afterwards;
// - nothing starts while an answer is being built for that session (the answer
//   processes the front itself); changes made meanwhile are primed after it;
// - a front identical to the last primed one is not sent again.
// Ollama runs one request at a time (OLLAMA_NUM_PARALLEL=1): a question that
// arrives during a prime waits for it, then resumes from what it processed.
//
// LLM_PRIME: auto (default) = on for LLM_PROVIDER=ollama, off for openai (a
// hosted API would bill and rate-limit every prime); true / false force it.

export function primeEnabledFor(provider) {
  const v = String(process.env.LLM_PRIME ?? 'auto').trim().toLowerCase();
  if (/^(1|true|yes|on)$/.test(v)) return true;
  if (/^(0|false|no|off)$/.test(v)) return false;
  return provider === 'ollama';
}

export function primeDelayMs() {
  const n = Number(process.env.LLM_PRIME_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : 2500;
}

const fingerprint = (prefix) => createHash('sha1').update(JSON.stringify(prefix)).digest('hex');

// createPrimer({ buildPrefix(session) → Promise<{ prefix, cut }>, prime(prefix) → Promise,
//                enabled() → bool, delayMs() → number })
//   → { schedule(session), answerStarted(session), answerFinished(session),
//       cutFor(session), idle(session) }
// `prefix` is whatever prime() sends (compared by its JSON to skip repeats);
// `cut` is the caller's marker of what the prefix covered (the newest
// live-transcript entry), handed back by cutFor() once that prefix is primed.
// Sessions are any objects (state lives in a WeakMap). Never throws; a failed
// prime is logged at debug level and retried on the next change.
export function createPrimer({ buildPrefix, prime, enabled = () => true, delayMs = primeDelayMs }) {
  const states = new WeakMap();
  const stateOf = (session) => {
    let st = states.get(session);
    if (!st) {
      st = { timer: null, running: null, dirty: false, answering: 0, lastKey: null, cut: null };
      states.set(session, st);
    }
    return st;
  };

  async function run(session, st) {
    st.timer = null;
    if (st.answering > 0 || !enabled()) return; // answerFinished() re-schedules
    st.dirty = false;
    st.running = (async () => {
      try {
        const { prefix, cut = null } = await buildPrefix(session);
        const key = fingerprint(prefix);
        if (key === st.lastKey) { st.cut = cut; return; }
        const t = Date.now();
        await prime(prefix);
        st.lastKey = key;
        st.cut = cut;
        debug(`llm-prime: front primed in ${Date.now() - t} ms (${JSON.stringify(prefix).length} chars)`);
      } catch (e) {
        debug('llm-prime: failed —', e.message);
      }
    })();
    try { await st.running; } finally {
      st.running = null;
      if (st.dirty) schedule(session);
    }
  }

  function schedule(session) {
    if (!session || !enabled()) return;
    const st = stateOf(session);
    st.dirty = true;
    if (st.timer || st.running || st.answering > 0) return;
    st.timer = setTimeout(() => { run(session, st); }, delayMs());
    st.timer.unref?.();
  }

  function answerStarted(session) {
    if (!session) return;
    stateOf(session).answering++;
  }

  // Changes that came in while the answer was being built (its own reply in
  // the live transcript, at least) are primed now. An unchanged front is not:
  // the checkpoint of the last prime survives the answer and still matches.
  function answerFinished(session) {
    if (!session) return;
    const st = stateOf(session);
    st.answering = Math.max(0, st.answering - 1);
    if (st.dirty) schedule(session);
  }

  // The cut of the last primed prefix (null before the first one).
  function cutFor(session) {
    return session ? states.get(session)?.cut ?? null : null;
  }

  // Test hook: resolves once no prime is pending or running for `session`.
  async function idle(session) {
    const st = states.get(session);
    while (st && (st.timer || st.running)) {
      if (st.running) await st.running;
      else await new Promise((r) => setTimeout(r, 5));
    }
  }

  return { schedule, answerStarted, answerFinished, cutFor, idle };
}
