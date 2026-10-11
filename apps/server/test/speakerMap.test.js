import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadSpeakerMap, setSpeakerMapping, removeSpeakerMapping } from '../src/speakerMap.js';

function withTempMap(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spkmap-'));
  const saved = process.env.SPEAKER_MAP_FILE;
  // Nested path: the store must create missing parent dirs itself.
  process.env.SPEAKER_MAP_FILE = path.join(dir, 'data', 'speaker-map.json');
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.SPEAKER_MAP_FILE; else process.env.SPEAKER_MAP_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('mappings persist on disk in the documented { guild: { user: entry } } shape', () => {
  withTempMap(() => {
    setSpeakerMapping('g1', 111, { player: 'Hauke' }); // numeric ids are stringified
    const onDisk = JSON.parse(fs.readFileSync(process.env.SPEAKER_MAP_FILE, 'utf8'));
    assert.deepEqual(onDisk, { g1: { '111': { player: 'Hauke' } } });
    assert.equal(loadSpeakerMap('g1')['111'].player, 'Hauke');
  });
});

test('a corrupt map file reads as empty; null ids are ignored', () => {
  withTempMap(() => {
    fs.mkdirSync(path.dirname(process.env.SPEAKER_MAP_FILE), { recursive: true });
    fs.writeFileSync(process.env.SPEAKER_MAP_FILE, '{"g1": ');
    assert.deepEqual(loadSpeakerMap('g1'), {});
    assert.equal(setSpeakerMapping(null, '1', { player: 'x' }), undefined);
    assert.equal(setSpeakerMapping('g1', null, { player: 'x' }), undefined);
    assert.equal(fs.readFileSync(process.env.SPEAKER_MAP_FILE, 'utf8'), '{"g1": ', 'ignored calls do not rewrite the file');
  });
});
