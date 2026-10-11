// Shared HTTP plumbing for the model providers (STT, TTS, LLM, embeddings).
//
// Every provider talks to some local or remote inference server over HTTP —
// whisper.cpp, Piper, Ollama, or anything that speaks the OpenAI API (vLLM,
// vLLM-Omni, AMD Lemonade, Speaches, llama.cpp server, …). This module keeps
// the boring parts identical across them: base-URL normalisation, optional
// bearer auth, a hard timeout that also covers a stalled body, and error
// messages that carry the provider name and a snippet of the reply.

// Strip trailing slashes; '' / whitespace → ''.
export function baseUrl(raw, fallback = '') {
  const v = String(raw ?? '').trim() || fallback;
  return v.replace(/\/+$/, '');
}

// Read a provider setting from process.env at call time (the settings panel
// applies most keys live), trimming whitespace. Empty → fallback.
export function env(key, fallback = '') {
  const v = process.env[key];
  return (typeof v === 'string' && v.trim() !== '') ? v.trim() : fallback;
}

// Ollama keep_alive as sent in a request body. Ollama parses a string with
// Go's time.ParseDuration, which rejects a bare number ("-1", "0", "3600" →
// HTTP 400); the documented "-1 = forever" only works as a JSON number
// (seconds, negative = forever). Durations with a unit stay strings.
export function keepAliveParam(raw) {
  return /^-?\d+$/.test(String(raw).trim()) ? Number(raw) : raw;
}

export function authHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

// Abort reason used by withTimeout — lets request() tell a timeout (failure)
// apart from the caller cancelling (e.g. barge-in stops a TTS stream).
export class ProviderTimeout extends Error {}

// Combine an optional caller signal with a timeout. Returns { signal, done }
// — call done() once the response is fully consumed so the timer is cleared.
// timeoutMs <= 0 / non-finite → no timeout. Node clamps timers above 2^31-1 ms
// to 1 ms, so absurd values are clamped here instead of aborting instantly.
export function withTimeout(signal, timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return { signal, done: () => {} };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new ProviderTimeout(`timeout after ${ms} ms`)), Math.min(ms, 2 ** 31 - 1));
  timer.unref?.();
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    done: () => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); },
  };
}

// fetch + status check. Throws Error(`${label}: …`) on connection failure or a
// non-2xx reply (with up to 200 chars of the body); an AbortError from the
// caller's own signal is re-thrown untouched so callers can tell "cancelled"
// from "failed". The returned Response's body is NOT consumed.
export async function request(label, url, init = {}) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const reason = init.signal?.aborted ? init.signal.reason : null;
    if (reason instanceof ProviderTimeout) throw new Error(`${label}: ${reason.message} (${url})`);
    if (init.signal?.aborted) throw e; // the caller cancelled — not a failure
    throw new Error(`${label}: connection failed (${url}): ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label}: HTTP ${res.status} (${url}): ${body.slice(0, 200)}`);
  }
  return res;
}

// POST JSON, return parsed JSON. Body read is covered by the same timeout.
export async function postJson(label, url, body, { headers = {}, signal, timeoutMs } = {}) {
  const t = withTimeout(signal, timeoutMs);
  try {
    const res = await request(label, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: t.signal,
    });
    try { return await res.json(); }
    catch (e) {
      const reason = t.signal?.aborted ? t.signal.reason : null;
      if (reason instanceof ProviderTimeout) throw new Error(`${label}: ${reason.message} (${url})`);
      if (t.signal?.aborted) throw e;
      throw new Error(`${label}: invalid JSON from ${url}: ${e.message}`);
    }
  } finally {
    t.done();
  }
}
