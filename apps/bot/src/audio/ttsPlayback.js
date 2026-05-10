import { Readable } from 'stream';
import {
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import { debug, warn } from '../logger.js';

class QueueReadable extends Readable {
  constructor(playback) {
    super({ objectMode: true, highWaterMark: 1 });
    this._playback = playback;
  }

  _read() {
    this._playback._pump(this);
  }
}

export class TtsPlayback {
  constructor({ rewindMs = 1000 } = {}) {
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    this.queue = [];
    this.done = true;
    this.active = false;
    this.waiter = null;
    this.currentId = null;
    this.readable = null;
    this.framesReceived = 0;
    this.framesPlayed = 0;
    this.paused = false;
    this.pauseLogged = false;
    this.rewindMs = rewindMs;
    this.history = [];
    this.ignoredIds = new Set();

    this.player.on(AudioPlayerStatus.Idle, () => {
      debug('tts-playback: player idle');
      this.active = false;
      this.readable = null;
    });

    this.player.on('error', (e) => {
      warn('tts-playback: player error:', e.message);
      this.stop();
    });
  }

  subscribe(connection) {
    connection.subscribe(this.player);
    debug('tts-playback: subscribed player to voice connection');
  }

  begin(id) {
    if (this.ignoredIds.has(id)) {
      debug('tts-playback: ignoring cancelled start id=', id);
      return;
    }
    if (this.currentId && this.currentId !== id) {
      debug('tts-playback: replacing active request', this.currentId, 'with', id);
      this.stop();
    }

    this.currentId = id;
    this.queue = [];
    this.done = false;
    this.framesReceived = 0;
    this.framesPlayed = 0;
    this.waiter = null;
    this.paused = false;
    this.pauseLogged = false;
    this.history = [];
    debug('tts-playback: start id=', id);
  }

  pushFrame(id, frame, seq) {
    if (this.ignoredIds.has(id)) return;
    if (!this.currentId) {
      this.begin(id);
    }
    if (id !== this.currentId) {
      debug('tts-playback: ignoring stale frame id=', id, 'current=', this.currentId);
      return;
    }

    this.queue.push({ frame, seq });
    this.framesReceived++;
    if (this.framesReceived === 1 || this.framesReceived % 50 === 0) {
      debug(`tts-playback: frame received id=${id} seq=${seq} received=${this.framesReceived} queue=${this.queue.length}`);
    }

    if (!this.active && !this.paused) this.start();
    this._notify();
  }

  markDone(id) {
    if (this.ignoredIds.has(id)) return;
    if (id !== this.currentId) {
      debug('tts-playback: ignoring stale done id=', id, 'current=', this.currentId);
      return;
    }
    this.done = true;
    debug(`tts-playback: done received id=${id} queue=${this.queue.length}`);
    this._notify();
  }

  stop() {
    const stats = this.stats();
    if (this.currentId) debug('tts-playback: stopped id=', this.currentId);
    if (this.currentId) this._ignoreId(this.currentId);
    this.queue = [];
    this.done = true;
    this.currentId = null;
    this.waiter = null;
    this.framesReceived = 0;
    this.framesPlayed = 0;
    this.active = false;
    this.paused = false;
    this.pauseLogged = false;
    this.history = [];
    try { this.player.stop(true); } catch {}
    return stats;
  }

  pause(reason = 'interrupt') {
    if (!this.currentId || this.paused) return;
    this.paused = true;
    this.pauseLogged = false;
    debug('tts-playback: paused id=', this.currentId, 'reason=', reason, 'queue=', this.queue.length);
  }

  resume(reason = 'resume') {
    if (!this.paused) return;
    this.paused = false;
    this.pauseLogged = false;
    debug('tts-playback: resumed id=', this.currentId, 'reason=', reason, 'queue=', this.queue.length);
    this._rewind();
    if (!this.active && this.currentId && (this.queue.length > 0 || !this.done)) {
      debug('tts-playback: restarting player after pause idle');
      this.start();
      return;
    }
    this._notify();
  }

  start() {
    if (this.active || !this.currentId) return;
    this.active = true;
    this.readable = new QueueReadable(this);
    const resource = createAudioResource(this.readable, {
      inputType: StreamType.Opus,
    });
    this.player.play(resource);
    debug('tts-playback: play called id=', this.currentId);
  }

  setParams({ rewindMs } = {}) {
    if (typeof rewindMs === 'number' && Number.isFinite(rewindMs) && rewindMs >= 0) {
      this.rewindMs = rewindMs;
      this._trimHistory();
    }
  }

  isPaused() {
    return this.paused;
  }

  stats() {
    if (!this.currentId) return null;
    return {
      id: this.currentId,
      framesPlayed: this.framesPlayed,
      msPlayed: this.framesPlayed * 20,
      framesReceived: this.framesReceived,
      msReceived: this.framesReceived * 20,
      queue: this.queue.length,
      done: this.done,
      paused: this.paused,
    };
  }

  _pump(readable) {
    if (readable !== this.readable) return;

    if (this.paused) {
      if (!this.pauseLogged) {
        debug('tts-playback: read paused queue=', this.queue.length);
        this.pauseLogged = true;
      }
      this._wait(readable);
      return;
    }

    const item = this.queue.shift();
    if (item) {
      this.framesPlayed++;
      this.history.push(item);
      this._trimHistory();
      if (this.framesPlayed === 1 || this.framesPlayed % 50 === 0) {
        debug(`tts-playback: read frame seq=${item.seq} played=${this.framesPlayed} queue=${this.queue.length}`);
      }
      readable.push(item.frame);
      return;
    }

    if (this.done) {
      debug(`tts-playback: stream ended id=${this.currentId} played=${this.framesPlayed} received=${this.framesReceived}`);
      this.currentId = null;
      readable.push(null);
      return;
    }

    debug(`tts-playback: waiting for frames queue=0 done=false played=${this.framesPlayed} received=${this.framesReceived}`);
    this._wait(readable);
  }

  _notify() {
    if (!this.waiter) return;
    const waiter = this.waiter;
    this.waiter = null;
    waiter();
  }

  _wait(readable) {
    this.waiter = () => setImmediate(() => this._pump(readable));
  }

  _rewind() {
    const frames = Math.min(Math.ceil(this.rewindMs / 20), this.history.length);
    if (frames <= 0) return;
    const rewindFrames = this.history.slice(-frames);
    this.queue.unshift(...rewindFrames);
    debug(`tts-playback: rewound ${frames} frames (${frames * 20} ms), queue=${this.queue.length}`);
  }

  _trimHistory() {
    const maxFrames = Math.max(0, Math.ceil(this.rewindMs / 20));
    if (maxFrames === 0) {
      this.history = [];
      return;
    }
    if (this.history.length > maxFrames) {
      this.history.splice(0, this.history.length - maxFrames);
    }
  }

  _ignoreId(id) {
    this.ignoredIds.add(id);
    if (this.ignoredIds.size > 20) {
      const [oldest] = this.ignoredIds;
      this.ignoredIds.delete(oldest);
    }
  }
}
