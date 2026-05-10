/**
 * Minimal TTS debug endpoint: GET /debug/tts
 *
 * Calls Piper, collects all PCM, encodes to Opus via StreamingAudioPipeline,
 * and returns the frames as a flat binary blob:
 *   [UInt32BE frameLen][frameBytes] [UInt32BE frameLen][frameBytes] ...
 *
 * No WebSocket, no timestamps, no jitter — pure encode path for isolation testing.
 */
import http from 'http';
import { StreamingAudioPipeline } from './audio.js';
import { log, warn } from './logger.js';

// ~500 chars, varied phonemes, tests long continuous speech
const TEST_TEXT =
  'Das ist ein automatischer Diagnose-Test der Sprachausgabe. ' +
  'Ein kleiner Fuchs springt fröhlich über den langen Baumstamm im tiefen Wald. ' +
  'Die alte Mühle am Fluss dreht sich langsam im kühlen Sommerwind. ' +
  'Zwölf Zwerge zogen durch das enge Zillertal und sangen laut. ' +
  'Die Sonne scheint warm auf die grünen Wiesen am Berghang. ' +
  'Morgen früh um acht Uhr beginnt die wichtige Konferenz. ' +
  'Bitte überprüfen Sie alle Mikrofone sorgfältig vor dem Start der Veranstaltung.';

export function registerDebugTtsRoute(expressApp) {
  expressApp.get('/debug/tts', async (req, res) => {
    const piperBase = process.env.PIPER_URL || 'http://127.0.0.1:5000';
    const bodyBuf = Buffer.from(
      JSON.stringify({ text: TEST_TEXT, model: 'emotional', speaker_id: 0 }),
    );

    // ── 1. Call Piper streaming endpoint ─────────────────────────────────────
    let piperRes;
    try {
      piperRes = await new Promise((resolve, reject) => {
        const u = new URL(piperBase + '/tts/synthesize');
        const r = http.request(
          {
            hostname: u.hostname,
            port:     parseInt(u.port, 10) || 80,
            path:     u.pathname,
            method:   'POST',
            headers:  {
              'Content-Type':   'application/json',
              'Content-Length': bodyBuf.length,
            },
          },
          resolve,
        );
        r.on('error', reject);
        r.write(bodyBuf);
        r.end();
      });
    } catch (e) {
      warn('debug/tts: Piper unreachable:', e.message);
      return res.status(502).json({ error: 'piper unreachable: ' + e.message });
    }

    if (piperRes.statusCode !== 200) {
      piperRes.resume();
      return res.status(502).json({ error: `piper HTTP ${piperRes.statusCode}` });
    }

    const sampleRate = parseInt(piperRes.headers['x-sample-rate'] || '22050', 10);

    // ── 2. Collect all PCM ───────────────────────────────────────────────────
    const pcmChunks = [];
    for await (const c of piperRes) pcmChunks.push(c);
    const pcm = Buffer.concat(pcmChunks);
    log(`debug/tts: pcm=${pcm.length}B  rate=${sampleRate}  dur=${Math.round(pcm.length / sampleRate / 2 * 1000)}ms`);

    // ── 3. Encode PCM → Opus (one pipeline, no chunk-boundary artifacts) ────
    const pipe   = new StreamingAudioPipeline(sampleRate);
    const frames = [...pipe.push(pcm), ...pipe.flush()];
    log(`debug/tts: ${frames.length} Opus frames (${frames.length * 20}ms)`);

    // ── 4. Serialize as [UInt32BE len][bytes]... and send ────────────────────
    const parts = frames.map(f => {
      const hdr = Buffer.allocUnsafe(4);
      hdr.writeUInt32BE(f.length);
      return Buffer.concat([hdr, f]);
    });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(Buffer.concat(parts));
  });
}
