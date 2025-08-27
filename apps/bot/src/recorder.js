import fs from 'fs';
import net from 'net';
import path from 'path';
import { EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import wav from 'wav';
import { safePath, debug, log, warn } from './logger.js';
import { nowMs } from './util.js';

export class UtteranceRecorder {
  constructor(session, connection, receiver, user, options = {}) {
    this.session = session; // SessionManager.active
    this.connection = connection;
    this.receiver = receiver;
    this.user = user; // { id, username }
    this.silenceMs = options.silenceMs ?? 1000;
    this.onChunkDone = options.onChunkDone ?? (() => {});

    // Optional Live-Streaming (PCM) via TCP
    this.streamTcpHost = process.env.STREAM_TCP_HOST || null;
    this.streamTcpPort = process.env.STREAM_TCP_PORT || null;
  }

  subscribe() {
    const { id: userId } = this.user;

    const opusStream = this.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.silenceMs },
    });

    const startedAt = nowMs();
    const relStartMs = Math.max(0, startedAt - this.session.startedAt);

    // Dateiname (WAV 48kHz mono PCM 16bit)
    const base = `${this.user.id}_${startedAt}`;
    const file = safePath(this.session.dir, 'chunks', `${base}.wav`);

    fs.mkdirSync(path.dirname(file), { recursive: true });

	const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });
    const wavWriter = new wav.FileWriter(file, { channels: 1, sampleRate: 48000, bitDepth: 16 });

    // Optional: Live-Streaming an TCP
    let socket = null;
    if (this.streamTcpHost && this.streamTcpPort) {
      try {
        socket = net.createConnection({ host: this.streamTcpHost, port: Number(this.streamTcpPort) });
        socket.on('error', (e) => warn('TCP stream error:', e.message));
        debug('TCP stream connected for', this.user.id);
      } catch (e) { warn('TCP stream connect failed:', e.message); }
    }

    let totalSamples = 0;

    decoder.on('data', (pcm) => {
      totalSamples += pcm.length / 2; // 16-bit mono
      if (socket && socket.writable) {
        // Rohes PCM s16le, 48kHz mono – STT-Seite muss Format kennen
        socket.write(pcm);
      }
    });

    return new Promise((resolve) => {
      opusStream.pipe(decoder).pipe(wavWriter);

      wavWriter.on('finish', () => {
        const durationMs = Math.round((totalSamples / 48000) * 1000);
        const rec = {
          userId: this.user.id,
          username: this.user.username,
          startMs: relStartMs,
          durationMs,
          file,
        };
        this.onChunkDone(rec);
        if (socket) socket.end();
        resolve(rec);
      });
    });
  }
}