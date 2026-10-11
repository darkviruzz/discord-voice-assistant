import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logTranscriptEvent, SCHEMA_VERSION } from '../src/transcript.js';
import { readSessionEvents } from '../src/sessionEvents.js';

// The JSONL event log is the source of truth for the web UI, the live-context
// rebuild and finalize — its write/read round trip must be lossless.
let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-log-'));
  process.env.TRANSCRIPT_DIR = `${dir}/nested/`; // created on demand; trailing slash tolerated
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.TRANSCRIPT_DIR;
});

test('logTranscriptEvent stamps schemaVersion/tsMs/type/sessionId and stringifies BigInts at any depth', () => {
  const sid = 1780058709544n;
  const t0 = Date.now();
  logTranscriptEvent(sid, 'user_transcript', {
    userId: 696665320185659453n,
    text: 'Hallo „Welt“\nzweite Zeile',
    words: [{ w: 'Hallo', t0: 0, t1: 300, speaker: 12n }],
    stt: { provider: 'whisper.cpp', nested: { id: 5n } },
  });
  const { events, jsonlPath } = readSessionEvents(sid.toString());
  assert.equal(jsonlPath, path.join(`${dir}/nested`, 'session_1780058709544.jsonl'));
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.schemaVersion, SCHEMA_VERSION);
  assert.equal(e.type, 'user_transcript');
  assert.equal(e.sessionId, '1780058709544');
  assert.ok(e.tsMs >= t0 && e.tsMs <= Date.now());
  assert.equal(e.userId, '696665320185659453', 'snowflake kept exact as a string');
  assert.equal(e.text, 'Hallo „Welt“\nzweite Zeile');
  assert.equal(e.words[0].speaker, '12');
  assert.equal(e.stt.nested.id, '5');
});

test('events append in order; explicit fields override the stamped defaults', () => {
  logTranscriptEvent('42', 'a', { n: 1 });
  logTranscriptEvent('42', 'b', { n: 2, tsMs: 123 });
  const { events } = readSessionEvents('42');
  assert.deepEqual(events.map((e) => [e.type, e.n]), [['a', 1], ['b', 2]]);
  assert.equal(events[1].tsMs, 123, 'explicit tsMs (e.g. replayed events) wins');
});

test('readSessionEvents skips blank and malformed lines and reports a missing log', () => {
  const fp = path.join(`${dir}/nested`, 'session_7.jsonl');
  fs.writeFileSync(fp, '{"type":"ok","n":1}\n\n{truncated\n   \n{"type":"ok","n":2}');
  assert.deepEqual(readSessionEvents('7').events.map((e) => e.n), [1, 2]);
  assert.deepEqual(readSessionEvents('999'), { events: [], jsonlPath: null });
});
