/**
 * Minimal TTS playback test — completely bypasses the downlink WS / jitter
 * buffer / gating pipeline so we can isolate whether the noise originates in
 * the encode path or in the WS delivery path.
 *
 * Flow:
 *   GET /debug/tts  →  array of Opus Buffers  →  pre-loaded Readable  →  AudioPlayer
 *
 * The test player temporarily takes over the VoiceConnection subscription.
 * When playback ends, onDone() is called so the caller can re-subscribe the
 * normal downlink player.
 */
import http     from 'http';
import { Readable } from 'stream';
import {
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import { log, warn, debug } from './logger.js';

/**
 * @param {import('@discordjs/voice').VoiceConnection} connection
 * @param {string} baseUrl  e.g. "http://192.168.20.101:7440"
 * @param {() => void} [onDone]  called when the test player goes idle
 */
export async function runDebugPlayback(connection, baseUrl, onDone) {
  log('debugPlayback: fetching Opus frames from', baseUrl + '/debug/tts');

  let frames;
  try {
    frames = await fetchOpusFrames(baseUrl + '/debug/tts');
  } catch (e) {
    warn('debugPlayback: fetch failed:', e.message);
    onDone?.();
    return;
  }
  log(`debugPlayback: ${frames.length} frames fetched (${frames.length * 20} ms of audio)`);

  if (frames.length === 0) {
    warn('debugPlayback: server returned 0 frames');
    onDone?.();
    return;
  }

  // Pre-loaded pull stream — no timestamps, no jitter, no gating.
  // The AudioPlayer calls _read() every 20 ms; we hand over one Buffer per call.
  let idx = 0;
  const stream = new Readable({
    objectMode:    true,
    highWaterMark: 1,
    read() {
      if (idx < frames.length) {
        debug(`debugPlayback: _read frame ${idx + 1}/${frames.length}`);
        this.push(frames[idx++]);
      } else {
        debug('debugPlayback: stream exhausted, pushing null');
        this.push(null);
      }
    },
  });

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });

  player.on('error', (e) => warn('debugPlayback: player error:', e.message));

  player.on(AudioPlayerStatus.Idle, () => {
    log('debugPlayback: playback complete (player idle)');
    try { sub.unsubscribe(); } catch {}
    onDone?.();
  });

  // Subscribe OUR player — this detaches the normal downlink player.
  const sub = connection.subscribe(player);
  log('debugPlayback: test player subscribed to voice connection');

  const resource = createAudioResource(stream, { inputType: StreamType.Opus });
  player.play(resource);
  log('debugPlayback: play() called');
}

/** Fetch length-prefixed Opus frames: [UInt32BE len][bytes]... */
function fetchOpusFrames(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port:     parseInt(u.port, 10) || 80,
        path:     u.pathname,
        method:   'GET',
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
        const chunks = [];
        res.on('data',  (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          const buf    = Buffer.concat(chunks);
          const frames = [];
          let off = 0;
          while (off + 4 <= buf.length) {
            const len = buf.readUInt32BE(off);
            off += 4;
            if (off + len > buf.length) {
              warn('debugPlayback: truncated frame at offset', off);
              break;
            }
            frames.push(buf.subarray(off, off + len));
            off += len;
          }
          log(`debugPlayback: parsed ${frames.length} frames from ${buf.length}B response`);
          resolve(frames);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
