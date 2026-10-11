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
// Settings are read per call so a provider/model switch in the settings panel
// takes effect on the next request.

export function llmProvider() {
  const p = env('LLM_PROVIDER', 'ollama').toLowerCase();
  return p === 'openai' ? 'openai' : 'ollama';
}

// Same default as the settings catalog / .env.example / the launchers, which
// pull llama3.2 — a server without OLLAMA_MODEL asked Ollama for an
// unpulled 'llama3' before.
const DEFAULT_OLLAMA_MODEL = 'llama3.2';

// The model used when the caller does not override it.
export function defaultModel() {
  return llmProvider() === 'openai'
    ? env('LLM_MODEL', env('OLLAMA_MODEL', DEFAULT_OLLAMA_MODEL))
    : env('OLLAMA_MODEL', DEFAULT_OLLAMA_MODEL);
}

// Empty (a field cleared in the settings panel) → default: Ollama rejects
// keep_alive "" with HTTP 400, which failed every answer.
function ollamaKeepAlive() {
  return env('OLLAMA_KEEP_ALIVE', '30m');
}

// Public description for the session_meta snapshot / logs.
export function llmConfig() {
  const provider = llmProvider();
  return provider === 'openai'
    ? { provider, url: baseUrl(env('LLM_BASE_URL')), model: defaultModel() }
    : { provider, url: baseUrl(env('OLLAMA_URL'), 'http://localhost:11434'), model: defaultModel(), keepAlive: ollamaKeepAlive() };
}

// complete({ messages, model?, temperature?, maxTokens?, timeoutMs?, signal? })
//   → { content: string, model: string }
// `messages` are OpenAI/Ollama-style { role, content }. Throws on transport
// errors or an empty-looking reply shape; content may still be '' (callers
// decide whether that is a failure).
export async function complete({ messages, model, temperature, maxTokens, timeoutMs, signal } = {}) {
  const m = model || defaultModel();
  if (llmProvider() === 'openai') {
    const base = baseUrl(env('LLM_BASE_URL'));
    if (!base) throw new Error('llm: LLM_PROVIDER=openai but LLM_BASE_URL is empty');
    const body = { model: m, messages, stream: false };
    if (Number.isFinite(temperature)) body.temperature = temperature;
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
    const data = await postJson('llm', `${base}/chat/completions`, body, {
      headers: authHeaders(env('LLM_API_KEY')), signal, timeoutMs,
    });
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('llm: reply has no choices[0].message.content');
    return { content: content.trim(), model: data.model || m };
  }

  const base = baseUrl(env('OLLAMA_URL'), 'http://localhost:11434');
  const body = { model: m, messages, keep_alive: keepAliveParam(ollamaKeepAlive()), stream: false };
  const options = {};
  if (Number.isFinite(temperature)) options.temperature = temperature;
  if (Number.isFinite(maxTokens) && maxTokens > 0) options.num_predict = maxTokens;
  if (Object.keys(options).length) body.options = options;
  const data = await postJson('llm', `${base}/api/chat`, body, { signal, timeoutMs });
  const content = data?.message?.content;
  if (typeof content !== 'string') throw new Error('llm: reply has no message.content');
  return { content: content.trim(), model: data.model || m };
}

// Preload / keep the model resident. Only meaningful for Ollama (an empty
// /api/chat loads the model and resets its keep_alive timer); OpenAI-style
// servers keep their model loaded themselves → no-op. Never throws.
export async function warmUp() {
  if (llmProvider() !== 'ollama') { debug('llm: warm-up skipped (provider has no keep-alive)'); return true; }
  const base = baseUrl(env('OLLAMA_URL'), 'http://localhost:11434');
  const model = defaultModel();
  try {
    await postJson('llm', `${base}/api/chat`, { model, messages: [], keep_alive: keepAliveParam(ollamaKeepAlive()), stream: false }, { timeoutMs: 120_000 });
    debug(`llm: warm-up ok (model=${model}, keep_alive=${ollamaKeepAlive()})`);
    return true;
  } catch (e) {
    warn(`llm: warm-up failed: ${e.message}`);
    return false;
  }
}
