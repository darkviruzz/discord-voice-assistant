import { randomUUID } from 'crypto';
import { sessions, ensureSession } from './state.js';
import { synthesizeStream } from './tts.js';
import { StreamingAudioPipeline } from './audio.js';
import { logTranscriptEvent } from './transcript.js';
import { log, debug, warn } from './logger.js';

export function defaultDebugTtsText() {
  const wakeWord = process.env.WAKE_WORD ?? 'Rabenauge';
  return `Hallo, ich bin ${wakeWord}. Ich höre zu und antworte, wenn ihr mich mit ${wakeWord} ansprecht.`;
}

const SUBSCRIBER_WAIT_MS = 3000;
const activeTtsBySession = new Map();

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

export async function streamTtsToSession(sessionId, text = null, opts = {}) {
  const sid = BigInt(sessionId);
  const sessionKey = sid.toString();
  ensureSession(sid);
  cancelTtsForSession(sid, 'replace');

  const id = opts.id ?? `tts-${randomUUID()}`;
  const ctrl = new AbortController();
  const token = { id, ctrl, cancelled: false };
  activeTtsBySession.set(sessionKey, token);
  const cleanText = String(text || defaultDebugTtsText()).trim();
  log(`debug-tts: request id=${id} chars=${cleanText.length}`);
  logTranscriptEvent(sid, 'tts_start', {
    id,
    text: cleanText,
    chars: cleanText.length,
    model: opts.model,
    speakerId: opts.speakerId,
    lengthScale: opts.lengthScale,
    noiseScale: opts.noiseScale,
    noiseWScale: opts.noiseWScale,
  });

  const hasDownlink = await waitForDownlink(sid);
  if (!hasDownlink) {
    warn('debug-tts: no downlink subscribers for session', sid.toString());
    logTranscriptEvent(sid, 'tts_error', {
      id,
      message: 'no downlink subscribers',
    });
    if (activeTtsBySession.get(sessionKey) === token) activeTtsBySession.delete(sessionKey);
    return { id, frames: 0, pcmBytes: 0 };
  }

  sendToSession(sid, { type: 'tts_start', id });

  let pipe = null;
  let seq = 0;
  let pcmBytes = 0;
  let chunks = 0;
  let lastLoggedFrames = 0;

  try {
    for await (const { pcm, sampleRate } of synthesizeStream(cleanText, opts, ctrl.signal)) {
      if (token.cancelled) break;
      chunks++;
      pcmBytes += pcm.length;
      debug(`debug-tts: pcm chunk id=${id} bytes=${pcm.length} total=${pcmBytes}`);

      pipe ??= new StreamingAudioPipeline(sampleRate);
      const frames = pipe.push(pcm);
      for (const frame of frames) {
        if (token.cancelled) break;
        sendToSession(sid, {
          type: 'tts_frame',
          id,
          seq,
          payload: frame.toString('base64'),
        });
        seq++;
      }
      if (token.cancelled) break;

      if (seq === 1 || seq - lastLoggedFrames >= 50) {
        debug(`debug-tts: sent frames id=${id} total=${seq}`);
        lastLoggedFrames = seq;
      }
    }

    if (token.cancelled) {
      log(`debug-tts: cancelled id=${id} frames=${seq} pcmBytes=${pcmBytes}`);
      return { id, frames: seq, pcmBytes, cancelled: true };
    }

    if (pipe) {
      for (const frame of pipe.flush()) {
        if (token.cancelled) break;
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
    logTranscriptEvent(sid, 'tts_done', {
      id,
      frames: seq,
      pcmBytes,
      chunks,
      durationMs: seq * 20,
    });
    log(`debug-tts: done id=${id} frames=${seq} pcmBytes=${pcmBytes} chunks=${chunks} durationMs≈${seq * 20}`);
    return { id, frames: seq, pcmBytes };
  } catch (e) {
    warn('debug-tts: failed id=', id, e.message);
    sendToSession(sid, { type: 'tts_error', id, message: e.message });
    logTranscriptEvent(sid, 'tts_error', { id, message: e.message });
    throw e;
  } finally {
    if (activeTtsBySession.get(sessionKey) === token) {
      activeTtsBySession.delete(sessionKey);
    }
  }
}

export function cancelTtsForSession(sessionId, reason = 'cancel') {
  const sessionKey = BigInt(sessionId).toString();
  const token = activeTtsBySession.get(sessionKey);
  if (!token) return false;
  token.cancelled = true;
  try { token.ctrl.abort(); } catch {}
  activeTtsBySession.delete(sessionKey);
  logTranscriptEvent(sessionKey, 'tts_cancel', {
    id: token.id,
    reason,
  });
  log(`debug-tts: cancel id=${token.id} session=${sessionKey} reason=${reason}`);
  return true;
}
