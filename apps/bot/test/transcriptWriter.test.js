import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// transcriptWriter.js freezes BOT_TRANSCRIPT_DIR / retention at import time.
// DIR is nested one level below a scratch root so an escape to its parent is
// observable without touching the shared tmp dir.
let root;
let dir;
let writeTranscriptEvent;
let startTranscriptCleanup;
const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-transcripts-'));
  dir = path.join(root, 'transcripts');
  process.env.BOT_TRANSCRIPT_DIR = dir;
  process.env.BOT_TRANSCRIPT_RETENTION_DAYS = '30';
  ({ writeTranscriptEvent, startTranscriptCleanup } = await import('../src/transcriptWriter.js'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.BOT_TRANSCRIPT_DIR;
  delete process.env.BOT_TRANSCRIPT_RETENTION_DAYS;
});

const readLines = (fp) => fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('writeTranscriptEvent appends one JSON line per event to session_<id>.jsonl (dir created on demand)', () => {
  assert.equal(fs.existsSync(dir), false);
  const a = { type: 'user_transcript', text: 'Hallo „Welt“\nzweite Zeile', tsMs: 1 };
  const b = { type: 'assistant_response', text: 'Antwort', tsMs: 2 };
  writeTranscriptEvent('1700000000000', a);
  writeTranscriptEvent('1700000000000', b);
  writeTranscriptEvent(1700000000001, b); // numeric id from JSON is fine too
  assert.deepEqual(readLines(path.join(dir, 'session_1700000000000.jsonl')), [a, b]);
  assert.deepEqual(readLines(path.join(dir, 'session_1700000000001.jsonl')), [b]);
});

test('a sessionId from the wire can never steer the write outside BOT_TRANSCRIPT_DIR', () => {
  // path.join(DIR, 'session_/../../escape.jsonl') normalises to <root>/escape.jsonl.
  for (const evil of ['/../../escape', '/../escape', '../x', 'a/b', '']) {
    assert.doesNotThrow(() => writeTranscriptEvent(evil, { type: 'x' }));
  }
  assert.equal(fs.existsSync(path.join(root, 'escape.jsonl')), false, 'nothing written next to DIR');
  assert.equal(fs.existsSync(path.join(dir, 'escape.jsonl')), false);
  const stray = fs.readdirSync(dir).filter((f) => !/^session_\d+\.jsonl$/.test(f));
  assert.deepEqual(stray, [], 'only numeric session files exist');
});

test('startTranscriptCleanup prunes files past the retention window and keeps recent ones', () => {
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'session_1.jsonl');
  const edge = path.join(dir, 'session_2.jsonl');
  const fresh = path.join(dir, 'session_3.jsonl');
  const oldSubdir = path.join(dir, 'keep-me');
  for (const fp of [old, edge, fresh]) fs.writeFileSync(fp, '{}\n');
  fs.mkdirSync(oldSubdir);
  const ago = (days) => new Date(Date.now() - days * DAY);
  fs.utimesSync(old, ago(31), ago(31));
  fs.utimesSync(edge, ago(29), ago(29));
  fs.utimesSync(oldSubdir, ago(400), ago(400));

  startTranscriptCleanup();

  assert.equal(fs.existsSync(old), false, '31-day-old log pruned');
  assert.ok(fs.existsSync(edge), '29-day-old log kept');
  assert.ok(fs.existsSync(fresh), 'fresh log kept');
  assert.ok(fs.existsSync(oldSubdir), 'directories are never removed by the file pruner');
});
