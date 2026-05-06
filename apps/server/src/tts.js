import { log } from './logger.js';

// Synthesize `text` and return a WAV Buffer (PCM, any sample rate).
// `opts.model`:     'emotional' | 'high'  (Piper Thorsten models)
// `opts.speakerId`: 0-7  (only relevant for 'emotional')
//   0=Fröhlich  1=Wütend    2=Angewidert  3=Betrunken
//   4=Neutral   5=Schläfrig 6=Überrascht  7=Flüsternd
export async function synthesize(text, { model = 'emotional', speakerId = 4 } = {}) {
  const provider = (process.env.TTS_PROVIDER ?? 'piper').toLowerCase();
  if (provider === 'elevenlabs') return synthElevenLabs(text);
  return synthLocal(text, model, speakerId);
}

// Streaming variant: yields { pcm: Buffer, sampleRate: number } per sentence.
// `signal`: AbortSignal — pass controller.signal to cancel mid-stream.
// Only available for local Piper server (ElevenLabs falls back to bulk WAV).
export async function* synthesizeStream(text, { model = 'emotional', speakerId = 4 } = {}, signal) {
  const provider = (process.env.TTS_PROVIDER ?? 'piper').toLowerCase();
  if (provider === 'elevenlabs') {
    // ElevenLabs has no streaming path here — fall back to full WAV, yield once.
    const wav = await synthElevenLabs(text);
    yield { pcm: wav, sampleRate: 24000, isWav: true };
    return;
  }

  const base = (process.env.TTS_URL ?? 'http://localhost:5000').replace(/\/+$/, '');
  const body = { text, model, speaker_id: speakerId };

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
    throw new Error(`tts: stream connection failed: ${e.message}`);
  }
  if (!res.ok) {
    const rb = await res.text().catch(() => '');
    throw new Error(`tts: stream HTTP ${res.status}: ${rb.slice(0, 200)}`);
  }

  const sampleRate = parseInt(res.headers.get('X-Sample-Rate') ?? '22050', 10);
  log('tts: streaming', `(model=${model} speaker=${speakerId} rate=${sampleRate})`);

  for await (const chunk of res.body) {
    if (signal?.aborted) return;
    yield { pcm: Buffer.from(chunk), sampleRate, isWav: false };
  }
}

// Generic local TTS server (Piper / KokoroTTS).  POST /synthesize → WAV body.
async function synthLocal(text, model, speakerId) {
  const base = (process.env.TTS_URL ?? 'http://localhost:5000').replace(/\/+$/, '');
  const body = { text, model, speaker_id: speakerId };

  let res;
  try {
    res = await fetch(`${base}/synthesize`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`tts: connection failed: ${e.message}`);
  }
  if (!res.ok) {
    const rb = await res.text().catch(() => '');
    throw new Error(`tts: HTTP ${res.status}: ${rb.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  log('tts: audio', buf.length, 'bytes', `(model=${model} speaker=${speakerId})`);
  return buf;
}

// ElevenLabs — requests PCM 24 kHz; we prepend a WAV header.
async function synthElevenLabs(text) {
  const apiKey  = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID ?? 'EXAVITQu4vr4xnSDxMaL';
  if (!apiKey) throw new Error('tts: ELEVENLABS_API_KEY not set');

  let res;
  try {
    res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=pcm_24000`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      body:    JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.5 },
      }),
    });
  } catch (e) {
    throw new Error(`tts: elevenlabs connection failed: ${e.message}`);
  }
  if (!res.ok) {
    const rb = await res.text().catch(() => '');
    throw new Error(`tts: elevenlabs HTTP ${res.status}: ${rb.slice(0, 200)}`);
  }

  const pcm = Buffer.from(await res.arrayBuffer());
  log('tts: elevenlabs audio', pcm.length, 'bytes (24 kHz PCM)');
  return wrapInWav(pcm, 24000, 1, 16);
}

function wrapInWav(pcm, sampleRate, channels, bitDepth) {
  const byteRate   = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);        hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write('WAVE', 8);        hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);   hdr.writeUInt16LE(1,          20);
  hdr.writeUInt16LE(channels,  22); hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(byteRate,  28); hdr.writeUInt16LE(blockAlign, 32);
  hdr.writeUInt16LE(bitDepth,  34);
  hdr.write('data', 36);       hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}
