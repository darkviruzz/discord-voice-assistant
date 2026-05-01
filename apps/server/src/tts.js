import { log } from './logger.js';

// Synthesize `text` and return a WAV Buffer (PCM, any sample rate).
// The pipeline will handle resampling to 48 kHz before Opus encoding.
export async function synthesize(text) {
  const provider = (process.env.TTS_PROVIDER ?? 'piper').toLowerCase();
  if (provider === 'elevenlabs') return synthElevenLabs(text);
  return synthLocal(text);
}

// Generic local TTS server — works for Piper and KokoroTTS HTTP servers.
// Both typically expose POST /synthesize → WAV body.
async function synthLocal(text) {
  const base = (process.env.TTS_URL ?? 'http://localhost:5000').replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/synthesize`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });
  } catch (e) {
    throw new Error(`tts: connection failed: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`tts: HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  log('tts: audio', buf.length, 'bytes');
  return buf;
}

// ElevenLabs — requests PCM 24 kHz so the pipeline can treat it as raw PCM.
// We prepend a WAV header to match what synthLocal returns.
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
    const body = await res.text().catch(() => '');
    throw new Error(`tts: elevenlabs HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const pcm = Buffer.from(await res.arrayBuffer());
  log('tts: elevenlabs audio', pcm.length, 'bytes (24 kHz PCM)');
  return wrapInWav(pcm, 24000, 1, 16);
}

function wrapInWav(pcm, sampleRate, channels, bitDepth) {
  const byteRate   = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1,          20); // PCM
  hdr.writeUInt16LE(channels,   22);
  hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(byteRate,   28);
  hdr.writeUInt16LE(blockAlign, 32);
  hdr.writeUInt16LE(bitDepth,   34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}
