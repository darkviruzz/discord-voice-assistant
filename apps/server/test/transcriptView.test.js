import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sessions, ensureSession, dropSession } from '../src/state.js';
import { buildSnapshot, buildVoice, listSessions, listSessionsOnDisk, newestActiveSessionId } from '../src/transcriptView.js';
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

test('buildSnapshot attaches STT diagnostics (incl. no_speech_prob) to user spans', () => {
  const snap = buildSnapshot(SID);
  assert.equal(snap.entries[0].stt.noSpeechProb, 0.05);
  assert.equal(snap.entries[1].stt.noSpeechProb, 0.02);
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

test('listSessions / newestActiveSessionId reflect the RAM map (newest by createdAt)', (t) => {
  t.after(() => { dropSession('100'); dropSession('200'); });
  // Pin createdAt explicitly — both would otherwise share the same ms.
  ensureSession('200').createdAt = 1000;
  ensureSession('100').createdAt = 2000; // started later despite the smaller id
  const s100 = ensureSession('100');
  s100.guildName = 'Greyhawk';
  s100.liveContext.buffer.push({ label: 'A', text: 'x', startMs: 1, kind: 'user' });
  const list = listSessions();
  const byId = Object.fromEntries(list.map((x) => [x.sessionId, x]));
  assert.deepEqual(Object.keys(byId).sort(), ['100', '200']);
  assert.equal(byId['100'].guildName, 'Greyhawk');
  assert.equal(byId['100'].bufferEntries, 1);
  assert.equal(byId['100'].active, true);
  assert.equal(newestActiveSessionId(), '100');
  dropSession('100');
  assert.equal(newestActiveSessionId(), '200');
  dropSession('200');
  assert.equal(newestActiveSessionId(), null);
});

test('buildSnapshot flags wake/stop and surfaces session_meta + TTS turn debug', () => {
  writeFileSync(join(dir, `session_${SID}.jsonl`), [
    JSON.stringify({ tsMs: 900, type: 'session_meta', sessionId: SID, guildName: 'Greyhawk', channelName: 'Tavern', wakeword: { word: 'Rabenauge' }, stopPhrases: ['stop'] }),
    JSON.stringify({ tsMs: 1000, type: 'user_transcript', sessionId: SID, userId: '222', userDisplayName: 'Nogâr', startTsMs: 1000, durationMs: 1000, text: 'Hey Rabenauge, wer ist Kelthur?', chunks: ['x'], stt: { noSpeechProbAvg: 0.05 } }),
    JSON.stringify({ tsMs: 1100, type: 'wakeword_query', sessionId: SID, userId: '222', query: 'wer ist Kelthur?' }),
    JSON.stringify({ tsMs: 1500, type: 'assistant_response', sessionId: SID, turnId: 't1', userId: '222', text: 'Kelthur war ein Söldner.', speakerId: 0, model: 'emotional' }),
    JSON.stringify({ tsMs: 1550, type: 'tts_start', sessionId: SID, id: 'a1', turnId: 't1', model: 'emotional', speakerId: 0 }),
    JSON.stringify({ tsMs: 3000, type: 'tts_done', sessionId: SID, id: 'a1', turnId: 't1', durationMs: 1800 }),
    JSON.stringify({ tsMs: 4000, type: 'user_transcript', sessionId: SID, userId: '111', userDisplayName: 'Greta', startTsMs: 4000, durationMs: 500, text: 'Stop', chunks: ['Stop'], stt: { noSpeechProbAvg: 0.4 } }),
    JSON.stringify({ tsMs: 4100, type: 'stop_command', sessionId: SID, userId: '111', text: 'Stop' }),
  ].join('\n') + '\n');

  const snap = buildSnapshot(SID);
  const wake = snap.entries.find((e) => e.text.startsWith('Hey Rabenauge'));
  const stop = snap.entries.find((e) => e.text === 'Stop');
  const reply = snap.entries.find((e) => e.kind === 'assistant');

  assert.equal(wake.wakeDetected, true);
  assert.equal(wake.stt.noSpeechProb, 0.05); // stt diagnostics attached
  assert.equal(stop.stopDetected, true);
  assert.equal(reply.turn.ttsStatus, 'done');
  assert.equal(reply.turn.ttsModel, 'emotional');
  assert.equal(reply.turn.ttsDurationMs, 1800);
  assert.equal(snap.sessionMeta.wakeword.word, 'Rabenauge');
  assert.equal(snap.startedAt, Number(SID));
});

test('listSessionsOnDisk lists past sessions from the log dir, newest first', () => {
  const other = '1778100000000';
  writeFileSync(join(dir, `session_${SID}.jsonl`), '{"type":"user_transcript","tsMs":1,"sessionId":"' + SID + '","userId":"1","text":"hi","startTsMs":1}\n');
  writeFileSync(join(dir, `session_${other}.jsonl`), '{"type":"user_transcript","tsMs":1,"sessionId":"' + other + '","userId":"1","text":"alt","startTsMs":1}\n');
  const list = listSessionsOnDisk();
  const ids = list.map((s) => s.sessionId);
  assert.ok(ids.includes(SID) && ids.includes(other));
  assert.equal(list[0].sessionId, SID, 'newest (larger epoch id) first');
  assert.equal(list.find((s) => s.sessionId === SID).startedAt, Number(SID));
});

test('buildVoice reports live presence from the in-RAM session', () => {
  const s = ensureSession(SID);
  s.voice.state = 'occupied';
  s.voice.members.set('111', 'Greta');
  s.voice.members.set('222', 'Nogâr');
  const v = buildVoice(SID);
  assert.equal(v.connected, true);
  assert.equal(v.populated, true);
  assert.equal(v.members.length, 2);
  assert.ok(v.members.some((m) => m.label === 'Greta'));
});

test('buildVoice reports "alone" as connected-but-not-populated', () => {
  const s = ensureSession(SID);
  s.voice.state = 'alone';
  const v = buildVoice(SID);
  assert.equal(v.connected, true);
  assert.equal(v.populated, false);
});

test('buildVoice falls back to JSONL for an ended session (not connected)', () => {
  // No RAM session: replay voice events from a log.
  writeFileSync(join(dir, `session_${SID}.jsonl`), [
    JSON.stringify({ type: 'voice_state', tsMs: 1, sessionId: SID, state: 'joined' }),
    JSON.stringify({ type: 'voice_member', tsMs: 2, sessionId: SID, userId: '111', displayName: 'Greta', state: 'join' }),
    JSON.stringify({ type: 'voice_member', tsMs: 3, sessionId: SID, userId: '222', displayName: 'Nogâr', state: 'join' }),
    JSON.stringify({ type: 'voice_member', tsMs: 4, sessionId: SID, userId: '111', displayName: 'Greta', state: 'leave' }),
  ].join('\n') + '\n');
  const v = buildVoice(SID);
  assert.equal(v.connected, false, 'ended session: bot not currently connected');
  assert.equal(v.members.length, 1, 'Greta left, only Nogâr remains');
  assert.equal(v.members[0].label, 'Nogâr');
});

test('buildSnapshot includes the voice block (ended session without voice events → empty)', () => {
  const snap = buildSnapshot(SID);
  assert.equal(snap.voice.connected, false);
  assert.equal(snap.voice.populated, false);
  assert.deepEqual(snap.voice.members, []);
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
