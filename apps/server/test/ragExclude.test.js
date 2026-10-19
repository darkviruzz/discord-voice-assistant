// RAG_EXCLUDE: pattern syntax (scanner.js) and its effect on the indexer.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseExcludeList, compileExclude } from '../src/rag/scanner.js';
import { RagIndexer } from '../src/rag/indexer.js';
import { makeTmpDir, writeNote, makeFakeEmbed, SILENT_LOGGER } from '../test-support/rag.js';

test('parseExcludeList: comma, semicolon, newline; comments, backslashes, leading ./', () => {
  assert.deepEqual(
    parseExcludeList('Templates/, wiki-comments/;CLAUDE.md\n# nur Kommentar\n.\\99_Material\\Archiv\\ # alt\n  '),
    ['Templates/', 'wiki-comments/', 'CLAUDE.md', '99_Material/Archiv/'],
  );
  assert.deepEqual(parseExcludeList(''), []);
  assert.deepEqual(parseExcludeList(undefined), []);
});

test('compileExclude: folder, anchored folder, file name, globs, case-insensitive', () => {
  const ex = compileExclude(parseExcludeList(
    'Templates/, 99_Material/Archiv/, CLAUDE.md, *.excalidraw.md, Claude outputs/, notes/**/draft-?.md',
  ));
  // bare folder name: any depth, incl. the folder path itself (watcher events)
  assert.equal(ex('Templates/_Template_NPC.md'), true);
  assert.equal(ex('Templates'), true);
  assert.equal(ex('10_Campaign/Templates/x.md'), true);
  assert.equal(ex('TemplatesOld/x.md'), false);
  // anchored folder: only from the vault root
  assert.equal(ex('99_Material/Archiv/03_alle NPCs pro Session.md'), true);
  assert.equal(ex('x/99_Material/Archiv/a.md'), false);
  assert.equal(ex('99_Material/other.md'), false);
  // file name anywhere, case-insensitive
  assert.equal(ex('CLAUDE.md'), true);
  assert.equal(ex('sub/claude.md'), true);
  assert.equal(ex('CLAUDE.md.bak.md'), false);
  // globs
  assert.equal(ex('Maps/Stadt.excalidraw.md'), true);
  assert.equal(ex('Maps/Stadt.md'), false);
  assert.equal(ex('Claude outputs/foundry-bastion/README.md'), true);
  assert.equal(ex('notes/a/b/draft-1.md'), true);
  assert.equal(ex('notes/draft-1.md'), true);
  assert.equal(ex('notes/a/draft-12.md'), false);
  // campaign notes stay in
  assert.equal(ex('10_Campaign/Chronicles/Session 11.md'), false);
});

test('compileExclude: no patterns → nothing excluded', () => {
  const ex = compileExclude([]);
  assert.equal(ex('Templates/x.md'), false);
});

// ── indexer ──────────────────────────────────────────────────────────────────

const NOTE = '# Notiz\n\n## Abschnitt\nDer rote Drache bewacht seinen Hort im Feuerberg.\n';

let tmp;
const indexers = [];
afterEach(async () => {
  while (indexers.length) await indexers.pop().stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function setup(exclude) {
  tmp = makeTmpDir('rag-excl-');
  const vault = path.join(tmp, 'vault');
  fs.mkdirSync(vault);
  writeNote(vault, 'NPCs/Lareth.md', NOTE);
  writeNote(vault, 'Templates/_Template_NPC.md', NOTE);
  writeNote(vault, 'CLAUDE.md', NOTE);
  const make = (ex) => {
    const idx = new RagIndexer({
      vaultPath: vault, indexDir: path.join(tmp, 'index'), embed: makeFakeEmbed(),
      signature: 'sig', logger: SILENT_LOGGER, watch: false, rescanIntervalMs: 0, saveDelayMs: 10,
      exclude: ex,
    });
    indexers.push(idx);
    return idx;
  };
  return { vault, make, idx: make(exclude) };
}

const sources = (idx) => [...idx.store.sources()].sort();

test('excluded notes are not indexed', async () => {
  const { idx } = setup(['Templates/', 'CLAUDE.md']);
  const res = await idx.sync();
  assert.equal(res.files, 1);
  assert.deepEqual(sources(idx), ['NPCs/Lareth.md']);
});

test('notes indexed before an exclusion are pruned on the next sync', async () => {
  const { make, idx } = setup([]);
  await idx.sync();
  assert.deepEqual(sources(idx), ['CLAUDE.md', 'NPCs/Lareth.md', 'Templates/_Template_NPC.md']);
  await idx.stop();
  const again = make(['templates/', 'claude.md']); // case-insensitive
  const res = await again.sync();
  assert.equal(res.pruned, 2);
  assert.deepEqual(sources(again), ['NPCs/Lareth.md']);
});

test('syncNote (watcher path) ignores and removes excluded notes', async () => {
  const { make, idx } = setup([]);
  await idx.sync();
  await idx.stop();
  const again = make(['Templates/']);
  await again.start();
  assert.equal(await again.syncNote('Templates/_Template_NPC.md'), 0);
  assert.equal(sources(again).includes('Templates/_Template_NPC.md'), false);
});
