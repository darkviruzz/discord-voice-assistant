import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { registerTranscriptRoutes } from '../src/transcriptApi.js';
import { publishEntry, publishPresence, publishAnnotation, publishSessionEnded } from '../src/liveBus.js';
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
// `onSnapshot` runs once the server has sent its snapshot — by then the
// handler has subscribed to the bus (it subscribes BEFORE building the
// snapshot), so anything published from there on must be streamed. This
// replaces a fixed 200 ms "give it a tick" delay that raced the subscription.
function collectSse(url, predicate, { onSnapshot = () => {}, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let snapshotSeen = false;
    const req = http.get(url, (res) => {
      let buf = '';
      const events = [];
      const timer = setTimeout(() => { req.destroy(); reject(new Error(`SSE timeout; got ${JSON.stringify(events.map((e) => e.event))}`)); }, timeoutMs);
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
        if (!snapshotSeen && events.some((e) => e.event === 'snapshot')) {
          snapshotSeen = true;
          onSnapshot();
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
  const got = collectSse(url, (evs) => evs.some((e) => e.event === 'entry'), {
    onSnapshot: () => publishEntry(SID, { label: 'Greta', text: 'Hallo **Welt**', startMs: Date.now(), kind: 'user' }, { noSpeechProb: 0.03 }),
  });

  const events = await got;
  const snapshot = events.find((e) => e.event === 'snapshot');
  const entry = events.find((e) => e.event === 'entry');
  assert.ok(snapshot, 'snapshot event received');
  assert.equal(snapshot.data.sessionId, SID);
  assert.ok(entry, 'live entry received');
  assert.equal(entry.data.label, 'Greta');
  assert.equal(entry.data.text, 'Hallo **Welt**', 'text passed through verbatim (rendering escapes client-side)');
  assert.equal(entry.data.kind, 'user');
  assert.equal(entry.data.meta.noSpeechProb, 0.03);
  assert.ok(events.indexOf(snapshot) < events.indexOf(entry), 'snapshot precedes live entries');
});

test('SSE streams a presence event when voice state changes', async () => {
  const url = `${base}/transcript/live?sessionId=${SID}`;
  const got = collectSse(url, (evs) => evs.some((e) => e.event === 'presence'), {
    onSnapshot: () => {
      const s = ensureSession(SID);
      s.voice.state = 'occupied';
      s.voice.members.set('111', 'Greta');
      publishPresence(SID);
    },
  });

  const events = await got;
  const presence = events.find((e) => e.event === 'presence');
  assert.ok(presence, 'presence event received');
  assert.equal(presence.data.connected, true);
  assert.equal(presence.data.populated, true);
  assert.ok(presence.data.members.some((m) => m.label === 'Greta'));
  dropSession(SID);
});

test('SSE streams an annotation (retro wake/stop marking)', async () => {
  const url = `${base}/transcript/live?sessionId=${SID}`;
  const got = collectSse(url, (evs) => evs.some((e) => e.event === 'annotation' && e.data.startMs === 1234), {
    onSnapshot: () => {
      publishAnnotation('777', { startMs: 9, wakeDetected: true }); // other session, ignored
      publishAnnotation(SID, { startMs: 1234, wakeDetected: true });
    },
  });

  const events = await got;
  const ann = events.find((e) => e.event === 'annotation');
  assert.ok(ann, 'annotation received');
  assert.equal(ann.data.startMs, 1234);
  assert.equal(ann.data.wakeDetected, true);
  assert.ok(!events.some((e) => e.event === 'annotation' && e.data.startMs === 9), 'foreign annotation must not leak');
});

test('SSE ignores entries for a different session', async () => {
  const url = `${base}/transcript/live?sessionId=${SID}`;
  let sawForeign = false;
  // Resolve as soon as our own marker entry arrives; the foreign one was
  // published first, so had it leaked it would already be in the stream.
  const got = collectSse(url, (evs) => evs.some((e) => e.event === 'entry' && e.data.label === 'MINE'), {
    onSnapshot: () => {
      publishEntry('555000', { label: 'OTHER', text: 'x', startMs: Date.now(), kind: 'user' });
      publishEntry(SID, { label: 'MINE', text: 'y', startMs: Date.now(), kind: 'user' });
    },
  });

  const events = await got;
  sawForeign = events.some((e) => e.event === 'entry' && e.data.label === 'OTHER');
  assert.equal(sawForeign, false, 'foreign-session entry must not leak');
});

test('SSE tells the client when the session was finalized (session_ended)', async () => {
  const url = `${base}/transcript/live?sessionId=${SID}`;
  const events = await collectSse(url, (evs) => evs.some((e) => e.event === 'session_ended'), {
    onSnapshot: () => { publishSessionEnded('123'); publishSessionEnded(SID); },
  });
  const ended = events.filter((e) => e.event === 'session_ended');
  assert.deepEqual(ended.map((e) => e.data), [{ sessionId: SID }], 'only our own session_ended');
});

test('SSE without a sessionId and no active session → 404 (no stream opened)', async () => {
  const res = await fetch(`${base}/transcript/live?sessionId=not-a-number`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'no active session' });
});
