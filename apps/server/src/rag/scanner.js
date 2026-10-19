// Vault scanning: which files are notes, and how a note is read.
//
// A note's identity is its vault-relative path with forward slashes
// ("npc/graf.md") on every OS — that string is the key of the index, so a
// vault synced between Windows and Linux maps to the same entries.

import fs from 'node:fs';
import path from 'node:path';

// Notes larger than this are not indexed (logged): a multi-MB export dumped
// into the vault would otherwise cost hundreds of embedding calls per edit.
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

// True for paths inside dot-directories (.obsidian, .trash, .git, …) or dot
// files, and for anything that escapes the vault ("../x.md"). Notes moved to
// Obsidian's .trash must not resurface as RAG context.
export function isHidden(source) {
  return String(source).split('/').some((part) => part.startsWith('.'));
}

// RAG_EXCLUDE: vault paths that are never indexed (templates, tooling notes,
// exports …). A gitignore-like subset, matched case-insensitively against the
// vault-relative path with forward slashes:
//   "Templates/"        folder (trailing /) — without another / at any depth
//   "Claude outputs/"   folder names may contain spaces
//   "99_Material/Archiv/" a / inside anchors the pattern at the vault root
//   "CLAUDE.md"         file name at any depth
//   "*.excalidraw.md"   * = any characters except /, ? = one, ** = any incl. /
// Entries are separated by comma, semicolon or newline; "#" starts a comment.
export function parseExcludeList(text) {
  return String(text ?? '')
    .split(/[\r\n,;]+/)
    .map((s) => s.replace(/#.*/, '').trim().replace(/\\/g, '/').replace(/^\.?\//, ''))
    .filter(Boolean);
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

// patterns → (source) => true when the note (or folder) is excluded. A folder
// pattern also matches the folder path itself, so watcher events for the
// directory are dropped too.
export function compileExclude(patterns = []) {
  const res = [];
  for (const raw of patterns) {
    let p = String(raw).trim();
    if (!p) continue;
    p = p.replace(/\/+$/, '');
    if (!p) continue;
    // A / inside anchors at the vault root; a bare name matches at any depth.
    // Everything below a matched folder is excluded as well.
    const head = p.includes('/') ? '^' : '^(?:.*/)?';
    res.push(new RegExp(`${head}${globToRegex(p)}(?:/.*)?$`, 'i'));
  }
  if (!res.length) return () => false;
  return (source) => res.some((re) => re.test(String(source)));
}

export function isNoteName(name) {
  return name.toLowerCase().endsWith('.md') && !name.startsWith('.');
}

export function toSource(root, full) {
  return path.relative(root, full).split(path.sep).join('/');
}

// Every note under `root` as [{ full, source }], sorted by source. Dot-
// directories are not descended into; symlinked directories are not followed
// (cycles), symlinked files are included. An unreadable subdirectory is
// skipped (onSkip) instead of failing the scan; an unreadable ROOT throws —
// that is "vault unavailable", not "vault empty" (which would prune the index).
export async function listNotes(root, { onSkip } = {}) {
  const out = [];
  async function walk(dir, isRoot) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (isRoot) throw e;
      onSkip?.(dir, e);
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { await walk(full, false); continue; }
      let isFile = ent.isFile();
      if (!isFile && ent.isSymbolicLink()) {
        try { isFile = (await fs.promises.stat(full)).isFile(); } catch { isFile = false; }
      }
      if (isFile && isNoteName(ent.name)) out.push({ full, source: toSource(root, full) });
    }
  }
  await walk(root, true);
  out.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  return out;
}

// Read a note as text.
//   string — the content (BOM stripped; invalid UTF-8 bytes, e.g. a cp1252
//            note, become U+FFFD instead of aborting the scan)
//   ''     — larger than maxBytes: treated as empty, so its chunks are dropped
//            rather than left stale
//   null   — could not be read right now (locked by a sync client, EACCES, …):
//            the caller keeps the note's previous chunks
export async function readNote(full, { maxBytes = MAX_FILE_BYTES, onWarn } = {}) {
  try {
    const st = await fs.promises.stat(full);
    if (st.size > maxBytes) {
      onWarn?.(`skipping ${full}: larger than ${maxBytes} bytes`);
      return '';
    }
    let text = (await fs.promises.readFile(full)).toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  } catch (e) {
    onWarn?.(`cannot read ${full}: ${e.code || e.message}`);
    return null;
  }
}

// Size + mtime of a note (the quick-rescan fingerprint), null when it can't
// be stat'ed.
export async function statNote(full) {
  try {
    const st = await fs.promises.stat(full);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

// Current on-disk state of one note path:
//   'file'    — a regular file (or a symlink to one)
//   'missing' — gone, or no longer a file (e.g. a directory now has the name)
//   'error'   — stat failed for another reason (EBUSY/EPERM while a sync
//               client holds it): unknown, so the caller changes nothing
export async function noteState(full) {
  try {
    return (await fs.promises.stat(full)).isFile() ? 'file' : 'missing';
  } catch (e) {
    return (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? 'missing' : 'error';
  }
}
