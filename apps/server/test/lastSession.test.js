import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastSessionBlock, resetLastSessionCache, fairShares, lastSessionContextCount } from '../src/lastSession.js';
import { finalizeSession } from '../src/finalize/index.js';

const KEYS = ['ARCHIVE_DIR', 'LAST_SESSION_CONTEXT_ENABLED', 'LAST_SESSION_CONTEXT_MAX_CHARS', 'LAST_SESSION_CONTEXT_COUNT', 'FINALIZE_TZ'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'last-sess-'));
after(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(root, { recursive: true, force: true });
});
let dir;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  dir = fs.mkdtempSync(path.join(root, 't-')); // fresh archive per test
  process.env.ARCHIVE_DIR = dir;
  process.env.FINALIZE_TZ = 'Europe/Berlin';
  resetLastSessionCache();
});

function archive(name, startMs, summary) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'manifest.json'), JSON.stringify({ sessionStartMs: startMs }));
  if (summary != null) fs.writeFileSync(path.join(dir, name, 'summary.md'), summary);
}

test('no finalized session → no block', () => {
  assert.equal(lastSessionBlock(), '');
});

test('newest session summary with date, marked as on-request only', () => {
  archive('2026-10-01', Date.UTC(2026, 9, 1, 18), 'Die Gruppe floh aus Graufurt.');
  archive('2026-10-08', Date.UTC(2026, 9, 8, 18), 'Baron Kelthur verriet die Gruppe.');
  archive('2026-10-09-ohne', Date.UTC(2026, 9, 9, 18), null); // finalized without a summary
  const b = lastSessionBlock();
  assert.match(b, /^Zusammenfassung der letzten abgeschlossenen Sitzung \(08\.10\.2026\)/);
  assert.match(b, /nicht ungefragt nacherzählen/);
  assert.match(b, /Baron Kelthur verriet die Gruppe\.$/);
  assert.ok(!b.includes('Graufurt'));
});

test('disabled, capped, and cached for 30 s', () => {
  archive('a', Date.UTC(2026, 9, 1), 'Satz eins. '.repeat(400));
  process.env.LAST_SESSION_CONTEXT_MAX_CHARS = '300';
  const capped = lastSessionBlock({ now: 1_000 });
  assert.ok(capped.split('\n')[1].length <= 300);
  archive('b', Date.UTC(2026, 9, 2), 'Neuere Sitzung.');
  assert.equal(lastSessionBlock({ now: 2_000 }), capped, 'cached');
  assert.match(lastSessionBlock({ now: 40_000 }), /Neuere Sitzung\./, 'cache expired');
  process.env.LAST_SESSION_CONTEXT_ENABLED = 'false';
  assert.equal(lastSessionBlock({ now: 50_000 }), '');
});

// Live test 2026-10-20: "fasse die letzten beiden Sessions zusammen" had only
// the newest summary, RAG added 2025 notes, the answer was about wrong sessions.
test('LAST_SESSION_CONTEXT_COUNT=2: the two newest by session start, newest first, each dated', () => {
  archive('2026-09-24', Date.UTC(2026, 8, 24, 18), 'Die Gruppe erreichte Graufurt.');
  archive('2026-10-08', Date.UTC(2026, 9, 8, 18), 'Baron Kelthur verriet die Gruppe.');
  archive('2026-10-01', Date.UTC(2026, 9, 1, 18), 'Die Gruppe floh aus den Minen.');
  // Re-finalized old session: newer mtime, older start — not "the last".
  archive('2025-06-12', Date.UTC(2025, 5, 12, 18), 'Alte Sitzung aus 2025.');
  archive('2026-10-09-leer', Date.UTC(2026, 9, 9, 18), '  \n'); // empty summary is skipped
  process.env.LAST_SESSION_CONTEXT_COUNT = '2';
  const b = lastSessionBlock();
  assert.equal(b, [
    'Zusammenfassungen der letzten abgeschlossenen Sitzungen, neueste zuerst — nur verwenden, wenn danach gefragt wird; nicht ungefragt nacherzählen:',
    'Letzte Sitzung (08.10.2026):',
    'Baron Kelthur verriet die Gruppe.',
    '',
    'Vorletzte Sitzung (01.10.2026):',
    'Die Gruppe floh aus den Minen.',
  ].join('\n'));

  process.env.LAST_SESSION_CONTEXT_COUNT = '3';
  assert.match(lastSessionBlock(), /Drittletzte Sitzung \(24\.09\.2026\):\nDie Gruppe erreichte Graufurt\.$/, 'a count change bypasses the cache');
  process.env.LAST_SESSION_CONTEXT_COUNT = '1';
  assert.match(lastSessionBlock(), /^Zusammenfassung der letzten abgeschlossenen Sitzung \(08\.10\.2026\) — /, 'count 1 = the single-session block');
});

test('count 2 with only one finalized session → the single-session block', () => {
  archive('2026-10-08', Date.UTC(2026, 9, 8, 18), 'Baron Kelthur verriet die Gruppe.');
  process.env.LAST_SESSION_CONTEXT_COUNT = '2';
  assert.match(lastSessionBlock(), /^Zusammenfassung der letzten abgeschlossenen Sitzung \(08\.10\.2026\)/);
});

test('several sessions share LAST_SESSION_CONTEXT_MAX_CHARS fairly; a short one leaves room for the long one', () => {
  archive('a', Date.UTC(2026, 9, 1, 18), 'Lang eins. '.repeat(300));
  archive('b', Date.UTC(2026, 9, 8, 18), 'Lang zwei. '.repeat(300));
  process.env.LAST_SESSION_CONTEXT_COUNT = '2';
  process.env.LAST_SESSION_CONTEXT_MAX_CHARS = '1000';
  const body = (b) => b.slice(b.indexOf('\n') + 1);
  const two = body(lastSessionBlock());
  assert.ok(two.length <= 1000, `body ${two.length} chars`);
  const [newer, older] = two.split('\n\n').map((p) => p.split('\n')[1]);
  assert.match(newer, /^Lang zwei\./);
  assert.match(older, /^Lang eins\./);
  assert.ok(Math.abs(newer.length - older.length) <= 15, 'equal shares');
  assert.ok(newer.length > 400, 'each gets about half');

  archive('c', Date.UTC(2026, 9, 15, 18), 'Kurz.');
  resetLastSessionCache();
  const [shortOne, longOne] = body(lastSessionBlock()).split('\n\n').map((p) => p.split('\n')[1]);
  assert.equal(shortOne, 'Kurz.');
  assert.ok(longOne.length > 800, `the long one gets the rest (${longOne.length})`);
});

test('fairShares: equal split, unused share goes to the longer texts, never over the total', () => {
  assert.deepEqual(fairShares([1000, 1000], 1000), [500, 500]);
  assert.deepEqual(fairShares([100, 1000], 1000), [100, 900]);
  assert.deepEqual(fairShares([100, 200], 1000), [100, 200]);
  assert.deepEqual(fairShares([1000, 10, 1000], 1001), [495, 10, 496]);
  assert.deepEqual(fairShares([50, 50], -5), [0, 0]);
});

test('LAST_SESSION_CONTEXT_COUNT: invalid → 1, capped at 5', () => {
  for (const [v, want] of [[undefined, 1], ['', 1], ['0', 1], ['abc', 1], ['2', 2], ['2.7', 2], ['9', 5]]) {
    if (v === undefined) delete process.env.LAST_SESSION_CONTEXT_COUNT; else process.env.LAST_SESSION_CONTEXT_COUNT = v;
    assert.equal(lastSessionContextCount(), want, String(v));
  }
});

// "/finalize run, danach /recap" (the documented live test): a lookup during
// the session cached the previous session's summary for 30 s, so a /recap
// right after a short finalize still recapped the session before.
test('a finalize makes its new summary the recap source at once', async () => {
  archive('2026-10-01', Date.UTC(2026, 9, 1, 18), 'Die Gruppe floh aus Graufurt.');
  const now = Date.now();
  assert.match(lastSessionBlock({ now }), /Graufurt/); // cached during the session
  const upload = fs.mkdtempSync(path.join(root, 'up-'));
  fs.writeFileSync(path.join(upload, 'a.wav'), 'AUDIO');
  const startMs = Date.UTC(2026, 9, 8, 18);
  let summaryOpts = null;
  await finalizeSession({
    sessionId: String(startMs), uploadDir: upload, archiveRoot: dir, transcriptRoot: path.join(root, 'tr'),
    manifest: { sessionStartMs: startMs, sessionName: '2026-10-08', utterances: [{ userId: '1', username: 'Anna', file: 'a.wav', startMs: 0, durationMs: 1000 }] },
    transcribeFn: async () => ({ text: 'Wir verlassen Graufurt.', words: null }),
    opts: { timeZone: 'UTC', summarizeFn: async (md, o) => { summaryOpts = o; return 'Baron Kelthur verriet die Gruppe.'; } },
  });
  assert.match(lastSessionBlock({ now: now + 1_000 }), /Baron Kelthur verriet die Gruppe\./);
  assert.equal(summaryOpts.previousSummary, 'Die Gruppe floh aus Graufurt.', 'the summary gets the session before as background');
});
