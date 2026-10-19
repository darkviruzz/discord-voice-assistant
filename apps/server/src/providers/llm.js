import { debug, warn } from '../logger.js';
import { baseUrl, env, authHeaders, postJson, keepAliveParam } from './http.js';

// LLM provider — one chat-completion call for every LLM use in the server
// (wake-word/text answers, rolling summary, finalize session summary).
//
//   LLM_PROVIDER=ollama (default)  native Ollama /api/chat: OLLAMA_URL,
//                                  OLLAMA_MODEL, OLLAMA_KEEP_ALIVE (keeps the
//                                  model resident; warmUp() preloads it).
//   LLM_PROVIDER=openai            any OpenAI-compatible /chat/completions:
//                                  LLM_BASE_URL (incl. /v1), LLM_MODEL,
//                                  LLM_API_KEY (optional). Works with vLLM,
//                                  AMD Lemonade, llama.cpp server, LM Studio,
//                                  and Ollama's own /v1 endpoint.
//
// Summaries (role 'summary') can go to a server of their own: SUMMARY_PROVIDER,
// SUMMARY_BASE_URL, SUMMARY_API_KEY, SUMMARY_MODEL — each empty = the main
// LLM setting (see llmEndpoint()).
//
// Settings are read per call so a provider/model switch in the settings panel
// takes effect on the next request.

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

function providerName(raw) {
  return String(raw).toLowerCase() === 'openai' ? 'openai' : 'ollama';
}

export function llmProvider() {
  return providerName(env('LLM_PROVIDER', 'ollama'));
}

// Same default as the settings catalog / .env.example / the launchers, which
// pull llama3.2 — a server without OLLAMA_MODEL asked Ollama for an
// unpulled 'llama3' before.
const DEFAULT_OLLAMA_MODEL = 'llama3.2';

function providerDefaultModel(provider) {
  return provider === 'openai'
    ? env('LLM_MODEL', env('OLLAMA_MODEL', DEFAULT_OLLAMA_MODEL))
    : env('OLLAMA_MODEL', DEFAULT_OLLAMA_MODEL);
}

function providerBase(provider) {
  return provider === 'openai' ? baseUrl(env('LLM_BASE_URL')) : baseUrl(env('OLLAMA_URL'), DEFAULT_OLLAMA_URL);
}

// The model used when the caller does not override it.
export function defaultModel() {
  return providerDefaultModel(llmProvider());
}

// Empty (a field cleared in the settings panel) → default: Ollama rejects
// keep_alive "" with HTTP 400, which failed every answer.
function ollamaKeepAlive() {
  return env('OLLAMA_KEEP_ALIVE', '30m');
}

// Where a call goes. role 'answer' (default) = the main LLM. role 'summary'
// (rolling summary + finalize session summary) = SUMMARY_PROVIDER /
// SUMMARY_BASE_URL / SUMMARY_MODEL, each falling back to the main setting
// (SUMMARY_BASE_URL empty → LLM_BASE_URL resp. OLLAMA_URL of that provider).
// The key is SUMMARY_API_KEY; LLM_API_KEY is only reused when the summary goes
// to the main server, so it never leaves for a host it wasn't set for. `main`
// = same server as the answers (gets the LLM_REASONING_EFFORT /
// LLM_CHAT_TEMPLATE_KWARGS extras, which are that server's dialect).
export function llmEndpoint(role = 'answer') {
  const mainProvider = llmProvider();
  if (role !== 'summary') {
    return {
      provider: mainProvider,
      base: providerBase(mainProvider),
      apiKey: mainProvider === 'openai' ? env('LLM_API_KEY') : '',
      model: defaultModel(),
      main: true,
    };
  }
  const raw = env('SUMMARY_PROVIDER');
  const provider = raw ? providerName(raw) : mainProvider;
  const ownBase = baseUrl(env('SUMMARY_BASE_URL'));
  const base = ownBase || providerBase(provider);
  const main = provider === mainProvider && base === providerBase(mainProvider);
  // A key only goes to an address that is env-only itself (SUMMARY_BASE_URL,
  // LLM_BASE_URL) — never to OLLAMA_URL, which the settings panel can change.
  const keyed = !!ownBase || provider === 'openai';
  return {
    provider,
    base,
    apiKey: !keyed ? '' : env('SUMMARY_API_KEY') || (main && provider === 'openai' ? env('LLM_API_KEY') : ''),
    model: env('SUMMARY_MODEL') || providerDefaultModel(provider),
    main,
  };
}

// Model for the rolling and the finalize session summary.
export function summaryModel() {
  return llmEndpoint('summary').model;
}

// Ollama `think`. Reasoning models (gemma4, qwen3, deepseek-r1 …) otherwise
// think before they answer: on 2026-10-18 gemma4:12b generated 1506 tokens
// (42.6 s) for a 290-char wake-word answer. LLM_THINK:
//   false (default) → think:false, answer directly
//   true            → think:true
//   low|medium|high → think level (gpt-oss, which cannot switch thinking off)
//   auto            → field not sent, the model's own default
// Anything else counts as false (fast is the safe side for a live answer).
export function thinkSetting() {
  const v = env('LLM_THINK', 'false').toLowerCase();
  if (v === 'auto') return null;
  if (v === 'true') return true;
  if (['low', 'medium', 'high'].includes(v)) return v;
  return false;
}

// OpenAI-compatible reasoning opt-ins. Nothing is sent unless configured: a
// strict server rejects fields it doesn't know.
//   LLM_REASONING_EFFORT      → reasoning_effort (none/minimal/low/medium/high)
//   LLM_CHAT_TEMPLATE_KWARGS  → chat_template_kwargs, a JSON object, e.g.
//                               {"enable_thinking":false} (vLLM, llama.cpp, SGLang)
let badKwargsWarned = null;
function openaiExtras() {
  const out = {};
  const effort = env('LLM_REASONING_EFFORT');
  if (effort) out.reasoning_effort = effort;
  const kw = env('LLM_CHAT_TEMPLATE_KWARGS');
  if (kw) {
    let obj = null;
    try { obj = JSON.parse(kw); } catch { /* reported below */ }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.chat_template_kwargs = obj;
    else if (badKwargsWarned !== kw) {
      badKwargsWarned = kw;
      warn('llm: LLM_CHAT_TEMPLATE_KWARGS is not a JSON object — not sent');
    }
  }
  return out;
}

// Public description for the session_meta snapshot / logs.
export function llmConfig() {
  const provider = llmProvider();
  if (provider === 'openai') {
    const x = openaiExtras();
    return {
      provider, url: providerBase(provider), model: defaultModel(),
      reasoningEffort: x.reasoning_effort ?? null,
      chatTemplateKwargs: x.chat_template_kwargs ?? null,
    };
  }
  return { provider, url: providerBase(provider), model: defaultModel(), keepAlive: ollamaKeepAlive(), think: thinkSetting() };
}

// The summary endpoint for session_meta (no key, only whether one is set).
export function summaryConfig() {
  const ep = llmEndpoint('summary');
  return { provider: ep.provider, url: ep.base, model: ep.model, sameServer: ep.main, apiKey: !!ep.apiKey };
}

// base|model|think combinations Ollama answered with HTTP 400 "… does not
// support thinking" (e.g. LLM_THINK=true on llama3.2). They are asked again
// without `think`, and remembered, so a wrong setting costs one round-trip
// once instead of failing every answer. Keyed with the think value: switching
// LLM_THINK back to false must send false again.
const thinkRejected = new Set();

async function ollamaChat(ep, body, { signal, timeoutMs } = {}) {
  const url = `${ep.base}/api/chat`;
  const think = thinkSetting();
  const key = `${ep.base}|${body.model}|${think}`;
  const opts = { headers: authHeaders(ep.apiKey), signal, timeoutMs };
  if (think === null || thinkRejected.has(key)) return postJson('llm', url, body, opts);
  try {
    return await postJson('llm', url, { ...body, think }, opts);
  } catch (e) {
    if (!/HTTP 400\b[\s\S]*think/i.test(e.message)) throw e;
    thinkRejected.add(key);
    warn(`llm: ${body.model} rejects think=${JSON.stringify(think)} — asking without it (LLM_THINK)`);
    return postJson('llm', url, body, opts);
  }
}

// complete({ messages, model?, role?, temperature?, maxTokens?, timeoutMs?, signal? })
//   → { content: string, model: string }
// `messages` are OpenAI/Ollama-style { role, content }; `role` picks the
// endpoint ('answer' default, 'summary' — see llmEndpoint()). Throws on
// transport errors or an empty-looking reply shape; content may still be ''
// (callers decide whether that is a failure).
export async function complete({ messages, model, role = 'answer', temperature, maxTokens, timeoutMs, signal } = {}) {
  const ep = llmEndpoint(role);
  const m = model || ep.model;
  if (ep.provider === 'openai') {
    if (!ep.base) {
      throw new Error(role === 'summary' && env('SUMMARY_PROVIDER')
        ? 'llm: SUMMARY_PROVIDER=openai but neither SUMMARY_BASE_URL nor LLM_BASE_URL is set'
        : 'llm: LLM_PROVIDER=openai but LLM_BASE_URL is empty');
    }
    const body = { model: m, messages, stream: false, ...(ep.main ? openaiExtras() : {}) };
    if (Number.isFinite(temperature)) body.temperature = temperature;
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
    const data = await postJson('llm', `${ep.base}/chat/completions`, body, {
      headers: authHeaders(ep.apiKey), signal, timeoutMs,
    });
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('llm: reply has no choices[0].message.content');
    return { content: content.trim(), model: data.model || m };
  }

  const body = { model: m, messages, keep_alive: keepAliveParam(ollamaKeepAlive()), stream: false };
  const options = {};
  if (Number.isFinite(temperature)) options.temperature = temperature;
  if (Number.isFinite(maxTokens) && maxTokens > 0) options.num_predict = maxTokens;
  if (Object.keys(options).length) body.options = options;
  const data = await ollamaChat(ep, body, { signal, timeoutMs });
  const content = data?.message?.content;
  if (typeof content !== 'string') throw new Error('llm: reply has no message.content');
  return { content: content.trim(), model: data.model || m };
}

// Preload / keep the model resident. Only meaningful for Ollama (an empty
// /api/chat loads the model and resets its keep_alive timer); OpenAI-style
// servers keep their model loaded themselves → no-op. Never throws.
export async function warmUp() {
  const ep = llmEndpoint();
  if (ep.provider !== 'ollama') { debug('llm: warm-up skipped (provider has no keep-alive)'); return true; }
  try {
    await ollamaChat(ep, { model: ep.model, messages: [], keep_alive: keepAliveParam(ollamaKeepAlive()), stream: false }, { timeoutMs: 120_000 });
    debug(`llm: warm-up ok (model=${ep.model}, keep_alive=${ollamaKeepAlive()})`);
    return true;
  } catch (e) {
    warn(`llm: warm-up failed: ${e.message}`);
    return false;
  }
}

// Test hook: forget the think rejections and the kwargs warning.
export function _resetLlmState() { thinkRejected.clear(); badKwargsWarned = null; }
