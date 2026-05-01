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
  }

  subscribe() {
    const { id: userId } = this.user;
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

    return new Promise((resolve, reject) => {
      function cleanup(err) {
        try { opusStream.destroy(); } catch {}
        try { decoder.destroy(); } catch {}
        try { wavWriter.destroy(); } catch {}
        if (err) reject(err);
      }

      opusStream.on('error', (e) => { warn('opusStream error:', e.message); cleanup(e); });
      decoder.on('error',    (e) => { warn('decoder error:',    e.message); cleanup(e); });
      wavWriter.on('error',  (e) => { warn('wavWriter error:',  e.message); cleanup(e); });

      opusStream.pipe(decoder).pipe(wavWriter);

      wavWriter.on('finish', () => {
        const durationMs = Math.round((totalSamples / 48000) * 1000);
        const rec = {
          userId:     this.user.id,
          username:   this.user.username,
          startMs:    relStartMs,
          durationMs,
          file,
        };
        this.onChunkDone(rec);
        sendUtteranceEnd({ sessionId, userId, durationMs });
        debug('recorder: utterance_end sent userId=', userId, 'durationMs=', durationMs);
        resolve(rec);
      });
    });
  }
}
