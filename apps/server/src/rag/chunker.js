// Markdown → retrieval chunks.
//
// One note is split at every `##` heading: each `##` section (heading line
// included) becomes one chunk, and everything above the first `##` (the `#`
// title + intro) is a chunk of its own so short notes without sections are not
// lost. `###` and deeper stay inside their `##` section. `##` lines inside
// fenced code blocks (``` or ~~~) never split. A section longer than the
// character budget is split further at paragraph, then line, then word
// boundaries; continuation pieces repeat the `## heading` line so they still
// embed with their topic. Chunk IDs are `<source>::<n>` (n = 0.. in note
// order) — unique across the vault and stable while the note is unchanged.
//
// CHUNKER_VERSION is part of every note's content digest (indexer.js): bump it
// whenever the output of chunkMarkdown() changes for the same input, so every
// note is re-embedded once instead of mixing old and new chunk shapes.

import { parseFrontmatter, flattenMeta } from './frontmatter.js';

export const CHUNKER_VERSION = '2';
export const DEFAULT_MAX_CHUNK_CHARS = 2000;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
// Python's str.splitlines() boundaries (the spec's reference implementation),
// so chunk text is identical for notes with exotic line separators.
const LINE_SPLIT_RE = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

// Cut index for a hard split at `limit` that never separates a UTF-16
// surrogate pair (an emoji cut in half would embed as U+FFFD garbage).
function safeCut(line, limit) {
  const c = line.charCodeAt(limit - 1);
  return (c >= 0xd800 && c <= 0xdbff && limit > 1) ? limit - 1 : limit;
}

// Split `text` into pieces of at most `limit` chars. Prefers paragraph
// boundaries, then line boundaries, then the last space before the limit;
// only a single unbroken run longer than `limit` is cut mid-word.
export function splitLong(text, limit) {
  if (text.length <= limit) return [text];
  const units = [];
  for (let para of text.split(/\n[ \t]*\n/)) {
    para = para.replace(/^\n+|\n+$/g, '');
    if (!para.trim()) continue;
    if (para.length <= limit) { units.push(para); continue; }
    for (let line of para.split('\n')) {
      while (line.length > limit) {
        let cut = line.lastIndexOf(' ', limit - 1);
        if (cut <= 0) cut = safeCut(line, limit);
        units.push(line.slice(0, cut));
        line = line.slice(cut).replace(/^ +/, '');
      }
      if (line.trim()) units.push(line);
    }
  }
  // Re-pack the units greedily into pieces (joined by a blank line).
  const pieces = [];
  let cur = '';
  for (const unit of units) {
    if (cur && cur.length + 2 + unit.length > limit) {
      pieces.push(cur);
      cur = unit;
    } else {
      cur = cur ? `${cur}\n\n${unit}` : unit;
    }
  }
  if (cur) pieces.push(cur);
  return pieces;
}

function positiveInt(v, fallback) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// chunkMarkdown(text, source, { maxChars }) →
//   { meta, chunks: [{ id, text, heading }] }
// `meta` is the note's flattened frontmatter (+ the reserved `source` key);
// `heading` is the `##` heading text ('' for the intro chunk).
export function chunkMarkdown(text, source, { maxChars } = {}) {
  const limit = positiveInt(maxChars, DEFAULT_MAX_CHUNK_CHARS);
  const { meta, body } = parseFrontmatter(text);

  const sections = [];
  let heading = '';
  let buf = [];
  let fence = null;
  for (const line of body.split(LINE_SPLIT_RE)) {
    const m = FENCE_RE.exec(line);
    if (m) {
      const marker = m[1][0];
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
    } else if (fence === null && line.startsWith('## ')) {
      sections.push([heading, buf]);
      heading = line.slice(3).trim();
      buf = [line];
      continue;
    }
    buf.push(line);
  }
  sections.push([heading, buf]);

  const chunks = [];
  for (const [head, lines] of sections) {
    const sectionText = lines.join('\n').trim();
    if (!sectionText) continue;
    // Leave room for the repeated heading line on continuation pieces.
    const budget = Math.max(limit - (head ? head.length + 4 : 0), Math.floor(limit / 2), 1);
    splitLong(sectionText, budget).forEach((part, i) => {
      chunks.push({
        id: `${source}::${chunks.length}`,
        text: i > 0 && head ? `## ${head}\n${part}` : part,
        heading: head,
      });
    });
  }
  return { meta: flattenMeta(meta, source), chunks };
}
