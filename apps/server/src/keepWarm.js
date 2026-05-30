import { log, debug } from './logger.js';
import { warmUp } from './llm.js';

// Keep-warm lifecycle: while the bot is in a voice channel we want the Ollama
// model resident in VRAM so the first wake-word query after a quiet stretch
// isn't stalled by a cold model load (several seconds).
//
// start() is called on a voice_state 'joined'/'occupied' transition, stop() on
// 'left'/'alone'. start() fires an immediate warm-up and then re-pings on an
// interval; each warm-up resets Ollama's keep_alive idle timer. stop() simply
// stops the pings — the model unloads on its own once keep_alive elapses.
//
// Both are idempotent and reference-counting is unnecessary: the bot is bound
// to a single voice channel, so there is at most one active session.

let timer = null;

function intervalMs() {
  // Re-ping a bit more often than the default 30m keep_alive so a long quiet
  // session never lets the model fall out of VRAM. 0/negative disables pings
  // (the keep_alive on each real query still does the work).
  return Number(process.env.OLLAMA_KEEP_WARM_INTERVAL_MS ?? 240000); // 4 min
}

export function startKeepWarm() {
  if (timer) return; // already running
  log('keep-warm: bot joined voice → warming up LLM');
  warmUp();
  const ms = intervalMs();
  if (ms > 0) {
    timer = setInterval(() => {
      debug('keep-warm: periodic ping');
      warmUp();
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  }
}

export function stopKeepWarm() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  log('keep-warm: bot left voice → keep-warm disabled');
}
