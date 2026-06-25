import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { registerTranscriptRoutes } from '../src/transcriptApi.js';
import { publishEntry, publishPresence } from '../src/liveBus.js';
import { ensureSession, dropSession } from '../src/state.js';

const SID = '999000111222';
let server, base, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sse-test-'));
  process.env.TRANSCRIPT_DIR = dir;
  process.env.TRANSCRIPT_UI_AUTH = 'off';
  const app = express();
  registerTranscriptRoutes(app);
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TRANSCRIPT_DIR;
  delete process.env.TRANSCRIPT_UI_AUTH;
});

// Read SSE frames until `predicate(events)` is satisfied or it times out.
function collectSse(url, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let buf = '';
      const events = [];
      const timer = setTimeout(() => { req.destroy(); reject(new Error('SSE timeout')); }, timeoutMs);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event:\s*(.+)$/m.exec(frame);
          const data = /^data:\s*(.+)$/m.exec(frame);
          if (ev && data) {
            try { events.push({ event: ev[1].trim(), data: JSON.parse(data[1]) }); } catch {}
          }
        }
        if (predicate(events)) { clearTimeout(timer); req.destroy(); resolve(events); }
      });
      res.on('error', () => {}); // destroy() triggers this; ignore
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}

test('SSE sends a snapshot then a live entry published to the bus', async () => {
  const url = `${base}/transcript/live?sessionId=${SID}`;
  // Once connected (snapshot arrived), push an entry and expect it to stream.
  const got = collectSse(url, (evs) => evs.some((e) => e.event === 'entry'));
  // Give the server a tick to subscribe + emit the snapshot, then publish.
  setTimeout(() => {
    publishEntry(SID, { label: 'Greta', text: 'Hallo **Welt**', startMs: Date.now(), kind: 'user' }, { noSpeechProb: 0.03 });
  }, 200);

  const events = await got;
  const snapshot = events.find((e) => e.event === 'snapshot');
  const entry = events.find((e) => e.event === 'entry');
  assert.ok(snapshot, 'snapshot event received');
  assert.equal(snapshot.data.sessionId, SID);
  assert.ok(entry, 'live entry received');
  assert.equal(entry.data.label, 'Greta');
  assert.equal(entry.data.meta.noSpeechProb, 0.03);
});

test('SSE streams a presence event when voice state changes', async () => {
  const url = `${base}/transcript/live?sessionId=${SID}`;
  const got = collectSse(url, (evs) => evs.some((e) => e.event === 'presence'));
  setTimeout(() => {
    const s = ensureSession(SID);
    s.voice.state = 'occupied';
    s.voice.members.set('111', 'Greta');
    publishPresence(SID);
  }, 200);

  const events = await got;
  const presence = events.find((e) => e.event === 'presence');
  assert.ok(presence, 'presence event received');
  assert.equal(presence.data.connected, true);
  assert.equal(presence.data.populated, true);
  assert.ok(presence.data.members.some((m) => m.label === 'Greta'));
  dropSession(SID);
});

test('SSE ignores entries for a different session', async () => {
  const url = `${base}/transcript/live?sessionId=${SID}`;
  let sawForeign = false;
  const got = collectSse(url, (evs) => {
    // resolve as soon as our own marker entry arrives
    return evs.some((e) => e.event === 'entry' && e.data.label === 'MINE');
  });
  setTimeout(() => {
    publishEntry('555000', { label: 'OTHER', text: 'x', startMs: Date.now(), kind: 'user' });
    publishEntry(SID, { label: 'MINE', text: 'y', startMs: Date.now(), kind: 'user' });
  }, 200);

  const events = await got;
  sawForeign = events.some((e) => e.event === 'entry' && e.data.label === 'OTHER');
  assert.equal(sawForeign, false, 'foreign-session entry must not leak');
});
