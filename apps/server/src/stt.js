import { log, debug, warn } from './logger.js';

// POST a WAV buffer to the whisper.cpp HTTP server and return the transcript.
//
// Behaviour:
//   - Sends `temperature` (default 0.2) — T>0 yields better-calibrated
//     `no_speech_prob` values than the deterministic T=0 default.
//   - Requests `verbose_json` so segment-level `no_speech_prob` is available.
//   - If the average `no_speech_prob` across segments exceeds
//     WHISPER_NO_SPEECH_THRESHOLD (default 0.67), the transcript is treated
//     as noise and an empty string is returned. Pipeline.js skips empties.
export async function transcribe(wavBuffer) {
  const base        = (process.env.WHISPER_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  const language    = process.env.WHISPER_LANGUAGE ?? 'auto';
  const temperature = Number(process.env.WHISPER_TEMPERATURE ?? 0.2);
  const threshold   = Number(process.env.WHISPER_NO_SPEECH_THRESHOLD ?? 0.67);

  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  if (language !== 'auto') form.append('language', language);
  form.append('response_format', 'verbose_json');
  form.append('temperature', String(temperature));

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
  const text = (data.text ?? data.transcription ?? '').trim();

  // Filter likely-noise transcripts using the segment-level no_speech_prob.
  // Average across segments (length-weighted by segment text length to avoid
  // a single noisy short segment dominating).
  const segments = Array.isArray(data.segments) ? data.segments : [];
  if (text && segments.length > 0) {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const s of segments) {
      const p = typeof s.no_speech_prob === 'number' ? s.no_speech_prob : null;
      if (p === null) continue;
      const w = Math.max(1, (s.text ?? '').trim().length);
      weightedSum += p * w;
      totalWeight += w;
    }
    if (totalWeight > 0) {
      const avg = weightedSum / totalWeight;
      if (avg > threshold) {
        log(`stt: filtered (no_speech_prob avg=${avg.toFixed(2)} > ${threshold}):`, JSON.stringify(text));
        return '';
      }
      debug(`stt: no_speech_prob avg=${avg.toFixed(2)}`);
    }
  }

  log('stt: transcript=', JSON.stringify(text));
  return text;
}
