import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { log, debug, warn } from './logger.js';
import { finalizeSession } from './finalize/index.js';
import { loadSpeakerMap, setSpeakerMapping } from './speakerMap.js';
import { sendTestTone } from './downlink.js';
import { pickProtocolFor } from './auth.js';
import { ensureSession, dropSession } from './state.js';
import { runPipeline, runTextPipeline } from './pipeline.js';
import { streamTtsToSession, defaultDebugTtsText, cancelTtsForSession, recordPlaybackStopped } from './ttsStream.js';
import { logTranscriptEvent } from './transcript.js';
import { botConnections, broadcastToAllBots } from './broadcast.js';
import { AutoFinalizeTimer } from './finalize/autoTimer.js';
import { getVersion } from './version.js';

// Server-side idle timer. On fire, ask the bot(s) to finalize — the bot owns
// the WAVs and runs the upload + finalize flow. Broadcast: only the bot that
// owns the session will act.
const autoTimer = new AutoFinalizeTimer({
  onFire: (sessionId) => broadcastToAllBots({
    type: 'finalize_request', cmdId: randomUUID(), sessionId, reason: 'idle',
  }),
});

const PROTO_VERSION = 1;
const SERVER_ID = randomUUID();

// Optional hook invoked on every voice_state transition: (sessionId: BigInt, state: string).
// Wired by the auto-finalize timer (M6); null until then.
let onVoiceState = null;
export function setVoiceStateHandler(fn) { onVoiceState = fn; }

function envList(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return values.length > 0 ? values : fallback;
}

// Default playout/gating params advertised to bots; bots may apply them
// locally. These mirror the env-documented defaults from the README.
function serverParams() {
  return {
    gateMs:        Number(process.env.GATE_MS        ?? 80),
    jitterMs:      Number(process.env.JITTER_MS      ?? 120),
    playoutMs:     Number(process.env.PLAYOUT_MS     ?? 200),
    playoutMaxMs:  Number(process.env.PLAYOUT_MAX_MS ?? 1500),
    interruptMinMs:Number(process.env.INTERRUPT_MIN_MS ?? 800),
    resumeGateMs:  Number(process.env.RESUME_GATE_MS   ?? 1200),
    rewindMs:      Number(process.env.REWIND_MS      ?? 1000),
    hbIntervalMs:  15000,
  };
}

function logSessionMeta(sessionId, msg) {
  const session = ensureSession(sessionId);
  if (session.metaLogged) return;
  session.metaLogged = true;
  logTranscriptEvent(sessionId, 'session_meta', {
    protoVersion: PROTO_VERSION,
    // Bot↔server clock offset (serverClock − botClock, ms). Filled in live via
    // `clock_sync` events; finalize uses those to normalize server-stamped
    // event timestamps onto the bot timeline (the authoritative clock).
    clockOffsetMs: null,
    guildId: msg.guildId ?? null,
    guildName: msg.guildName ?? null,
    channelId: msg.channelId ?? null,
    channelName: msg.channelName ?? null,
    botVersion: msg.botVersion ?? null,
    serverVersion: getVersion(),
    llm: {
      provider: 'ollama',
      url: process.env.OLLAMA_URL ?? 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL ?? 'llama3',
      historyTurns: Number(process.env.HISTORY_TURNS ?? 6),
      systemPromptFile: process.env.SYSTEM_PROMPT_FILE ?? null,
      systemPromptInline: !!process.env.SYSTEM_PROMPT,
    },
    stt: {
      provider: 'whisper.cpp',
      url: process.env.WHISPER_URL ?? 'http://localhost:8080',
      language: process.env.WHISPER_LANGUAGE ?? 'auto',
      temperature: Number(process.env.WHISPER_TEMPERATURE ?? 0.2),
      noSpeechProbStored: true,
      noSpeechProbFiltersLive: false,
      maxChunkSeconds: Number(process.env.STT_MAX_CHUNK_SECONDS ?? 30),
      silenceThresh: Number(process.env.STT_SILENCE_THRESH ?? 300),
    },
    tts: {
      provider: process.env.TTS_PROVIDER ?? 'piper',
      url: process.env.TTS_URL ?? 'http://localhost:5000',
    },
    wakeword: {
      word: process.env.WAKE_WORD ?? 'Rabenauge',
      fuzzy: (process.env.WAKE_WORD_FUZZY ?? 'true') !== 'false',
      position: Number(process.env.WAKE_WORD_POSITION ?? 3),
    },
    stopPhrases: envList('STOP_PHRASES', [
      'stop', 'stopp', 'abbrechen', 'beenden', 'hör auf', 'aufhören', 'halt', 'halte an', 'halte ein',
    ]),
    stopWithoutWakeMaxWords: Number(process.env.STOP_WITHOUT_WAKE_MAX_WORDS ?? 5),
    users: {},
  });
}


function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) { warn('control send failed:', e.message); }
}

function transcriptDir() {
  return (process.env.TRANSCRIPT_DIR ?? './transcripts').replace(/\/+$/, '');
}

function uploadRootDir() {
  return (process.env.FINALIZE_UPLOAD_DIR ?? './uploads').replace(/\/+$/, '');
}

// Ensure the per-session upload dir exists before the bot transfers WAVs into
// it (scp does not create missing remote directories).
function ensureUploadDir(sessionId) {
  const dir = path.join(uploadRootDir(), String(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readSessionEvents(sessionId) {
  const fp = path.join(transcriptDir(), `session_${sessionId}.jsonl`);
  if (!fs.existsSync(fp)) return { events: [], jsonlPath: null };
  const events = [];
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* skip malformed */ }
  }
  return { events, jsonlPath: fp };
}

// Run a finalize request: read the uploaded manifest + JSONL, re-STT, merge,
// archive, then reply with a checksum summary. Errors are reported back so the
// bot keeps its local WAVs for a retry.
async function handleFinalize(ws, msg) {
  const sessionId = msg.sessionId;

  // Source resolution: a fresh finalize reads the freshly-uploaded WAVs from the
  // transient upload dir; a re-finalize (no upload) reads the originals back from
  // the session's archive (audio/) — the archive is never cleaned up.
  const transientDir = path.join(uploadRootDir(), String(sessionId));
  const archiveRoot = (process.env.ARCHIVE_DIR ?? './archive').replace(/\/+$/, '');
  const archiveName = typeof msg.sessionName === 'string' ? msg.sessionName.replace(/[^A-Za-z0-9._-]/g, '') : '';
  const archiveAudioDir = archiveName ? path.join(archiveRoot, archiveName, 'audio') : null;

  let manifest;
  let uploadDir;
  let cleanupUploadDir;
  if (fs.existsSync(path.join(transientDir, 'manifest.json'))) {
    manifest = JSON.parse(fs.readFileSync(path.join(transientDir, 'manifest.json'), 'utf8'));
    uploadDir = transientDir;
    cleanupUploadDir = true;
  } else if (archiveAudioDir && fs.existsSync(path.join(archiveRoot, archiveName, 'manifest.json')) && fs.existsSync(archiveAudioDir)) {
    manifest = JSON.parse(fs.readFileSync(path.join(archiveRoot, archiveName, 'manifest.json'), 'utf8'));
    uploadDir = archiveAudioDir; // re-finalize from the archived originals
    cleanupUploadDir = false;
  } else {
    send(ws, { type: 'error', code: 'NO_MANIFEST', message: `no uploaded manifest and no archive for session ${sessionId}`, cmdId: msg.cmdId });
    return;
  }

  const { events, jsonlPath } = readSessionEvents(sessionId);
  const meta = events.find((e) => e && e.type === 'session_meta') || {};
  const speakerMap = loadSpeakerMap(meta.guildId);

  // Lock against the idle timer so manual + auto finalize never both run.
  autoTimer.markFinalizing(sessionId);
  send(ws, { type: 'finalize_progress', cmdId: msg.cmdId, phase: cleanupUploadDir ? 'started' : 'rebuilding', utterances: manifest.utterances?.length ?? 0 });

  try {
    const result = await finalizeSession({ sessionId, manifest, events, uploadDir, jsonlPath, speakerMap, cleanupUploadDir });
    send(ws, {
      type: 'finalize_result',
      cmdId: msg.cmdId,
      ok: true,
      sessionId: String(sessionId),
      transcriptPath: result.transcriptPath,
      archiveDir: result.archiveDir,
      spanCount: result.spanCount,
      userCount: result.userCount,
      missing: result.missing,
      mismatched: result.mismatched,
      files: result.files,            // small: archive-root files only
      audioOk: result.audio?.ok ?? false,
      audioCount: result.audio?.files?.length ?? 0,
    });
  } catch (e) {
    warn('finalize: failed for', String(sessionId), '-', e.message);
    autoTimer.release(sessionId); // allow a retry (manual or a future idle re-arm)
    send(ws, { type: 'finalize_result', cmdId: msg.cmdId, ok: false, sessionId: String(sessionId), error: e.message });
  }
}

export function initControlWSS({ bearer } = {}) {
  try { fs.mkdirSync(uploadRootDir(), { recursive: true }); } catch (e) { warn('control: cannot create upload dir:', e.message); }
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: pickProtocolFor(bearer),
    maxPayload: 65536,
    perMessageDeflate: false,
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let registered = false;
    let activeSessionId = null;
    // Whether humans are present in the bot's voice channel — clock_sync is only
    // logged while occupied (it is only needed to align live conversation, and
    // this naturally stops writing after /leave or finalize). Gaps are fine:
    // finalize uses the median of the available samples.
    let occupied = false;

    send(ws, { type: 'hello', serverId: SERVER_ID, version: getVersion(), protoVersion: PROTO_VERSION, t: Date.now() });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch (e) {
        warn('control json parse:', e.message, data.toString().slice(0, 120));
        return;
      }

      try {
        switch (msg.type) {
          case 'register': {
            if (typeof msg.protoVersion === 'number' && msg.protoVersion !== PROTO_VERSION) {
              send(ws, { type: 'error', code: 'PROTO_MISMATCH', message: `expected protoVersion ${PROTO_VERSION}` });
              ws.close(4002, 'PROTO_MISMATCH');
              return;
            }
            registered = true;
            botConnections.add(ws);
            log('control: bot registered botId=', msg.botId, 'version=', msg.version);
            send(ws, { type: 'registered', serverParams: serverParams() });
            return;
          }
          case 'session_start': {
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED' }); return; }
            if (typeof msg.sessionId !== 'string' || !/^\d+$/.test(msg.sessionId)) {
              send(ws, { type: 'error', code: 'BAD_SESSION_ID', cmdId: msg.cmdId });
              return;
            }
            activeSessionId = BigInt(msg.sessionId);
            ensureSession(activeSessionId);
            logSessionMeta(activeSessionId, msg);
            log('control: session_start sid=', activeSessionId.toString(), 'guild=', msg.guildId, 'channel=', msg.channelId, msg.resume ? '(resume)' : '(new)');
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: 'session_start' });
            return;
          }
          case 'session_end': {
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED' }); return; }
            if (typeof msg.sessionId !== 'string' || !/^\d+$/.test(msg.sessionId)) {
              send(ws, { type: 'error', code: 'BAD_SESSION_ID', cmdId: msg.cmdId });
              return;
            }
            const sid = BigInt(msg.sessionId);
            dropSession(sid);
            if (activeSessionId === sid) activeSessionId = null;
            log('control: session_end sid=', sid.toString());
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: 'session_end' });
            return;
          }
          case 'ping': {
            send(ws, { type: 'pong', t: msg.t, srvT: Date.now() });
            return;
          }
          case 'voice_state': {
            // Voice-channel presence signal. Logged for the timeline; the
            // server-side auto-finalize timer hooks into these transitions.
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED', cmdId: msg.cmdId }); return; }
            if (typeof msg.sessionId !== 'string' || !/^\d+$/.test(msg.sessionId)) {
              send(ws, { type: 'error', code: 'BAD_SESSION_ID', cmdId: msg.cmdId });
              return;
            }
            const validStates = ['joined', 'left', 'alone', 'occupied'];
            const state = validStates.includes(msg.state) ? msg.state : null;
            if (!state) { send(ws, { type: 'error', code: 'BAD_STATE', cmdId: msg.cmdId }); return; }
            // Track presence for clock_sync gating regardless of finalize status.
            occupied = (state === 'joined' || state === 'occupied');
            // Don't append presence to an already-finalized session.
            if (!autoTimer.isFinalizing(msg.sessionId)) {
              logTranscriptEvent(msg.sessionId, 'voice_state', { state });
              autoTimer.notify(msg.sessionId, state);
            }
            onVoiceState?.(BigInt(msg.sessionId), state);
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: 'voice_state' });
            return;
          }
          case 'voice_member': {
            // Per-user voice channel join/leave → participant times in the transcript.
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED', cmdId: msg.cmdId }); return; }
            if (typeof msg.sessionId !== 'string' || !/^\d+$/.test(msg.sessionId)) {
              send(ws, { type: 'error', code: 'BAD_SESSION_ID', cmdId: msg.cmdId });
              return;
            }
            if (msg.userId != null && !autoTimer.isFinalizing(msg.sessionId)) {
              logTranscriptEvent(msg.sessionId, 'voice_member', {
                userId: String(msg.userId),
                displayName: typeof msg.displayName === 'string' ? msg.displayName : null,
                state: msg.state === 'join' ? 'join' : 'leave',
              });
            }
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: 'voice_member' });
            return;
          }
          case 'clock_sync': {
            // Bot reports its measured clock offset (serverClock − botClock, ms)
            // and round-trip time. Logged per active session so finalize can
            // normalize server-stamped event timestamps onto the bot timeline.
            if (!registered || activeSessionId === null) return;
            // Only log while the bot is in voice with people present (after
            // /leave or finalize the bot reports left/alone → occupied=false).
            if (!occupied) return;
            const offsetMs = typeof msg.offsetMs === 'number' ? msg.offsetMs : null;
            const rttMs = typeof msg.rttMs === 'number' ? msg.rttMs : null;
            if (offsetMs === null) return;
            logTranscriptEvent(activeSessionId, 'clock_sync', { offsetMs, rttMs });
            return;
          }
          case 'ack': {
            // Bot acknowledges a server→bot command (e.g. set_params routed from a controller).
            if (msg.playback?.id && msg.playback?.sessionId) {
              logTranscriptEvent(msg.playback.sessionId, 'playback_stopped', msg.playback);
              recordPlaybackStopped(msg.playback.sessionId, msg.playback);
              debug('control: playback stopped', JSON.stringify(msg.playback));
            }
            debug('control: bot ack', msg.cmdId, msg.ok);
            return;
          }
          case 'play_test_tone': {
            if (typeof msg.sessionId !== 'string' || !/^\d+$/.test(msg.sessionId)) {
              send(ws, { type: 'error', code: 'BAD_SESSION_ID', cmdId: msg.cmdId });
              return;
            }
            sendTestTone(BigInt(msg.sessionId)).then(
              () => send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: 'play_test_tone' }),
              (e) => send(ws, { type: 'error', code: 'TEST_TONE_FAILED', message: e.message, cmdId: msg.cmdId }),
            );
            return;
          }
          case 'debug_tts': {
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED', cmdId: msg.cmdId }); return; }
            const sid = typeof msg.sessionId === 'string' && /^\d+$/.test(msg.sessionId)
              ? BigInt(msg.sessionId)
              : activeSessionId;
            if (!sid) {
              send(ws, { type: 'error', code: 'NO_ACTIVE_SESSION', cmdId: msg.cmdId });
              return;
            }
            const text = typeof msg.text === 'string' && msg.text.trim()
              ? msg.text
              : defaultDebugTtsText();
            streamTtsToSession(sid, text).catch((e) => warn('debug_tts failed:', e.message));
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: 'debug_tts' });
            return;
          }
          case 'text_query': {
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED', cmdId: msg.cmdId }); return; }
            const question = typeof msg.question === 'string' ? msg.question.trim() : '';
            if (!question) {
              send(ws, { type: 'error', code: 'EMPTY_QUERY', cmdId: msg.cmdId });
              return;
            }
            const sid = typeof msg.sessionId === 'string' && /^\d+$/.test(msg.sessionId)
              ? msg.sessionId
              : (activeSessionId ? activeSessionId.toString() : null);
            runTextPipeline({
              sessionId: sid,
              userId: typeof msg.userId === 'string' ? msg.userId : '0',
              userDisplayName: typeof msg.userDisplayName === 'string' ? msg.userDisplayName : null,
              channelId: typeof msg.channelId === 'string' ? msg.channelId : null,
              question,
              tts: msg.tts === true,
              source: msg.source === 'mention' ? 'mention' : 'slash',
            }).catch((e) => warn('text_query failed:', e.message));
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: 'text_query' });
            return;
          }
          case 'set_params':
          case 'chat_message': {
            let forwarded = 0;
            for (const botWs of botConnections) {
              if (botWs !== ws && botWs.readyState === 1 /* OPEN */) {
                send(botWs, msg);
                forwarded++;
              }
            }
            debug('control: routed', msg.type, 'to', forwarded, 'bot(s)');
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: msg.type });
            return;
          }
          case 'stop_playback': {
            if (activeSessionId) cancelTtsForSession(activeSessionId, 'stop_playback');
            let forwarded = 0;
            for (const botWs of botConnections) {
              if (botWs !== ws && botWs.readyState === 1 /* OPEN */) {
                send(botWs, msg);
                forwarded++;
              }
            }
            debug('control: routed stop_playback to', forwarded, 'bot(s)');
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: msg.type });
            return;
          }
          case 'playback_event': {
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED', cmdId: msg.cmdId }); return; }
            if (typeof msg.sessionId !== 'string' || !/^\d+$/.test(msg.sessionId)) {
              send(ws, { type: 'error', code: 'BAD_SESSION_ID', cmdId: msg.cmdId });
              return;
            }
            const eventType = msg.eventType === 'playback_resumed' ? 'playback_resumed' : 'playback_paused';
            const { type, cmdId, eventType: _eventType, ...fields } = msg;
            logTranscriptEvent(msg.sessionId, eventType, fields);
            send(ws, { type: 'ack', cmdId, ok: true, op: eventType });
            return;
          }
          case 'utterance_end': {
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED' }); return; }
            if (typeof msg.sessionId !== 'string' || !/^\d+$/.test(msg.sessionId)) {
              send(ws, { type: 'error', code: 'BAD_SESSION_ID', cmdId: msg.cmdId });
              return;
            }
            const sid = BigInt(msg.sessionId);
            const uid = BigInt(msg.userId ?? '0');
            log('control: utterance_end sid=', sid.toString(), 'userId=', uid.toString(), 'durationMs=', msg.durationMs);
            // Fire-and-forget — pipeline errors are logged internally.
            runPipeline(sid, uid, {
              userDisplayName: typeof msg.userDisplayName === 'string' ? msg.userDisplayName : null,
              startTsMs: typeof msg.startTsMs === 'number' ? msg.startTsMs : null,
              endTsMs: typeof msg.endTsMs === 'number' ? msg.endTsMs : null,
              durationMs: typeof msg.durationMs === 'number' ? msg.durationMs : null,
            }).catch((e) => warn('pipeline error:', e.message));
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: true, op: 'utterance_end' });
            return;
          }
          case 'speaker_map_get': {
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED', cmdId: msg.cmdId }); return; }
            const map = loadSpeakerMap(msg.guildId);
            send(ws, { type: 'speaker_map', cmdId: msg.cmdId, ok: true, guildId: msg.guildId ?? null, map });
            return;
          }
          case 'speaker_map_set': {
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED', cmdId: msg.cmdId }); return; }
            if (msg.guildId == null || msg.userId == null) {
              send(ws, { type: 'error', code: 'BAD_ARGS', message: 'guildId and userId required', cmdId: msg.cmdId });
              return;
            }
            const entry = setSpeakerMapping(msg.guildId, msg.userId, msg.entry || {});
            send(ws, { type: 'speaker_map_result', cmdId: msg.cmdId, ok: true, userId: String(msg.userId), entry });
            return;
          }
          case 'finalize_prepare': {
            // Create the per-session upload dir so the bot's scp target exists.
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED', cmdId: msg.cmdId }); return; }
            if (typeof msg.sessionId !== 'string' || !/^\d+$/.test(msg.sessionId)) {
              send(ws, { type: 'error', code: 'BAD_SESSION_ID', cmdId: msg.cmdId });
              return;
            }
            try {
              const dir = ensureUploadDir(msg.sessionId);
              send(ws, { type: 'finalize_prepared', cmdId: msg.cmdId, ok: true, uploadDir: dir });
            } catch (e) {
              send(ws, { type: 'error', code: 'PREPARE_FAILED', message: e.message, cmdId: msg.cmdId });
            }
            return;
          }
          case 'finalize_session': {
            if (!registered) { send(ws, { type: 'error', code: 'NOT_REGISTERED', cmdId: msg.cmdId }); return; }
            if (typeof msg.sessionId !== 'string' || !/^\d+$/.test(msg.sessionId)) {
              send(ws, { type: 'error', code: 'BAD_SESSION_ID', cmdId: msg.cmdId });
              return;
            }
            // Long-running; fire-and-forget — replies via finalize_result.
            handleFinalize(ws, msg).catch((e) => {
              warn('finalize handler error:', e.message);
              send(ws, { type: 'finalize_result', cmdId: msg.cmdId, ok: false, error: e.message });
            });
            return;
          }
          // Phase 2/3 stubs: log and ack so the bot can develop against them.
          case 'say':
          case 'play':
          case 'save_session': {
            debug('control: stub command', msg.type);
            send(ws, { type: 'ack', cmdId: msg.cmdId, ok: false, error: 'NOT_IMPLEMENTED', op: msg.type });
            return;
          }
          default: {
            send(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: `unknown msg.type=${msg.type}`, cmdId: msg.cmdId });
            return;
          }
        }
      } catch (e) {
        warn('control dispatch error:', e.message, e.stack);
        send(ws, { type: 'error', code: 'INTERNAL', message: e.message, cmdId: msg && msg.cmdId });
      }
    });

    ws.on('close', (code, reason) => {
      botConnections.delete(ws);
      debug('control closed', code, reason && reason.toString());
    });
    ws.on('error', (e) => warn('control ws error:', e.message));
  });

  log('control ws ready');
  return wss;
}
