import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lastSessionBlock, resetLastSessionCache } from '../src/lastSession.js';

const KEYS = ['ARCHIVE_DIR', 'LAST_SESSION_CONTEXT_ENABLED', 'LAST_SESSION_CONTEXT_MAX_CHARS', 'FINALIZE_TZ'];
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
