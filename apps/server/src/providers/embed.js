import { baseUrl, env, authHeaders, postJson } from './http.js';

// Embedding provider (vault RAG).
//
//   EMBED_PROVIDER=ollama (default)  Ollama /api/embed on OLLAMA_URL
//                                    (keep_alive: EMBED_KEEP_ALIVE, default 30m,
//                                    so the first query after a pause doesn't
//                                    pay a model load).
//   EMBED_PROVIDER=openai            OpenAI-compatible /embeddings on
//                                    EMBED_BASE_URL (incl. /v1), EMBED_API_KEY.
//   EMBED_MODEL                      default nomic-embed-text.
//
// nomic-embed-text was trained with task prefixes and retrieves noticeably
// better with them; they are applied automatically for nomic models and can be
// overridden (or disabled with a single space trimmed to '') via
// EMBED_QUERY_PREFIX / EMBED_DOC_PREFIX. The prefixes are part of what gets
// embedded, so the index records them and re-embeds when they change.

export function embedProvider() {
  return env('EMBED_PROVIDER', 'ollama').toLowerCase() === 'openai' ? 'openai' : 'ollama';
}

export function embedModel() {
  return env('EMBED_MODEL', 'nomic-embed-text');
}

function prefixDefaults(model) {
  return /nomic/i.test(model) ? { query: 'search_query: ', doc: 'search_document: ' } : { query: '', doc: '' };
}

export function embedPrefixes() {
  const d = prefixDefaults(embedModel());
  const q = process.env.EMBED_QUERY_PREFIX;
  const doc = process.env.EMBED_DOC_PREFIX;
  return {
    query: q === undefined ? d.query : q,
    doc: doc === undefined ? d.doc : doc,
  };
}

// Identity of the vector space: changing any of these makes stored vectors
// incomparable with new query vectors → the index must be rebuilt.
export function embedSignature() {
  const p = embedPrefixes();
  return JSON.stringify({ provider: embedProvider(), model: embedModel(), q: p.query, d: p.doc });
}

// embed(texts, { kind: 'query' | 'document', timeoutMs, signal }) → number[][]
// One vector per input, in order. Throws on transport errors or a reply whose
// vector count does not match the input count.
export async function embed(texts, { kind = 'document', timeoutMs, signal } = {}) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (list.length === 0) return [];
  const pre = embedPrefixes();
  const input = list.map((t) => (kind === 'query' ? pre.query : pre.doc) + String(t ?? ''));
  const model = embedModel();

  let vectors;
  if (embedProvider() === 'openai') {
    const base = baseUrl(env('EMBED_BASE_URL'));
    if (!base) throw new Error('embed: EMBED_PROVIDER=openai but EMBED_BASE_URL is empty');
    const data = await postJson('embed', `${base}/embeddings`, { model, input }, {
      headers: authHeaders(env('EMBED_API_KEY')), signal, timeoutMs,
    });
    vectors = Array.isArray(data?.data)
      ? [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding)
      : null;
  } else {
    const base = baseUrl(env('OLLAMA_URL'), 'http://localhost:11434');
    const data = await postJson('embed', `${base}/api/embed`, {
      model, input, keep_alive: env('EMBED_KEEP_ALIVE', '30m'),
    }, { signal, timeoutMs });
    vectors = data?.embeddings ?? null;
  }
  if (!Array.isArray(vectors) || vectors.length !== input.length || !vectors.every((v) => Array.isArray(v) && v.length > 0)) {
    throw new Error(`embed: expected ${input.length} vector(s) from ${embedProvider()}/${model}, got ${Array.isArray(vectors) ? vectors.length : 'none'}`);
  }
  return vectors;
}
