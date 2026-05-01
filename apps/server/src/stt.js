import { log, warn } from './logger.js';

// POST a WAV buffer to the whisper.cpp HTTP server and return the transcript string.
export async function transcribe(wavBuffer) {
  const base     = (process.env.WHISPER_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  const language = process.env.WHISPER_LANGUAGE ?? 'auto';

  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  if (language !== 'auto') form.append('language', language);
  form.append('response_format', 'json');

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
  // whisper.cpp server response: { text: "..." }  (may also have .transcription)
  const text = (data.text ?? data.transcription ?? '').trim();
  log('stt: transcript=', JSON.stringify(text));
  return text;
}
