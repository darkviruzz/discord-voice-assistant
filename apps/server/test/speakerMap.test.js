import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadSpeakerMap, setSpeakerMapping, removeSpeakerMapping } from '../src/speakerMap.js';

function withTempMap(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spkmap-'));
  process.env.SPEAKER_MAP_FILE = path.join(dir, 'speaker-map.json');
  try { return fn(); } finally { delete process.env.SPEAKER_MAP_FILE; }
}

test('set / load / merge / remove speaker mappings per guild', () => {
  withTempMap(() => {
    assert.deepEqual(loadSpeakerMap('g1'), {});
    assert.deepEqual(loadSpeakerMap(null), {});

    setSpeakerMapping('g1', '111', { player: 'Hauke', character: 'Thrain' });
    setSpeakerMapping('g1', '222', { player: 'Greta' });
    setSpeakerMapping('g2', '111', { player: 'AndererServer' });

    const g1 = loadSpeakerMap('g1');
    assert.equal(g1['111'].player, 'Hauke');
    assert.equal(g1['111'].character, 'Thrain');
    assert.equal(g1['222'].player, 'Greta');
    assert.equal(Object.keys(g1).length, 2, 'guilds are isolated');

    // Partial upsert merges, does not replace.
    setSpeakerMapping('g1', '111', { phonetic: 'Hauke' });
    const merged = loadSpeakerMap('g1')['111'];
    assert.deepEqual(merged, { player: 'Hauke', character: 'Thrain', phonetic: 'Hauke' });

    assert.equal(removeSpeakerMapping('g1', '222'), true);
    assert.equal(loadSpeakerMap('g1')['222'], undefined);
    assert.equal(removeSpeakerMapping('g1', 'nope'), false);
  });
});

test('mappings persist across reloads (separate file reads)', () => {
  withTempMap(() => {
    setSpeakerMapping('g1', '111', { player: 'Hauke' });
    // loadSpeakerMap re-reads the file each call → simulates a fresh process.
    assert.equal(loadSpeakerMap('g1')['111'].player, 'Hauke');
  });
});
