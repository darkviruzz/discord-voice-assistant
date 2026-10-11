/**
 * Minimal TTS debug endpoint: GET /debug/tts
 *
 * Synthesizes a fixed test text through the configured TTS provider
 * (providers/tts.js — piper, openai or elevenlabs, exactly as a voice reply
 * would), collects all PCM, encodes it to Opus via StreamingAudioPipeline, and
 * returns the frames as a flat binary blob:
 *   [UInt32BE frameLen][frameBytes] [UInt32BE frameLen][frameBytes] ...
 * Any TTS failure (unreachable, HTTP error, timeout, unsupported format) →
 * 502 { error }.
 *
 * No WebSocket, no timestamps, no jitter — pure encode path for isolation testing.
 */
import { synthesizeStream, ttsProvider } from './tts.js';
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
    const provider = ttsProvider();
    // Client gone (bot cancelled the fetch) → stop synthesizing.
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });

    // ── 1. Synthesize via the provider, collect all PCM ─────────────────────
    const pcmChunks = [];
    let sampleRate = null;
    try {
      for await (const chunk of synthesizeStream(TEST_TEXT, { model: 'emotional', speakerId: 0 }, ctrl.signal)) {
        sampleRate ??= chunk.sampleRate;
        pcmChunks.push(chunk.pcm);
      }
    } catch (e) {
      warn(`debug/tts: ${provider} failed:`, e.message);
      if (!res.headersSent) res.status(502).json({ error: e.message });
      return;
    }
    if (ctrl.signal.aborted) return;
    const pcm = Buffer.concat(pcmChunks);
    if (pcm.length === 0) warn(`debug/tts: ${provider} returned no audio (sending 0 frames)`);
    else log(`debug/tts: provider=${provider} pcm=${pcm.length}B  rate=${sampleRate}  dur=${Math.round(pcm.length / sampleRate / 2 * 1000)}ms`);

    // ── 2. Encode PCM → Opus (one pipeline, no chunk-boundary artifacts) ────
    const frames = [];
    if (pcm.length > 0) {
      const pipe = new StreamingAudioPipeline(sampleRate);
      frames.push(...pipe.push(pcm), ...pipe.flush());
    }
    log(`debug/tts: ${frames.length} Opus frames (${frames.length * 20}ms)`);

    // ── 3. Serialize as [UInt32BE len][bytes]... and send ────────────────────
    const parts = frames.map(f => {
      const hdr = Buffer.allocUnsafe(4);
      hdr.writeUInt32BE(f.length);
      return Buffer.concat([hdr, f]);
    });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(Buffer.concat(parts));
  });
}
