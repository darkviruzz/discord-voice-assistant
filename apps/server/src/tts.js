import { log } from './logger.js';

// Synthesize `text` and stream raw mono int16LE PCM chunks.
// Yields { pcm: Buffer, sampleRate: number } per HTTP response chunk.
// Supports abort via AbortSignal.
//
// opts:
//   model        'emotional' | 'high'           (Piper voice)
//   speakerId    0-7                             (emotional model only)
//     0=Fröhlich  1=Wütend    2=Angewidert  3=Betrunken
//     4=Neutral   5=Schläfrig 6=Überrascht  7=Flüsternd
//   lengthScale  0.1–3.0, default 1.0           (speech speed)
//   noiseScale   0.0–1.0, default 0.667         (prosody variance)
//   noiseWScale  0.0–1.0, default 0.8           (transition smoothing)
export async function* synthesizeStream(text, opts = {}, signal) {
  const provider = (process.env.TTS_PROVIDER ?? 'piper').toLowerCase();
  if (provider === 'elevenlabs') {
    yield* streamElevenLabs(text, signal);
    return;
  }
  yield* streamPiper(text, opts, signal);
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

  const base = (process.env.TTS_URL ?? 'http://localhost:5000').replace(/\/+$/, '');
  const body = {
    text,
    model,
    speaker_id:    speakerId,
    length_scale:  lengthScale,
    noise_scale:   noiseScale,
    noise_w_scale: noiseWScale,
  };

  let res;
  try {
    res = await fetch(`${base}/tts/synthesize`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') return;
    throw new Error(`tts: piper connection failed: ${e.message}`);
  }
  if (!res.ok) {
    const rb = await res.text().catch(() => '');
    throw new Error(`tts: piper HTTP ${res.status}: ${rb.slice(0, 200)}`);
  }

  const sampleRate = parseInt(res.headers.get('X-Sample-Rate') ?? '22050', 10);
  log('tts: piper stream', `(model=${model} speaker=${speakerId} rate=${sampleRate} length=${lengthScale})`);

  for await (const chunk of res.body) {
    if (signal?.aborted) return;
    yield { pcm: Buffer.from(chunk), sampleRate };
  }
}

// ── ElevenLabs (cloud) ────────────────────────────────────────────────────────

async function* streamElevenLabs(text, signal) {
  const apiKey  = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? 'EXAVITQu4vr4xnSDxMaL';
  if (!apiKey) throw new Error('tts: ELEVENLABS_API_KEY not set');

  let res;
  try {
    res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.5 },
        }),
        signal,
      },
    );
  } catch (e) {
    if (e.name === 'AbortError') return;
    throw new Error(`tts: elevenlabs connection failed: ${e.message}`);
  }
  if (!res.ok) {
    const rb = await res.text().catch(() => '');
    throw new Error(`tts: elevenlabs HTTP ${res.status}: ${rb.slice(0, 200)}`);
  }

  log('tts: elevenlabs stream (24 kHz PCM)');
  for await (const chunk of res.body) {
    if (signal?.aborted) return;
    yield { pcm: Buffer.from(chunk), sampleRate: 24000 };
  }
}
