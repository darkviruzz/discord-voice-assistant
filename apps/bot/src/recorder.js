import fs from 'fs';
import path from 'path';
import { EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import wav from 'wav';
import { safePath, debug, warn } from './logger.js';
import { nowMs } from './util.js';
import { sendUplinkFrame, sendUtteranceEnd } from './transport/index.js';

export class UtteranceRecorder {
  constructor(session, connection, receiver, user, options = {}) {
    this.session    = session;   // SessionManager.active — { startedAt, dir, ... }
    this.connection = connection;
    this.receiver   = receiver;
    this.user       = user;      // { id: string, username: string }
    this.silenceMs  = options.silenceMs  ?? 1000;
    this.onChunkDone = options.onChunkDone ?? (() => {});
    // Set once subscribe() runs — lets dispose() tear an in-flight chunk down.
    this._endEarly  = null;
    this._settled   = false;
  }

  subscribe() {
    const { id: userId, username } = this.user;
    const sessionId = BigInt(this.session.startedAt).toString(); // wire format

    const opusStream = this.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.silenceMs },
    });

    const startedAt  = nowMs();
    const relStartMs = Math.max(0, startedAt - this.session.startedAt);

    const file = safePath(this.session.dir, 'chunks', `${userId}_${startedAt}.wav`);
    const decoder   = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });
    const wavWriter = new wav.FileWriter(file, { channels: 1, sampleRate: 48000, bitDepth: 16 });

    // Tap raw Opus packets BEFORE the decoder and forward to the server uplink.
    // `opusStream` is a Readable; adding a `data` listener here does not
    // conflict with the downstream pipe — both consumers see every packet.
    let uplinkFrames = 0;
    opusStream.on('data', (opus) => {
      if (++uplinkFrames === 1) debug('recorder: first opus frame userId=', userId, 'bytes=', opus.length);
      sendUplinkFrame({ sessionId, userId, tsMs: Date.now(), opus });
    });

    let totalSamples = 0;
    decoder.on('data', (pcm) => { totalSamples += pcm.length / 2; });

    return new Promise((resolve) => {
      let settled = false;
      const settle = (rec) => {
        if (settled) return;
        settled = true;
        this._settled = true;
        resolve(rec);
      };

      // Normal completion: WAV fully flushed → emit the chunk + utterance_end.
      const finalizeChunk = () => {
        const durationMs = Math.round((totalSamples / 48000) * 1000);
        if (durationMs <= 0) { settle(null); return; }  // nothing decoded (e.g. all-corrupt) → drop
        const rec = {
          userId:   this.user.id,
          username: this.user.username,
          startMs:  relStartMs,
          durationMs,
          file,
        };
        try { this.onChunkDone(rec); } catch (e) { warn('onChunkDone failed:', e.message); }
        sendUtteranceEnd({
          sessionId,
          userId,
          durationMs,
          startTsMs: startedAt,
          endTsMs: startedAt + durationMs,
          userDisplayName: username,
        });
        debug('recorder: utterance_end sent userId=', userId, 'durationMs=', durationMs);
        settle(rec);
      };

      // Stop the chunk early without crashing: a single corrupt Opus packet
      // (decoder throws) or a voice reconnect (stale decryption key) must NOT
      // kill the process. Detach the pipeline and flush the audio captured so
      // far; the next `speaking.start` opens a fresh recorder with the new key.
      const endEarly = (why) => {
        if (settled) return;
        debug('recorder: ending chunk early userId=', userId, 'reason=', why);
        try { opusStream.unpipe(decoder); } catch {}
        try { decoder.unpipe(wavWriter); } catch {}
        try { opusStream.destroy(); } catch {}
        try { decoder.destroy(); } catch {}
        if (wavWriter.writable && !wavWriter.writableEnded) {
          try { wavWriter.end(); } catch { finalizeChunk(); }  // end() → 'finish' → finalizeChunk
        } else {
          finalizeChunk();
        }
      };
      this._endEarly = endEarly;

      // Errors are non-fatal: log + end the chunk gracefully, never reject.
      opusStream.on('error', (e) => { warn('opusStream error:', e.message); endEarly('opus-error'); });
      decoder.on('error',    (e) => { warn('decoder error:',    e.message); endEarly('decoder-error'); });
      wavWriter.on('error',  (e) => {
        warn('wavWriter error:', e.message);
        try { opusStream.destroy(); } catch {}
        try { decoder.destroy(); } catch {}
        settle(null);
      });

      opusStream.pipe(decoder).pipe(wavWriter);

      wavWriter.on('finish', finalizeChunk);
    });
  }

  // Tear down an in-flight recording from the outside (e.g. the voice
  // connection left READY → its decryption context is now stale). Flushes the
  // partial WAV and settles the subscribe() promise. Safe to call repeatedly.
  dispose() {
    if (this._endEarly) this._endEarly('dispose');
  }
}
