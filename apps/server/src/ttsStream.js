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
const ttsRecords = new Map();

function rememberTtsRecord(id, record) {
  ttsRecords.set(id, { ...record, updatedAt: Date.now() });
  if (ttsRecords.size > 100) {
    const oldest = [...ttsRecords.entries()]
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]?.[0];
    if (oldest) ttsRecords.delete(oldest);
  }
}

function estimateDurationMs(text) {
  // Fallback only when Piper was cancelled before we know the real duration.
  // German spoken TTS lands roughly around 11-14 chars/s; use conservative 12.
  return Math.max(1000, Math.round((String(text || '').length / 12) * 1000));
}

function playedText(text, msPlayed, durationMs) {
  const clean = String(text || '').trim();
  if (!clean) return { text: '', truncated: false, cutIndex: 0 };
  const total = clean.length;
  const ratio = durationMs > 0 ? Math.max(0, Math.min(1, msPlayed / durationMs)) : 1;
  let cut = Math.floor(total * ratio);
  if (cut >= total) return { text: clean, truncated: false, cutIndex: total };

  const nextWhitespace = clean.slice(cut).search(/\s/);
  if (nextWhitespace >= 0) cut += nextWhitespace;
  const remaining = total - cut;
  if (remaining < 15 || remaining / total < 0.05) {
    return { text: clean, truncated: false, cutIndex: total };
  }

  const partial = clean.slice(0, Math.max(0, cut)).trimEnd();
  return {
    text: partial ? `${partial} ...` : '...',
    truncated: true,
    cutIndex: cut,
  };
}

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
  rememberTtsRecord(id, {
    id,
    sessionId: sessionKey,
    turnId: opts.turnId,
    text: cleanText,
    frames: 0,
    durationMs: 0,
    done: false,
    cancelled: false,
  });
  log(`debug-tts: request id=${id} chars=${cleanText.length}`);
  logTranscriptEvent(sid, 'tts_start', {
    id,
    turnId: opts.turnId,
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
        rememberTtsRecord(id, {
          ...ttsRecords.get(id),
          frames: seq,
          durationMs: seq * 20,
        });
      }
      if (token.cancelled) break;

      if (seq === 1 || seq - lastLoggedFrames >= 50) {
        debug(`debug-tts: sent frames id=${id} total=${seq}`);
        lastLoggedFrames = seq;
      }
    }

    if (token.cancelled) {
      log(`debug-tts: cancelled id=${id} frames=${seq} pcmBytes=${pcmBytes}`);
      rememberTtsRecord(id, {
        ...ttsRecords.get(id),
        frames: seq,
        durationMs: seq * 20,
        cancelled: true,
      });
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
      turnId: opts.turnId,
      frames: seq,
      pcmBytes,
      chunks,
      durationMs: seq * 20,
    });
    rememberTtsRecord(id, {
      ...ttsRecords.get(id),
      frames: seq,
      durationMs: seq * 20,
      done: true,
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
  rememberTtsRecord(token.id, {
    ...ttsRecords.get(token.id),
    cancelled: true,
  });
  logTranscriptEvent(sessionKey, 'tts_cancel', {
    id: token.id,
    reason,
  });
  log(`debug-tts: cancel id=${token.id} session=${sessionKey} reason=${reason}`);
  return true;
}

export function recordPlaybackStopped(sessionId, playback = {}) {
  if (!playback.id) return null;
  const record = ttsRecords.get(playback.id);
  if (!record?.text) return null;

  const durationMs = record.durationMs || playback.msReceived || estimateDurationMs(record.text);
  const msPlayed = Number(playback.msPlayed ?? 0);
  const partial = playedText(record.text, msPlayed, durationMs);
  const event = {
    id: playback.id,
    turnId: record.turnId,
    text: partial.text,
    fullText: record.text,
    truncated: partial.truncated,
    cutIndex: partial.cutIndex,
    msPlayed,
    durationMs,
    framesPlayed: playback.framesPlayed,
    framesReceived: playback.framesReceived,
    ttsDone: record.done,
    ttsCancelled: record.cancelled,
  };
  logTranscriptEvent(sessionId, 'assistant_response_played', event);
  return event;
}
