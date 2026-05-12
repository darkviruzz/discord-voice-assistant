import { log, debug, warn } from './logger.js';

// POST a WAV buffer to the whisper.cpp HTTP server and return transcript + metadata.
//
// Behaviour:
//   - Sends `temperature` (default 0.2) — T>0 yields better-calibrated
//     `no_speech_prob` values than the deterministic T=0 default.
//   - Requests `verbose_json` so segment-level `no_speech_prob` is available.
//   - Does not filter by no_speech_prob in live mode. The values are persisted
//     into JSONL so Finalize/offline tooling can decide what to discard later.
export async function transcribe(wavBuffer) {
  const base        = (process.env.WHISPER_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  const language    = process.env.WHISPER_LANGUAGE ?? 'auto';
  const temperature = Number(process.env.WHISPER_TEMPERATURE ?? 0.2);

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

  log('stt: transcript=', JSON.stringify(text));
  return { text, meta };
}
