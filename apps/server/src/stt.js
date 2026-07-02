import { log, debug, warn } from './logger.js';

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
export function cleanWhisperText(s) {
  return String(s || '')
    .replace(/(\p{L})\n(\p{Ll})/gu, '$1$2') // letter \n lowercase (no space) → join word
    .replace(/\s*\n\s*/g, ' ')              // remaining newlines → single space
    .replace(/[ \t]{2,}/g, ' ')             // collapse runs of spaces
    .trim();
}

// Normalize Whisper word/token timestamps from whatever shape the server
// returned into a flat [{ w, t0, t1 }] array, times in SECONDS relative to the
// submitted audio. Handles:
//   - OpenAI-style top-level `words: [{ word, start, end }]`
//   - per-segment `words` arrays (whisper.cpp with token timestamps)
// Returns null when no word-level data is present → caller falls back to
// utterance-level timing.
function parseWords(data) {
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
  if (Array.isArray(data.words)) data.words.forEach(push);
  if (out.length === 0 && Array.isArray(data.segments)) {
    for (const seg of data.segments) {
      if (Array.isArray(seg.words)) seg.words.forEach(push);
    }
  }
  return out.length > 0 ? out : null;
}

// POST a WAV buffer to the whisper.cpp HTTP server and return transcript + metadata.
//
// Behaviour:
//   - Sends `temperature` (default 0.2) — T>0 yields better-calibrated
//     `no_speech_prob` values than the deterministic T=0 default.
//   - Requests `verbose_json` so segment-level `no_speech_prob` is available.
//   - Does not filter by no_speech_prob in live mode. The values are persisted
//     into JSONL so Finalize/offline tooling can decide what to discard later.
export async function transcribe(wavBuffer, { prompt } = {}) {
  const base        = (process.env.WHISPER_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  const language    = process.env.WHISPER_LANGUAGE ?? 'auto';
  const temperature = Number(process.env.WHISPER_TEMPERATURE ?? 0.2);

  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  if (language !== 'auto') form.append('language', language);
  form.append('response_format', 'verbose_json');
  form.append('temperature', String(temperature));
  // Decoder context from already-locked streaming text — keeps wording stable
  // across the window boundary (the model "knows" how the sentence began).
  if (prompt) form.append('prompt', String(prompt).slice(-500));
  // Ask for word-level timestamps. Harmless if the server ignores it (older
  // whisper.cpp builds); parseWords() falls back to utterance-level timing.
  if ((process.env.WHISPER_WORD_TIMESTAMPS ?? 'true') !== 'false') {
    form.append('timestamp_granularities[]', 'word');
  }

  let res;
  try {
    res = await fetch(`${base}/inference`, { method: 'POST', body: form });
  } catch (e) {
    throw new Error(`stt: connection failed: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`stt: HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = cleanWhisperText(data.text ?? data.transcription ?? '');

  // Keep likely-noise transcripts. Store diagnostics for later filtering.
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const meta = {
    language: data.language ?? (language === 'auto' ? null : language),
    temperature,
    segmentCount: segments.length,
    noSpeechProbAvg: null,
    noSpeechProbMax: null,
  };

  if (segments.length > 0) {
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
  }

  const words = parseWords(data);
  if (words) meta.wordCount = words.length;

  log('stt: transcript=', JSON.stringify(text));
  return { text, meta, words };
}
