import { Readable } from 'stream';
import WebSocket from 'ws';
import {
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import { parseFrame, MAGIC_DNLK } from './protocol.js';
import { JitterBuffer } from './jitter.js';
import { log, debug, warn } from '../logger.js';

// Three-byte Opus silence frame (20ms, 48kHz mono). Discord does not mark
// the bot as "speaking" when it receives these.
const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

// PlaybackStream is the pull-based Readable that the AudioPlayer consumes.
// It returns one Opus Buffer per _read() call (every ~20ms). When the gate is
// closed or the buffer is empty, it returns a silence frame so the AudioPlayer
// stays in Playing state without startup latency when audio resumes.
class PlaybackStream extends Readable {
  constructor(jitterBuffer, gating) {
    super({ objectMode: true });
    this._jitter  = jitterBuffer;
    this._gating  = gating;
    this._active  = true;
  }

  _read() {
    if (!this._active) { this.push(null); return; }
    const packet = this._gating.isOpen()
      ? (this._jitter.shift(this._gating.playoutMaxMs) ?? SILENCE_FRAME)
      : SILENCE_FRAME;
    this.push(packet);
  }

  destroy(err) {
    this._active = false;
    super.destroy(err);
  }
}

export class DownlinkClient {
  constructor({ baseUrl, bearer, params = {} }) {
    this.url    = `${baseUrl}/downlink`;
    this.bearer = bearer || null;

    this.gateMs         = params.gateMs         ?? 80;
    this.playoutMaxMs   = params.playoutMaxMs    ?? 1500;
    // Minimum continuous speaking time before the gate closes.
    // Sounds shorter than this (laughs, coughs) will not interrupt playback.
    this.interruptMinMs = params.interruptMinMs  ?? 400;
    // After a real interruption ends, wait this long before resuming.
    this.resumeGateMs   = params.resumeGateMs    ?? 900;

    this._jitter         = new JitterBuffer();
    this._activeSpeakers = new Set();
    this._lastSpeakEnd   = 0;
    // Pending timers before a speaking event is treated as a real interruption.
    this._speakTimers    = new Map(); // userId → setTimeout handle
    // Gate duration to use after the next silence (null = use gateMs).
    this._nextGateMs     = null;
    // True when the jitter buffer was non-empty at the start of the current interruption.
    // Prevents rewind after the bot has already finished speaking.
    this._interruptedWhilePlaying = false;

    // Gating interface passed to PlaybackStream.
    this._gating = {
      isOpen: () => {
        if (this._activeSpeakers.size > 0) return false;
        const needed  = this._nextGateMs ?? this.gateMs;
        const elapsed = Date.now() - this._lastSpeakEnd;
        if (elapsed >= needed) {
          const wasInterrupted = this._nextGateMs !== null;
          this._nextGateMs = null; // consumed
          if (wasInterrupted && this._interruptedWhilePlaying) {
            this._jitter.rewind(1000);
            this._interruptedWhilePlaying = false;
          }
          return true;
        }
        return false;
      },
      get playoutMaxMs() { return 1500; }, // placeholder — overridden below
    };
    Object.defineProperty(this._gating, 'playoutMaxMs', { get: () => this.playoutMaxMs, configurable: true });

    this._ws            = null;
    this._playStream    = null;
    this._player        = this._createPlayer();
    this._connection    = null;
    this._sessionId     = null;
  }

  _createPlayer() {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    player.on('error', (e) => {
      warn('downlink: AudioPlayer error:', e.message);
      // Resource errored; recreate on the next open() call.
      this._playStream = null;
    });
    player.on(AudioPlayerStatus.Idle, () => debug('downlink: player idle'));
    return player;
  }

  _startPlayback() {
    if (this._playStream) return; // already playing
    this._playStream = new PlaybackStream(this._jitter, this._gating);
    const resource = createAudioResource(this._playStream, {
      inputType: StreamType.Opus,
    });
    this._player.play(resource);
    debug('downlink: playback started');
  }

  // Open WS connection and begin subscribing to a session.
  open(sessionId) {
    this.close(); // tear down any previous connection first
    this._sessionId = sessionId;

    const headers = this.bearer ? { Authorization: `Bearer ${this.bearer}` } : {};
    let ws;
    try {
      ws = new WebSocket(this.url, { headers });
    } catch (e) {
      warn('downlink: open failed:', e.message);
      return;
    }
    this._ws = ws;

    ws.on('open', () => {
      debug('downlink: connected, subscribing to session', sessionId);
      try {
        ws.send(JSON.stringify({ subscribe: true, sessionId }));
      } catch (e) { warn('downlink: subscribe send failed:', e.message); }
      this._startPlayback();
    });

    let downlinkFrames = 0;
    let firstTsMs      = null;
    let lastTsMs       = null;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      try {
        const f = parseFrame(Buffer.from(data));
        if (!f.magic.equals(MAGIC_DNLK)) return;
        downlinkFrames++;
        if (downlinkFrames === 1) {
          firstTsMs = f.tsMs;
          debug('downlink: first frame, tsMs=', f.tsMs, 'now=', Date.now());
        }
        // Log if there's a suspicious gap or overlap between consecutive timestamps.
        if (lastTsMs !== null && f.tsMs < lastTsMs) {
          warn('downlink: out-of-order tsMs — got', f.tsMs, 'after', lastTsMs,
               '(gap', f.tsMs - lastTsMs, 'ms) — jitter drops likely!');
        } else if (lastTsMs !== null && f.tsMs - lastTsMs > 100) {
          debug('downlink: tsMs gap', f.tsMs - lastTsMs, 'ms at frame', downlinkFrames,
                '(expected ~20ms) — new sentence batch');
        }
        lastTsMs = f.tsMs;
        this._jitter.add(f.payload, f.tsMs);
      } catch (e) {
        warn('downlink: parse error:', e.message);
      }
    });

    ws.on('close', (code) => {
      debug('downlink: ws closed', code);
      if (this._ws === ws) this._ws = null;
    });
    ws.on('error', (e) => {
      warn('downlink: ws error:', e.message);
      if (this._ws === ws) this._ws = null;
    });
  }

  close() {
    const ws = this._ws;
    this._ws = null;
    if (ws) try { ws.close(); } catch {}

    if (this._playStream) {
      this._playStream._active = false;
      this._playStream = null;
    }
    this._jitter.clear();
    this._interruptedWhilePlaying = false;
    this._sessionId = null;
  }

  // Bind the AudioPlayer to a VoiceConnection so it can output audio.
  setVoiceConnection(conn) {
    this._connection = conn;
    conn.subscribe(this._player);
    debug('downlink: subscribed player to voice connection');
  }

  clearVoiceConnection() {
    this._connection = null;
    // Unsubscribe by stopping the player; the connection's subscription is
    // managed by @discordjs/voice internally.
    this._player.stop(true);
    debug('downlink: cleared voice connection');
  }

  speakingStart(userId) {
    if (this._speakTimers.has(userId)) return; // already counting

    // Do NOT close the gate while TTS is playing (jitter buffer non-empty).
    // Automatic interruption via speaking events causes SILENCE_FRAMEs to be
    // inserted mid-stream, which produces audible Opus decoder artefacts
    // ("choppy noise").  Explicit interruption is handled by the stop command
    // (stop_playback → jitter.clear()), which cleanly empties the buffer.
    if (this._jitter.size > 0) {
      debug('downlink: speaking start userId=', userId, '— TTS playing, gate stays open');
      return;
    }

    // Capture playback state now; the buffer may drain before the timer fires.
    const wasPlaying = false; // jitter was empty above, so definitely not playing
    const timer = setTimeout(() => {
      this._speakTimers.delete(userId);
      this._activeSpeakers.add(userId);
      this._interruptedWhilePlaying = wasPlaying;
    }, this.interruptMinMs);
    this._speakTimers.set(userId, timer);
  }

  speakingEnd(userId) {
    const timer = this._speakTimers.get(userId);
    if (timer) {
      // Speech ended before the threshold — treat as noise, ignore.
      clearTimeout(timer);
      this._speakTimers.delete(userId);
      return;
    }
    this._activeSpeakers.delete(userId);
    if (this._activeSpeakers.size === 0) {
      this._lastSpeakEnd = Date.now();
      this._nextGateMs   = this.resumeGateMs; // real interruption — use long gap
    }
  }

  setParams({ gateMs, playoutMaxMs, interruptMinMs, resumeGateMs }) {
    if (typeof gateMs         === 'number') this.gateMs         = gateMs;
    if (typeof playoutMaxMs   === 'number') this.playoutMaxMs   = playoutMaxMs;
    if (typeof interruptMinMs === 'number') this.interruptMinMs = interruptMinMs;
    if (typeof resumeGateMs   === 'number') this.resumeGateMs   = resumeGateMs;
    debug('downlink: params updated', { gateMs: this.gateMs, playoutMaxMs: this.playoutMaxMs, interruptMinMs: this.interruptMinMs, resumeGateMs: this.resumeGateMs });
  }

  stopPlayback() {
    this._jitter.clear();
    debug('downlink: playback buffer flushed');
  }

  updateSession(sessionId) {
    if (sessionId === this._sessionId) return;
    const wasOpen = !!this._ws;
    this.close();
    if (wasOpen) this.open(sessionId);
  }
}
