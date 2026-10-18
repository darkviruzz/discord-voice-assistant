import { log, debug, warn } from '../logger.js';
import { baseUrl, env, authHeaders, withTimeout, request, ProviderTimeout } from './http.js';
import { currentVocabulary, sttPrompt } from '../sttVocabulary.js';

// STT provider — one transcription call for every STT use in the server
// (streaming ticks, the utterance-end pass, the chunked fallback and the
// finalize re-STT all end up in transcribe() below).
//
//   STT_PROVIDER=whispercpp (default)  whisper.cpp server's native
//                                      POST /inference on WHISPER_URL.
//   STT_PROVIDER=openai                any OpenAI-compatible
//                                      POST /audio/transcriptions: STT_BASE_URL
//                                      (incl. /v1), STT_MODEL (empty = field
//                                      omitted → server default), STT_API_KEY
//                                      (optional bearer). Works with vLLM
//                                      (Whisper/Voxtral), AMD Lemonade,
//                                      Speaches, and whisper.cpp itself when
//                                      started with
//                                      --inference-path /v1/audio/transcriptions.
//
// Shared by both: STT_LANGUAGE (provider-neutral; empty → WHISPER_LANGUAGE,
// which the whisper.cpp launch scripts also use; 'auto' = let the model
// detect), WHISPER_TEMPERATURE, WHISPER_WORD_TIMESTAMPS and STT_TIMEOUT_MS
// (default 120 s, covers connect + upload + reading the reply; 0 = none).
// Every request's `prompt` is the campaign vocabulary (STT_VOCABULARY /
// STT_VOCABULARY_FILE, see sttVocabulary.js) followed by the caller's context.
//
// Settings are read per call so a provider/URL/model switch in the settings
// panel takes effect on the next request (= the next streaming tick).

const DEFAULT_WHISPER_URL = 'http://localhost:8080';
const DEFAULT_TIMEOUT_MS = 120_000;

export function sttProvider() {
  return env('STT_PROVIDER', 'whispercpp').toLowerCase() === 'openai' ? 'openai' : 'whispercpp';
}

// Label persisted into the per-utterance `stt` metadata (JSONL / finalize).
// whisper.cpp keeps its historical 'whisper.cpp' so old and new logs agree.
export function sttProviderLabel(provider = sttProvider()) {
  return provider === 'openai' ? 'openai' : 'whisper.cpp';
}

function sttLanguage() {
  return env('STT_LANGUAGE', env('WHISPER_LANGUAGE', 'auto'));
}

function sttTemperature() {
  return Number(process.env.WHISPER_TEMPERATURE ?? 0.2);
}

function wordTimestamps() {
  return (process.env.WHISPER_WORD_TIMESTAMPS ?? 'true') !== 'false';
}

function sttTimeoutMs() {
  const n = Number(env('STT_TIMEOUT_MS', String(DEFAULT_TIMEOUT_MS)));
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TIMEOUT_MS;
}

// Public description for the session_meta snapshot / logs. Never contains the
// API key — only whether one is configured.
export function sttConfig() {
  const provider = sttProvider();
  const vocab = currentVocabulary();
  const common = {
    provider: sttProviderLabel(provider),
    language: sttLanguage(),
    temperature: sttTemperature(),
    wordTimestamps: wordTimestamps(),
    timeoutMs: sttTimeoutMs(),
    // The names actually prompted (after the budget cut) — which list a
    // session was transcribed with.
    vocabulary: { names: vocab.used, dropped: vocab.dropped.length, file: vocab.file },
  };
  return provider === 'openai'
    ? { ...common, url: baseUrl(env('STT_BASE_URL')) || null, model: env('STT_MODEL') || null, apiKeySet: !!env('STT_API_KEY') }
    : { ...common, url: baseUrl(env('WHISPER_URL'), DEFAULT_WHISPER_URL) };
}

// ── Text / word normalisation ────────────────────────────────────────────────

// whisper.cpp puts newlines into the `text` field at its internal segment/token
// boundaries. With word-level timestamps requested it splits down to token level
// (like -ml 1) and, without split-on-word, some breaks land INSIDE a word
// (tokens are sub-word pieces) — e.g. "Entwicklung befind\nliche". Naively
// turning every \n into a space would leave "befind liche".
//
// Heuristic: whisper prefixes a leading space before a NEW word but not before a
// mid-word token continuation. So a newline directly followed by a lowercase
// letter (no space) is a mid-word split → join with no space; every other
// newline is a real word/segment boundary → single space.
//
// Applied to both providers: an OpenAI-compatible server may itself be
// whisper.cpp (same text quirks); real OpenAI-style servers return one line.
export function cleanWhisperText(s) {
  return String(s || '')
    .replace(/(\p{L})\n(\p{Ll})/gu, '$1$2') // letter \n lowercase (no space) → join word
    .replace(/\s*\n\s*/g, ' ')              // remaining newlines → single space
    .replace(/[ \t]{2,}/g, ' ')             // collapse runs of spaces
    .trim();
}

// Same normalisation as sttStreaming.normWord (not imported: that module pulls
// in the native opus codec, which a provider has no business loading).
function norm(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Normalize Whisper word/token timestamps from whatever shape the server
// returned into a flat [{ w, t0, t1, raw }] array, times in SECONDS relative
// to the submitted audio. Handles:
//   - OpenAI-style top-level `words: [{ word, start, end }]`
//   - per-segment `words` arrays (whisper.cpp with token timestamps)
// Returns null when no word-level data is present → caller falls back to
// utterance-level timing.
export function parseWords(data) {
  const out = [];
  const push = (w) => {
    const t0 = Number(w.start ?? w.t0 ?? w.from);
    const t1 = Number(w.end ?? w.t1 ?? w.to);
    const raw = String(w.word ?? w.text ?? w.w ?? '');
    const word = raw.trim();
    if (!word || !Number.isFinite(t0)) return;
    // `raw` keeps whisper's leading-space convention (space = new word, none =
    // sub-word continuation) so sttStreaming can rebuild words from tokens.
    out.push({ w: word, t0, t1: Number.isFinite(t1) ? t1 : t0, raw });
  };
  if (Array.isArray(data?.words)) data.words.forEach(push);
  if (out.length === 0 && Array.isArray(data?.segments)) {
    for (const seg of data.segments) {
      if (Array.isArray(seg.words)) seg.words.forEach(push);
    }
  }
  return out.length > 0 ? out : null;
}

// Word-level providers (OpenAI, vLLM) return WHOLE words without whisper's
// leading-space token convention: "Hallo", "Welt" — not " Hallo", " Welt".
// mergeTokensToWords() (sttStreaming / pipeline) reads a missing leading space
// as "continues the previous word" and would glue them into "HalloWelt".
//
// Token-style lists always carry leading spaces (every word after the first
// starts with one — whisper.cpp tokens, faster-whisper/Speaches words), so:
// no raw starts with whitespace → whole words → give each one the leading space
// that marks a new word. Lists with any leading space are left untouched.
//
// OpenAI's words also drop punctuation ("Hallo", "Welt" for "Hallo, Welt!"),
// but the streaming path builds its live text FROM the words and trims its
// window at sentence ends — so punctuation is re-attached from `text`: walk the
// text's whitespace tokens in order and take the one whose letters/digits match
// (small look-ahead for tokens the word list skipped). Unmatched words keep
// their bare form.
export function normalizeWordList(words, text) {
  if (!Array.isArray(words) || words.length === 0) return words;
  if (words.some((w) => /^\s/.test(w.raw ?? ''))) return words;
  const toks = String(text || '').split(/\s+/).filter(Boolean);
  let j = 0;
  return words.map((w) => {
    const n = norm(w.w);
    let display = w.w;
    if (n) {
      for (let k = j; k < Math.min(toks.length, j + 4); k++) {
        if (norm(toks[k]) === n) { display = toks[k]; j = k + 1; break; }
      }
    }
    return { ...w, w: display, raw: ` ${display}` };
  });
}

// Segment-level diagnostics. `no_speech_prob` is weighted by segment text
// length (a long confident segment outweighs a short noisy one).
function buildMeta(data, { language, temperature }) {
  const segments = Array.isArray(data?.segments) ? data.segments : [];
  const meta = {
    language: data?.language ?? (language === 'auto' ? null : language),
    temperature,
    segmentCount: segments.length,
    noSpeechProbAvg: null,
    noSpeechProbMax: null,
  };
  let weightedSum = 0;
  let totalWeight = 0;
  let maxProb = null;
  for (const s of segments) {
    const p = typeof s.no_speech_prob === 'number' ? s.no_speech_prob : null;
    if (p === null) continue;
    const w = Math.max(1, (s.text ?? '').trim().length);
    weightedSum += p * w;
    totalWeight += w;
    maxProb = maxProb === null ? p : Math.max(maxProb, p);
  }
  if (totalWeight > 0) {
    const avg = weightedSum / totalWeight;
    meta.noSpeechProbAvg = avg;
    meta.noSpeechProbMax = maxProb;
    debug(`stt: no_speech_prob avg=${avg.toFixed(2)}`);
  }
  return meta;
}

// ── Transport ────────────────────────────────────────────────────────────────

function wavForm(wavBuffer) {
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  return form;
}

// POST multipart and read the reply; one timeout covers connect, upload and
// the body. Returns parsed JSON, or { text } for a text/plain reply (servers
// that ignore response_format, or response_format=text). A reply that claims
// JSON but does not parse is an error; one without a content type is tried as
// JSON first, then taken as plain text.
async function postForm(url, form, { headers = {}, signal } = {}) {
  const t = withTimeout(signal, sttTimeoutMs());
  try {
    const res = await request('stt', url, { method: 'POST', headers, body: form, signal: t.signal });
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    let body;
    try { body = await res.text(); }
    catch (e) {
      const reason = t.signal?.aborted ? t.signal.reason : null;
      if (reason instanceof ProviderTimeout) throw new Error(`stt: ${reason.message} (${url})`);
      if (t.signal?.aborted) throw e; // the caller cancelled — not a failure
      throw new Error(`stt: reading reply from ${url} failed: ${e.message}`);
    }
    if (type.includes('json') || (!type && /^\s*[{["]/.test(body))) {
      let data;
      try { data = JSON.parse(body); }
      catch (e) { throw new Error(`stt: invalid JSON from ${url}: ${e.message}`); }
      // A bare JSON string ("hallo") is a text reply too.
      return (data && typeof data === 'object' && !Array.isArray(data)) ? data : { text: typeof data === 'string' ? data : '' };
    }
    return { text: body };
  } finally {
    t.done();
  }
}

// ── Providers ────────────────────────────────────────────────────────────────

async function transcribeWhisperCpp(wavBuffer, { prompt, signal, language, temperature }) {
  const base = baseUrl(env('WHISPER_URL'), DEFAULT_WHISPER_URL);
  const form = wavForm(wavBuffer);
  if (language !== 'auto') form.append('language', language);
  form.append('response_format', 'verbose_json');
  form.append('temperature', String(temperature));
  // Vocabulary + already-locked streaming text (transcribe() builds it within
  // 500 chars): names spelled as in the campaign, and wording that stays
  // stable across the window boundary. The slice is only a safety net.
  if (prompt) form.append('prompt', String(prompt).slice(-500));
  // Ask for word-level timestamps. Harmless if the server ignores it (older
  // whisper.cpp builds); parseWords() falls back to utterance-level timing.
  if (wordTimestamps()) form.append('timestamp_granularities[]', 'word');

  const data = await postForm(`${base}/inference`, form, { signal });
  return { data, words: parseWords(data), extra: {} };
}

// Servers that reject verbose_json / timestamp_granularities (older vLLM:
// "only support response_format text or json") are retried once with plain
// json; the downgrade is remembered per base URL + model so later calls don't
// pay a failed round trip each time. Lost: segment no_speech_prob and word
// timestamps (streaming falls back to text-only agreement).
const plainJsonOnly = new Set();

function openaiForm(wavBuffer, { model, language, prompt, temperature, verbose }) {
  const form = wavForm(wavBuffer);
  if (model) form.append('model', model);
  if (language !== 'auto') form.append('language', language);
  if (prompt) form.append('prompt', String(prompt).slice(-500));
  form.append('temperature', String(temperature));
  if (verbose) {
    form.append('response_format', 'verbose_json');
    // Both: `segment` keeps no_speech_prob coming on servers that would
    // otherwise drop segments once `word` is requested (OpenAI semantics).
    if (wordTimestamps()) form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
  } else {
    form.append('response_format', 'json');
  }
  return form;
}

async function transcribeOpenAI(wavBuffer, { prompt, signal, language, temperature }) {
  const base = baseUrl(env('STT_BASE_URL'));
  if (!base) throw new Error('stt: STT_PROVIDER=openai but STT_BASE_URL is empty');
  const model = env('STT_MODEL');
  const url = `${base}/audio/transcriptions`;
  const headers = authHeaders(env('STT_API_KEY'));
  const memo = `${base}|${model}`;
  const opts = { model, language, prompt, temperature };

  let data;
  if (plainJsonOnly.has(memo)) {
    data = await postForm(url, openaiForm(wavBuffer, { ...opts, verbose: false }), { headers, signal });
  } else {
    try {
      data = await postForm(url, openaiForm(wavBuffer, { ...opts, verbose: true }), { headers, signal });
    } catch (e) {
      if (!/^stt: HTTP (400|415|422) /.test(e.message)) throw e;
      data = await postForm(url, openaiForm(wavBuffer, { ...opts, verbose: false }), { headers, signal });
      plainJsonOnly.add(memo);
      warn(`stt: ${url} rejected verbose_json (${e.message.slice(0, 120)}) — using response_format=json (no word timestamps / no_speech_prob) for this server`);
    }
  }
  return { data, words: normalizeWordList(parseWords(data), cleanWhisperText(data?.text ?? '')), extra: { model: model || null } };
}

// Test hook: forget remembered verbose_json downgrades.
export function _resetSttProviderState() {
  plainJsonOnly.clear();
}

// transcribe(wavBuffer, { prompt?, signal? }) → { text, meta, words }
//
//   prompt context text (already-committed transcript); the vocabulary is
//          put in front of it here, so every STT path gets the names.
//
//   text   cleaned transcript ('' for silence)
//   meta   { provider, language, temperature, segmentCount, noSpeechProbAvg,
//            noSpeechProbMax, wordCount?, model? }
//   words  [{ w, t0, t1, raw }] in seconds (raw follows whisper's leading-space
//          convention for EVERY provider), or null without word timestamps.
//
// Behaviour:
//   - Sends `temperature` (default 0.2) — T>0 yields better-calibrated
//     `no_speech_prob` values than the deterministic T=0 default.
//   - Requests `verbose_json` so segment-level `no_speech_prob` is available.
//   - Does not filter by no_speech_prob in live mode. The values are persisted
//     into JSONL so Finalize/offline tooling can decide what to discard later.
// Throws Error('stt: …') on transport errors/timeouts; a caller's own abort is
// re-thrown untouched (AbortError).
export async function transcribe(wavBuffer, { prompt, signal } = {}) {
  const provider = sttProvider();
  const language = sttLanguage();
  const temperature = sttTemperature();
  const args = { prompt: sttPrompt(prompt), signal, language, temperature };
  const { data, words, extra } = provider === 'openai'
    ? await transcribeOpenAI(wavBuffer, args)
    : await transcribeWhisperCpp(wavBuffer, args);

  const text = cleanWhisperText(data?.text ?? data?.transcription ?? '');
  const meta = { provider: sttProviderLabel(provider), ...extra, ...buildMeta(data, { language, temperature }) };
  if (words) meta.wordCount = words.length;

  log('stt: transcript=', JSON.stringify(text));
  return { text, meta, words };
}
