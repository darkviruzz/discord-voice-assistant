import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sessions, ensureSession, dropSession } from '../src/state.js';
import { buildSnapshot, listSessions, newestActiveSessionId } from '../src/transcriptView.js';
import { publishEntry, subscribeEntries } from '../src/liveBus.js';

const SID = '1778422813219';
let dir;

function userEvent(userId, name, startTsMs, text, noSpeechProb) {
  return JSON.stringify({
    schemaVersion: 2, tsMs: startTsMs, type: 'user_transcript', sessionId: SID,
    userId, userDisplayName: name, startTsMs, endTsMs: startTsMs + 1000,
    durationMs: 1000, text, chunks: [text],
    stt: { provider: 'whisper.cpp', noSpeechProbAvg: noSpeechProb, noSpeechProbMax: noSpeechProb },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcript-test-'));
  process.env.TRANSCRIPT_DIR = dir;
  writeFileSync(join(dir, `session_${SID}.jsonl`), [
    userEvent('111', 'Greta', 2000, 'Hallo zusammen', 0.02),
    userEvent('222', 'Nogâr', 1000, 'Wer ist Baron Kelthur?', 0.05),
  ].join('\n') + '\n');
});

afterEach(() => {
  dropSession(SID);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TRANSCRIPT_DIR;
});

test('buildSnapshot returns entries sorted by startMs from the JSONL', () => {
  const snap = buildSnapshot(SID);
  assert.equal(snap.sessionId, SID);
  assert.equal(snap.entries.length, 2);
  // Nogâr (1000) before Greta (2000) despite reverse file order.
  assert.equal(snap.entries[0].text, 'Wer ist Baron Kelthur?');
  assert.equal(snap.entries[1].text, 'Hallo zusammen');
  assert.equal(snap.entries[0].kind, 'user');
});

test('buildSnapshot attaches no_speech_prob as debug meta for user spans', () => {
  const snap = buildSnapshot(SID);
  assert.equal(snap.entries[0].meta.noSpeechProb, 0.05);
  assert.equal(snap.entries[1].meta.noSpeechProb, 0.02);
});

test('buildSnapshot surfaces the rolling summary from the in-RAM session', () => {
  const s = ensureSession(SID);
  s.liveContext.summary = 'Die Gruppe steht vor dem Tor.';
  const snap = buildSnapshot(SID);
  assert.equal(snap.summary, 'Die Gruppe steht vor dem Tor.');
  assert.equal(snap.active, true);
});

test('buildSnapshot works for an ended session (JSONL only, no RAM)', () => {
  const snap = buildSnapshot(SID);
  assert.equal(snap.active, false);
  assert.equal(snap.summary, '');
  assert.equal(snap.entries.length, 2);
});

test('listSessions / newestActiveSessionId reflect the RAM map', () => {
  ensureSession('100');
  ensureSession('200');
  const list = listSessions();
  assert.ok(list.length >= 2);
  // newest by createdAt is last ensured; both share ~now, so just assert membership.
  const ids = list.map((x) => x.sessionId);
  assert.ok(ids.includes('100') && ids.includes('200'));
  assert.ok(['100', '200'].includes(newestActiveSessionId()));
  dropSession('100'); dropSession('200');
});

test('liveBus publishes to subscribers filtered by sessionId string', () => {
  const seen = [];
  const unsub = subscribeEntries((msg) => seen.push(msg));
  publishEntry(BigInt(SID), { label: 'Greta', text: 'hi', startMs: 5, kind: 'user' }, { noSpeechProb: 0.1 });
  publishEntry(null, { label: 'x', text: 'y', startMs: 6, kind: 'user' }); // ignored: no sid
  unsub();
  publishEntry(BigInt(SID), { label: 'Greta', text: 'after-unsub', startMs: 7, kind: 'user' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, SID);
  assert.equal(seen[0].meta.noSpeechProb, 0.1);
});
