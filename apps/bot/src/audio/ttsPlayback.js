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

    if (!this.active) this.start();
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
    try { this.player.stop(true); } catch {}
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

    debug('tts-playback: waiting for frames queue=0 done=false');
    this.waiter = () => setImmediate(() => this._pump(readable));
  }

  _notify() {
    if (!this.waiter) return;
    const waiter = this.waiter;
    this.waiter = null;
    waiter();
  }
}
