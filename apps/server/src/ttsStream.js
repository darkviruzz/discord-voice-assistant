import { randomUUID } from 'crypto';
import { sessions, ensureSession } from './state.js';
import { synthesizeStream } from './tts.js';
import { StreamingAudioPipeline } from './audio.js';
import { log, debug, warn } from './logger.js';

export const DEBUG_TTS_TEXT =
  'Hallo, dies ist ein technischer Test der neuen minimalen Sprachpipeline. ' +
  'Der Server fragt Piper an, wandelt die erzeugten PCM-Daten direkt in Opus-Frames um ' +
  'und streamt diese sofort an den Discord-Bot. Der Bot puffert die Frames nur in einer ' +
  'einfachen Reihenfolge-Queue und spielt sie ohne Gating, ohne Zeitstempel, ohne Jitter-Buffer ' +
  'und ohne künstliche Silence-Frames ab. Wenn dieser Test sauber klingt, ist der neue Kernpfad korrekt.';

const SUBSCRIBER_WAIT_MS = 3000;

function sendJson(ws, obj) {
  if (ws.readyState !== 1) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

function sendToSession(sessionId, obj) {
  const s = sessions.get(BigInt(sessionId));
  if (!s || s.downlinks.size === 0) return 0;
  let sent = 0;
  for (const ws of s.downlinks) {
    if (sendJson(ws, obj)) sent++;
  }
  return sent;
}

async function waitForDownlink(sessionId, timeoutMs = SUBSCRIBER_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = sessions.get(BigInt(sessionId));
    if (s && s.downlinks.size > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function streamTtsToSession(sessionId, text = DEBUG_TTS_TEXT, opts = {}) {
  const sid = BigInt(sessionId);
  ensureSession(sid);

  const id = opts.id ?? `tts-${randomUUID()}`;
  const cleanText = String(text || DEBUG_TTS_TEXT).trim();
  log(`debug-tts: request id=${id} chars=${cleanText.length}`);

  const hasDownlink = await waitForDownlink(sid);
  if (!hasDownlink) {
    warn('debug-tts: no downlink subscribers for session', sid.toString());
    return { id, frames: 0, pcmBytes: 0 };
  }

  sendToSession(sid, { type: 'tts_start', id });

  let pipe = null;
  let seq = 0;
  let pcmBytes = 0;
  let chunks = 0;
  let lastLoggedFrames = 0;

  try {
    for await (const { pcm, sampleRate } of synthesizeStream(cleanText, opts)) {
      chunks++;
      pcmBytes += pcm.length;
      debug(`debug-tts: pcm chunk id=${id} bytes=${pcm.length} total=${pcmBytes}`);

      pipe ??= new StreamingAudioPipeline(sampleRate);
      const frames = pipe.push(pcm);
      for (const frame of frames) {
        sendToSession(sid, {
          type: 'tts_frame',
          id,
          seq,
          payload: frame.toString('base64'),
        });
        seq++;
      }

      if (seq === 1 || seq - lastLoggedFrames >= 50) {
        debug(`debug-tts: sent frames id=${id} total=${seq}`);
        lastLoggedFrames = seq;
      }
    }

    if (pipe) {
      for (const frame of pipe.flush()) {
        sendToSession(sid, {
          type: 'tts_frame',
          id,
          seq,
          payload: frame.toString('base64'),
        });
        seq++;
      }
    }

    sendToSession(sid, { type: 'tts_done', id });
    log(`debug-tts: done id=${id} frames=${seq} pcmBytes=${pcmBytes} chunks=${chunks} durationMs≈${seq * 20}`);
    return { id, frames: seq, pcmBytes };
  } catch (e) {
    warn('debug-tts: failed id=', id, e.message);
    sendToSession(sid, { type: 'tts_error', id, message: e.message });
    throw e;
  }
}
