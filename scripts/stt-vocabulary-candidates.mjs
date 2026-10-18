#!/usr/bin/env node
// STT vocabulary candidates from the Obsidian vault — a list to REVIEW, then
// save as STT_VOCABULARY_FILE (or paste into STT_VOCABULARY).
//
// Reads titles and frontmatter aliases of character, companion, NPC, place and
// faction notes (by frontmatter `type`, else folder name: Characters,
// Sidekicks, NPCs, Locations, Factions, …) and ranks them by how many of the
// most recent session notes (folders named *Session*) mention them. Names with
// recent mentions are active lines while they fit the 250-char prompt budget;
// everything else is a commented-out line.
//
// Usage:
//   npm run vocab:stt -- [options]
//   node scripts/stt-vocabulary-candidates.mjs [options]
// Options:
//   --vault <dir>    vault root (default: OBSIDIAN_VAULT_PATH from the
//                    environment or apps/server/.env)
//   --recent <n>     how many recent session notes count (default: 10)
//   --out <file>     write the list there instead of stdout (refuses to
//                    overwrite an existing file unless --force)
//   --force          overwrite --out
//
// Nothing is written into the vault or the server config unless --out points
// there.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { listNotes } from '../apps/server/src/rag/scanner.js';
import { collectCandidates, renderCandidates } from './lib/vocabCandidates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const a = { vault: null, recent: 10, out: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--vault') a.vault = argv[++i];
    else if (k === '--recent') a.recent = Number(argv[++i]);
    else if (k === '--out') a.out = path.resolve(argv[++i]);
    else if (k === '--force') a.force = true;
    else if (k === '-h' || k === '--help') a.help = true;
    else throw new Error(`unknown argument: ${k}`);
  }
  if (!Number.isInteger(a.recent) || a.recent < 1) throw new Error('--recent expects a positive integer');
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
      .filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    return;
  }
  dotenv.config({ path: path.join(ROOT, 'apps', 'server', '.env'), quiet: true });
  const vault = args.vault || (process.env.OBSIDIAN_VAULT_PATH ?? '').trim();
  if (!vault) throw new Error('no vault: pass --vault <dir> or set OBSIDIAN_VAULT_PATH (apps/server/.env)');
  if (!fs.existsSync(vault)) throw new Error(`vault not found: ${vault}`);

  const files = await listNotes(vault, { onSkip: (dir, e) => console.error(`! skipped ${dir}: ${e.message}`) });
  const notes = files.map((f) => ({ source: f.source, text: fs.readFileSync(f.full, 'utf8') }));
  const { entries, recent } = collectCandidates(notes, { recent: args.recent });
  const { text, active } = renderCandidates(entries, { vault, recent });

  if (args.out) {
    if (fs.existsSync(args.out) && !args.force) throw new Error(`${args.out} exists — pass --force to overwrite`);
    fs.writeFileSync(args.out, text);
    console.error(`${entries.length} candidates, ${active.length} active → ${args.out}`);
  } else {
    process.stdout.write(text);
    console.error(`${entries.length} candidates, ${active.length} active (${notes.length} notes, ${recent} session notes)`);
  }
}

main().catch((e) => { console.error(`stt-vocabulary-candidates: ${e.message}`); process.exit(1); });
