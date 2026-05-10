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
  constructor() {
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
    debug('tts-playback: start id=', id);
  }

  pushFrame(id, frame, seq) {
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
    if (id !== this.currentId) {
      debug('tts-playback: ignoring stale done id=', id, 'current=', this.currentId);
      return;
    }
    this.done = true;
    debug(`tts-playback: done received id=${id} queue=${this.queue.length}`);
    this._notify();
  }

  stop() {
    if (this.currentId) debug('tts-playback: stopped id=', this.currentId);
    this.queue = [];
    this.done = true;
    this.currentId = null;
    this.waiter = null;
    this.framesReceived = 0;
    this.framesPlayed = 0;
    this.active = false;
    this.paused = false;
    this.pauseLogged = false;
    try { this.player.stop(true); } catch {}
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
}
