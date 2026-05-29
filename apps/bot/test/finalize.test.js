import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { buildManifest, applyRetention, chunksDir, sourceChunksDir } from '../src/finalize.js';

function makeSession() {
  // Mirror production layout: <DATA_DIR>/<id>/chunks so _archived lands under
  // the per-test root, not the shared tmp dir.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-finalize-'));
  const startedAt = 1_700_000_000_000;
  const id = '2023-11-14T22-13-20-000Z';
  const dir = path.join(root, id);
  const chunks = path.join(dir, 'chunks');
  fs.mkdirSync(chunks, { recursive: true });
  const fileA = path.join(chunks, `111_${startedAt}.wav`);
  const fileB = path.join(chunks, `222_${startedAt + 3000}.wav`);
  fs.writeFileSync(fileA, Buffer.from('AUDIO-A'));
  fs.writeFileSync(fileB, Buffer.from('AUDIO-B'));
  return {
    id,
    dir,
    startedAt,
    status: 'open',
    timeline: [
      { userId: '111', username: 'Hauke', startMs: 0, durationMs: 2000, file: fileA },
      { userId: '222', username: 'Greta', startMs: 3000, durationMs: 1000, file: fileB },
    ],
  };
}

test('buildManifest produces basenames, checksums and bot-clock timing', () => {
  const session = makeSession();
  const m = buildManifest(session, { channelName: 'Spieltisch', wakeWord: 'Rabenauge' });
  assert.equal(m.sessionId, '1700000000000');
  assert.equal(m.sessionStartMs, session.startedAt);
  assert.equal(m.channelName, 'Spieltisch');
  assert.equal(m.utterances.length, 2);

  const a = m.utterances[0];
  assert.equal(a.file, `111_${session.startedAt}.wav`); // basename only
  assert.equal(a.startMs, 0);
  const expected = crypto.createHash('sha256').update(Buffer.from('AUDIO-A')).digest('hex');
  assert.equal(a.sha256, expected);
});

test('applyRetention move relocates WAVs out of the session dir', () => {
  const session = makeSession();
  const res = applyRetention(session, { policy: 'move' });
  assert.ok(res.done);
  assert.equal(fs.existsSync(chunksDir(session)), false);
  const moved = path.join(path.dirname(session.dir), '_archived', session.id, 'chunks');
  assert.ok(fs.existsSync(moved));
});

test('applyRetention delete removes WAVs', () => {
  const session = makeSession();
  const res = applyRetention(session, { policy: 'delete' });
  assert.equal(res.policy, 'delete');
  assert.equal(fs.existsSync(chunksDir(session)), false);
});

test('re-finalize resolves WAVs from _archived after a retention move', () => {
  const session = makeSession();
  applyRetention(session, { policy: 'move' });
  assert.equal(fs.existsSync(chunksDir(session)), false, 'live chunks moved away');
  assert.ok(sourceChunksDir(session).includes('_archived'), 'source resolves to archive');
  const m = buildManifest(session, {});
  assert.equal(m.utterances.length, 2, 'manifest rebuilt from archived WAVs');
});
