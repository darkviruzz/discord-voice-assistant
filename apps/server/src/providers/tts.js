import { log, debug } from '../logger.js';
import { baseUrl, env, authHeaders, request, ProviderTimeout } from './http.js';

// TTS provider — every speech synthesis in the server (voice replies, the
// /join greeting, the /debug/tts isolation route) goes through
// synthesizeStream(). Callers only ever see mono int16LE PCM plus its sample
// rate; resampling to 48 kHz and Opus encoding stay in audio.js.
//
//   TTS_PROVIDER=piper (default)  services/piper: POST ${TTS_URL}/tts/synthesize,
//                                 raw PCM, rate in the X-Sample-Rate header.
//                                 The only provider that honours the Piper
//                                 opts (model / speakerId emotion / scales).
//   TTS_PROVIDER=openai           any OpenAI-compatible POST /audio/speech —
//                                 vLLM-Omni (Qwen3-TTS), AMD Lemonade (Kokoro),
//                                 Speaches, Kokoro-FastAPI, OpenAI itself:
//                                 TTS_BASE_URL (incl. /v1), TTS_MODEL,
//                                 TTS_VOICE, TTS_API_KEY (optional), TTS_SPEED
//                                 (optional), TTS_RESPONSE_FORMAT pcm | wav,
//                                 TTS_SAMPLE_RATE (rate of raw pcm, default
//                                 24000 as in the OpenAI spec).
//   TTS_PROVIDER=elevenlabs       ElevenLabs streaming API as pcm_24000:
//                                 ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID,
//                                 ELEVENLABS_BASE_URL (default api.elevenlabs.io;
//                                 regional endpoint / proxy / tests).
//
// Shared by all providers:
//   TTS_TIMEOUT_MS (default 30000, 0 = off) bounds connect + response headers
//   and every gap between two body chunks: a server that stops sending in the
//   middle of a sentence ends the stream with an error instead of hanging the
//   playback forever. It does NOT bound the total duration — a long sentence
//   that keeps streaming is fine. Time spent in the consumer (between a yield
//   and the next read) is not counted against the server.
//   An abort via the caller's `signal` (barge-in, stop phrase, replaced reply)
//   ends the generator silently: no error, no further chunks.
//   Every yielded chunk holds whole mono samples (even byte count). A sample
//   (or a stereo frame) split across two HTTP chunks is carried over, never
//   dropped or shifted, so an odd chunk boundary cannot turn speech into noise.
//
// Settings are read per call, so a provider switch in the settings panel
// applies to the next utterance.

const PROVIDERS = ['piper', 'openai', 'elevenlabs'];
const DEFAULT_TIMEOUT_MS = 30_000;
const OPENAI_DEFAULT_RATE = 24_000;
const ELEVENLABS_MODEL = 'eleven_multilingual_v2';
const ELEVENLABS_FORMAT = 'pcm_24000';
const EMPTY = Buffer.alloc(0);

export function ttsProvider() {
  const p = env('TTS_PROVIDER', 'piper').toLowerCase();
  return PROVIDERS.includes(p) ? p : 'piper'; // unknown → piper, as before the refactor
}

export function ttsTimeoutMs() {
  const n = Number(env('TTS_TIMEOUT_MS', String(DEFAULT_TIMEOUT_MS)));
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TIMEOUT_MS;
}

const piperUrl = () => baseUrl(env('TTS_URL'), 'http://localhost:5000');
const elevenLabsUrl = () => baseUrl(env('ELEVENLABS_BASE_URL'), 'https://api.elevenlabs.io');
const elevenLabsVoice = () => env('ELEVENLABS_VOICE_ID', 'EXAVITQu4vr4xnSDxMaL');

// pcm | wav. Compressed formats are refused up front: the reply is fed straight
// into the Opus encoder, there is no mp3/opus decoder in the server.
function openaiFormat() {
  const f = env('TTS_RESPONSE_FORMAT', 'pcm').toLowerCase();
  if (f === 'pcm' || f === 'wav') return f;
  throw new Error(`tts (openai): TTS_RESPONSE_FORMAT=${f} is not supported — set pcm or wav (compressed audio cannot be streamed into the Opus encoder)`);
}

// Rate of a raw pcm reply — the bytes carry no header, so this must match what
// the server actually sends (OpenAI spec: 24 kHz). A wrong value plays the
// voice too high/fast or too low/slow; TTS_RESPONSE_FORMAT=wav avoids guessing.
function openaiSampleRate() {
  const n = Number(env('TTS_SAMPLE_RATE', String(OPENAI_DEFAULT_RATE)));
  return Number.isInteger(n) && n >= 8000 && n <= 192_000 ? n : OPENAI_DEFAULT_RATE;
}

// OpenAI `speed` (0.25–4.0, 1 = normal). TTS_SPEED is the base tempo; a
// Piper-style opts.lengthScale (a duration factor: 2 = half as fast) is folded
// in as its inverse, so a caller asking for slower Piper speech gets slower
// speech here too. null (field omitted) when the result is 1 — servers that do
// not implement `speed` then never see it.
function openaiSpeed(opts = {}) {
  const base = Number(env('TTS_SPEED', '1'));
  let s = Number.isFinite(base) && base > 0 ? base : 1;
  const ls = Number(opts.lengthScale);
  if (Number.isFinite(ls) && ls > 0) s /= ls;
  s = Math.min(4, Math.max(0.25, s));
  return Math.abs(s - 1) < 1e-9 ? null : Math.round(s * 1000) / 1000;
}

// Public description for the session_meta snapshot / logs. Never contains a
// key — only whether one is set.
export function ttsConfig() {
  const provider = ttsProvider();
  const timeoutMs = ttsTimeoutMs();
  if (provider === 'openai') {
    let responseFormat;
    try { responseFormat = openaiFormat(); } catch { responseFormat = `${env('TTS_RESPONSE_FORMAT')} (invalid)`; }
    return {
      provider,
      url: baseUrl(env('TTS_BASE_URL')),
      model: env('TTS_MODEL') || null,
      voice: env('TTS_VOICE') || null,
      responseFormat,
      sampleRate: responseFormat === 'pcm' ? openaiSampleRate() : null, // wav: from the header
      speed: openaiSpeed() ?? 1,
      apiKeySet: env('TTS_API_KEY') !== '',
      timeoutMs,
    };
  }
  if (provider === 'elevenlabs') {
    return {
      provider,
      url: elevenLabsUrl(),
      voiceId: elevenLabsVoice(),
      model: ELEVENLABS_MODEL,
      outputFormat: ELEVENLABS_FORMAT,
      apiKeySet: env('ELEVENLABS_API_KEY') !== '',
      timeoutMs,
    };
  }
  return { provider, url: piperUrl(), timeoutMs };
}

// Synthesize `text` and stream raw mono int16LE PCM chunks.
// Yields { pcm: Buffer, sampleRate: number }. Ends silently when `signal`
// aborts; throws Error('tts (<provider>): …') on any failure.
//
// opts (Piper only — the other providers have one configured voice):
//   model        'emotional' | 'high'           (Piper voice)
//   speakerId    0-7                             (emotional model only)
//     0=Fröhlich  1=Wütend    2=Angewidert  3=Betrunken
//     4=Neutral   5=Schläfrig 6=Überrascht  7=Flüsternd
//   lengthScale  0.1–3.0, default 1.0           (speech duration; openai: speed = 1/lengthScale)
//   noiseScale   0.0–1.0, default 0.667         (prosody variance)
//   noiseWScale  0.0–1.0, default 0.8           (transition smoothing)
export async function* synthesizeStream(text, opts = {}, signal) {
  if (signal?.aborted) return;
  const provider = ttsProvider();
  if (provider === 'elevenlabs') yield* streamElevenLabs(text, signal);
  else if (provider === 'openai') yield* streamOpenAI(text, opts ?? {}, signal);
  else yield* streamPiper(text, opts ?? {}, signal);
}

// ── Piper (local) ─────────────────────────────────────────────────────────────

async function* streamPiper(text, opts, signal) {
  const {
    model       = 'emotional',
    speakerId   = 4,
    lengthScale = 1.0,
    noiseScale  = 0.667,
    noiseWScale = 0.8,
  } = opts;
  const url = `${piperUrl()}/tts/synthesize`;
  const body = {
    text,
    model,
    speaker_id:    speakerId,
    length_scale:  lengthScale,
    noise_scale:   noiseScale,
    noise_w_scale: noiseWScale,
  };
  yield* streamAudio('tts (piper)', url, { body }, signal, (res) => {
    const rate = parseInt(res.headers.get('X-Sample-Rate') ?? '22050', 10);
    const sampleRate = Number.isFinite(rate) && rate > 0 ? rate : 22050;
    log('tts: piper stream', `(model=${model} speaker=${speakerId} rate=${sampleRate} length=${lengthScale})`);
    return pcmDecoder(sampleRate);
  });
}

// ── ElevenLabs (cloud) ────────────────────────────────────────────────────────

async function* streamElevenLabs(text, signal) {
  const apiKey = env('ELEVENLABS_API_KEY');
  if (!apiKey) throw new Error('tts: ELEVENLABS_API_KEY not set');
  const voiceId = elevenLabsVoice();
  const url = `${elevenLabsUrl()}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${ELEVENLABS_FORMAT}`;
  const body = {
    text,
    model_id: ELEVENLABS_MODEL,
    voice_settings: { stability: 0.5, similarity_boost: 0.5 },
  };
  yield* streamAudio('tts (elevenlabs)', url, { body, headers: { 'xi-api-key': apiKey } }, signal, () => {
    log('tts: elevenlabs stream (24 kHz PCM)');
    return pcmDecoder(24_000);
  });
}

// ── OpenAI-compatible /audio/speech ───────────────────────────────────────────

// Content types that are certainly not uncompressed PCM/WAV.
const COMPRESSED_CT = /mpeg|mp3|opus|ogg|aac|flac|webm|mp4|m4a/;

async function* streamOpenAI(text, opts, signal) {
  const label = 'tts (openai)';
  const base = baseUrl(env('TTS_BASE_URL'));
  if (!base) throw new Error(`${label}: TTS_PROVIDER=openai but TTS_BASE_URL is empty`);
  const format = openaiFormat();
  const sampleRate = openaiSampleRate();
  const model = env('TTS_MODEL');
  const voice = env('TTS_VOICE');
  const speed = openaiSpeed(opts);
  // model / voice are required by OpenAI itself but optional on many local
  // servers (single served model, default voice) — omitted when empty instead
  // of sending '' that a strict server would reject.
  const body = { input: text, response_format: format };
  if (model) body.model = model;
  if (voice) body.voice = voice;
  if (speed !== null) body.speed = speed;
  const url = `${base}/audio/speech`;

  yield* streamAudio(label, url, { body, headers: authHeaders(env('TTS_API_KEY')) }, signal, async (res) => {
    const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
    if (COMPRESSED_CT.test(ctype)) {
      throw new TtsFormatError(`${label}: server replied with compressed audio (${ctype}) — set TTS_RESPONSE_FORMAT=pcm or wav and make sure the server honours response_format`);
    }
    // A 200 with an error document instead of audio (seen on some proxies).
    if (/json|text\//.test(ctype)) {
      const snippet = (await res.text().catch(() => '')).slice(0, 200);
      throw new TtsFormatError(`${label}: expected audio, got ${ctype} (${url}): ${snippet}`);
    }
    const describe = (f) => log('tts: openai stream',
      `(model=${model || '-'} voice=${voice || '-'} format=${f.kind} rate=${f.sampleRate}${f.channels > 1 ? ` ${f.channels}ch→mono` : ''}${speed !== null ? ` speed=${speed}` : ''})`);
    return /wav|wave/.test(ctype)
      ? wavDecoder(label, describe)
      : sniffingDecoder(label, sampleRate, describe);
  });
}

// ── Transport ─────────────────────────────────────────────────────────────────

// Format errors are already labelled and must not be re-wrapped as a
// "stream failed" transport error.
class TtsFormatError extends Error {}

// Like http.js withTimeout(), but re-armable: the timer only runs while we
// wait for the server (connect/headers, then each next body chunk) and is
// paused while the consumer works on a yielded chunk.
function idleTimer(signal, timeoutMs) {
  const ctrl = new AbortController();
  const limited = Number.isFinite(timeoutMs) && timeoutMs > 0;
  let timer = null;
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    arm() {
      if (!limited) return;
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(new ProviderTimeout(`timeout after ${timeoutMs} ms`)), Math.min(timeoutMs, 2 ** 31 - 1));
      timer.unref?.();
    },
    disarm() { clearTimeout(timer); timer = null; },
    get timedOut() { return ctrl.signal.reason instanceof ProviderTimeout; },
    done() { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); },
  };
}

// POST JSON, then pump the reply body through a decoder made from the
// response (makeDecoder may be async and may throw TtsFormatError). Handles
// the timeout / barge-in semantics described at the top for every provider.
async function* streamAudio(label, url, { body, headers = {} }, signal, makeDecoder) {
  const timeoutMs = ttsTimeoutMs();
  const idle = idleTimer(signal, timeoutMs);
  let res = null;
  let drained = false;
  try {
    idle.arm();
    try {
      res = await request(label, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: idle.signal,
      });
    } catch (e) {
      if (signal?.aborted) return; // barge-in before the first byte — not a failure
      throw e;                     // connection / HTTP status / header timeout, already labelled
    }
    if (signal?.aborted) return;

    let decoder;
    try {
      decoder = await makeDecoder(res);
    } catch (e) {
      if (signal?.aborted) return;
      if (idle.timedOut) throw new Error(`${label}: ${idle.signal.reason.message} (${url})`);
      throw e;
    }

    try {
      idle.arm();
      // res.body is null only for bodiless statuses (204) → no audio.
      for await (const chunk of res.body ?? []) {
        idle.disarm();
        if (signal?.aborted) return;
        for (const out of decoder.push(asBuffer(chunk))) yield out;
        if (signal?.aborted) return;
        idle.arm();
      }
      idle.disarm();
      drained = true;
    } catch (e) {
      if (signal?.aborted) return;
      if (e instanceof TtsFormatError) throw e;
      if (idle.timedOut) throw new Error(`${label}: stream stalled — no audio data for ${timeoutMs} ms (${url})`);
      throw new Error(`${label}: stream failed (${url}): ${e.message}`);
    }
    for (const out of decoder.end()) yield out;
  } finally {
    idle.done();
    // Early exit (abort, consumer break, format error): release the socket.
    if (res && !drained) res.body?.cancel?.().catch(() => {});
  }
}

const asBuffer = (u8) => (Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength));

// ── Decoders: bytes in → whole mono int16LE samples out ──────────────────────
// Each decoder: push(Buffer) → [{ pcm, sampleRate }], end() → [...] (flush).

// Raw interleaved int16LE. A partial frame at a chunk end waits for the next
// chunk; a dangling partial frame at the very end is dropped. Multi-channel
// input is downmixed to mono (average of all channels).
function pcmDecoder(sampleRate, channels = 1) {
  const frame = 2 * channels;
  let carry = EMPTY;
  return {
    push(chunk) {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const whole = buf.length - (buf.length % frame);
      carry = whole < buf.length ? Buffer.from(buf.subarray(whole)) : EMPTY;
      if (whole === 0) return [];
      const pcm = channels === 1 ? buf.subarray(0, whole) : downmix(buf.subarray(0, whole), channels);
      return [{ pcm, sampleRate }];
    },
    end() {
      if (carry.length) debug(`tts: dropped ${carry.length} trailing byte(s) of an incomplete sample`);
      carry = EMPTY;
      return [];
    },
  };
}

function downmix(buf, channels) {
  const frames = buf.length / (2 * channels);
  const out = Buffer.allocUnsafe(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += buf.readInt16LE((i * channels + c) * 2);
    out.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return out;
}

// Incremental RIFF/WAVE parser. Bytes may arrive split anywhere — inside the
// RIFF header, a chunk header, the fmt chunk or a sample. Non-audio chunks
// (LIST, fact, …) are skipped wherever they appear; only 16-bit integer PCM is
// accepted (plain or WAVE_FORMAT_EXTENSIBLE). A data size of 0 or 0xFFFFFFFF
// is what streaming servers write when they cannot know the length up front →
// "until the end of the reply". Back-to-back WAV files (one per sentence, as
// some servers stream) are followed as long as the format stays the same.
function wavDecoder(label, onFormat) {
  let buf = EMPTY;
  let state = 'riff';   // riff → chunk → fmt | skip | data → chunk …
  let left = 0;         // bytes still to read / skip / stream in the current chunk
  let pad = 0;          // RIFF word-alignment byte after an odd-sized chunk
  let fmt = null;       // { sampleRate, channels }
  let pcm = null;       // pcmDecoder for the payload (alignment + downmix)
  let sawData = false;
  const fail = (msg) => { throw new TtsFormatError(`${label}: ${msg}`); };

  // One parser step; false = need more bytes.
  function step(out) {
    switch (state) {
      case 'riff': {
        if (buf.length < 12) return false;
        if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') fail('reply is not a RIFF/WAVE file');
        buf = buf.subarray(12);
        state = 'chunk';
        return true;
      }
      case 'chunk': {
        if (buf.length >= 4 && buf.toString('latin1', 0, 4) === 'RIFF') { state = 'riff'; return true; }
        if (buf.length < 8) return false;
        const id = buf.toString('latin1', 0, 4);
        const size = buf.readUInt32LE(4);
        buf = buf.subarray(8);
        if (id === 'fmt ') {
          if (size < 16 || size > 4096) fail(`malformed WAV fmt chunk (${size} bytes)`);
          state = 'fmt'; left = size; pad = size & 1;
        } else if (id === 'data') {
          if (!fmt) fail('WAV data chunk before fmt chunk');
          sawData = true;
          const open = size === 0 || size === 0xFFFFFFFF;
          state = 'data'; left = open ? Infinity : size; pad = open ? 0 : size & 1;
        } else {
          state = 'skip'; left = size + (size & 1);
        }
        return true;
      }
      case 'fmt': {
        if (buf.length < left + pad) return false;
        parseFmt(buf.subarray(0, left));
        buf = buf.subarray(left + pad);
        state = 'chunk';
        return true;
      }
      case 'skip': {
        const n = Math.min(left, buf.length);
        buf = buf.subarray(n);
        left -= n;
        if (left > 0) return false;
        state = 'chunk';
        return true;
      }
      case 'data': {
        const n = Math.min(left, buf.length);
        if (n > 0) {
          for (const o of pcm.push(buf.subarray(0, n))) out.push(o);
          buf = buf.subarray(n);
          left -= n;
        }
        if (left > 0) return false;
        state = 'skip'; left = pad;
        return true;
      }
      default: return false;
    }
  }

  function parseFmt(f) {
    let code = f.readUInt16LE(0);
    const channels = f.readUInt16LE(2);
    const sampleRate = f.readUInt32LE(4);
    const bits = f.readUInt16LE(14);
    // WAVE_FORMAT_EXTENSIBLE: the real format code opens the SubFormat GUID.
    if (code === 0xFFFE && f.length >= 26) code = f.readUInt16LE(24);
    if (code !== 1 || bits !== 16) fail(`unsupported WAV encoding (format ${code}, ${bits} bit) — only 16-bit integer PCM can be streamed`);
    if (channels < 1 || sampleRate < 1000) fail(`implausible WAV header (${channels} channel(s), ${sampleRate} Hz)`);
    if (fmt) {
      if (fmt.sampleRate !== sampleRate || fmt.channels !== channels) {
        fail(`WAV format changed mid-stream (${fmt.sampleRate} Hz/${fmt.channels}ch → ${sampleRate} Hz/${channels}ch)`);
      }
      return;
    }
    fmt = { sampleRate, channels };
    pcm = pcmDecoder(sampleRate, channels);
    onFormat?.({ kind: 'wav', sampleRate, channels });
  }

  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const out = [];
      while (step(out));
      return out;
    },
    end() {
      if (!sawData) fail('reply ended before any WAV audio data');
      return pcm.end();
    },
  };
}

// Exported for the parser tests (exhaustive split points without HTTP).
export { pcmDecoder, wavDecoder };

// For a reply whose Content-Type does not say what it is (audio/pcm,
// application/octet-stream, none): look at the first bytes. RIFF → WAV even
// though pcm was asked for; Ogg/FLAC/ID3 magic → a clear error instead of
// playing compressed bytes as noise; anything else → raw PCM at `sampleRate`.
// (No MPEG frame-sync sniffing: 0xFFFx is also a perfectly normal quiet PCM
// sample and would misfire on real speech.)
function sniffingDecoder(label, sampleRate, onFormat) {
  let inner = null;
  let head = EMPTY;
  const pick = (h) => {
    const magic = h.toString('latin1', 0, 4);
    if (magic === 'RIFF') return wavDecoder(label, onFormat);
    const compressed = magic === 'OggS' ? 'Ogg/Opus' : magic === 'fLaC' ? 'FLAC'
      : (magic.startsWith('ID3') && h[3] >= 2 && h[3] <= 4) ? 'MP3' : null;
    if (compressed) {
      throw new TtsFormatError(`${label}: server replied with ${compressed} audio — set TTS_RESPONSE_FORMAT=pcm or wav and make sure the server honours response_format`);
    }
    onFormat?.({ kind: 'pcm', sampleRate, channels: 1 });
    return pcmDecoder(sampleRate);
  };
  return {
    push(chunk) {
      if (inner) return inner.push(chunk);
      head = head.length ? Buffer.concat([head, chunk]) : chunk;
      if (head.length < 4) return [];
      inner = pick(head);
      const h = head;
      head = EMPTY;
      return inner.push(h);
    },
    end() {
      if (!inner) {
        if (!head.length) return [];   // empty reply → no audio, like an empty Piper stream
        inner = pick(head);
        const out = inner.push(head);
        head = EMPTY;
        return [...out, ...inner.end()];
      }
      return inner.end();
    },
  };
}
