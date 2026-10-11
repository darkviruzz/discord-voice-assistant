// YAML frontmatter of an Obsidian note.
//
// A note may open with a `--- … ---` (or `--- … ...`) YAML block. It is split
// off the body so it is never embedded as prose, and its fields are kept as
// note metadata. Anything that is NOT a YAML mapping — invalid YAML, a list, a
// plain scalar, or a note that merely opens with a `---` horizontal rule
// followed by prose — is NOT frontmatter: the text is returned unchanged so no
// note content is ever dropped.
//
// Parsing uses the pure-JS `yaml` package (YAML 1.2 core schema, no native
// code) instead of a hand-written subset parser: real-world frontmatter has
// block scalars (`desc: |`), quoted values containing `: `, flow and block
// lists, comments and anchors, and a subset parser that mis-reads any of them
// would either leak YAML into the embedded text or swallow prose. The library
// also caps alias expansion (billion-laughs) and reports multi-document input
// (`--- not a close` inside the block) as an error, which is exactly the
// "not frontmatter" signal the spec needs.

import YAML from 'yaml';

// Opening `---` line, YAML, closing `---` (or `...`) line — each delimiter must
// be a line of its own, so `----` or a `--- text` line never counts. `m` makes
// `^` match at line starts (closing delimiter); the opening one is pinned to
// offset 0 by the index check in parseFrontmatter. `$(?![\s\S])` = end of input.
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?^(?:---|\.\.\.)[ \t]*(?:\r?\n|$(?![\s\S]))/m;

const YAML_OPTS = {
  schema: 'core',      // YAML 1.2: dates stay strings, `yes` stays a string
  uniqueKeys: false,   // duplicate keys: last one wins (PyYAML behaviour), not an error
  logLevel: 'error',   // warnings (e.g. stringified collection keys) stay silent
};

// parseFrontmatter(text) → { meta: object, body: string }
// A leading UTF-8 BOM is dropped first — it would otherwise hide the opening
// `---` and leak the whole YAML block into the first chunk.
export function parseFrontmatter(text) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const m = FRONTMATTER_RE.exec(s);
  if (!m || m.index !== 0) return { meta: {}, body: s };
  const raw = m[1];
  let meta = {};
  if (raw.trim()) {
    let value;
    try {
      const doc = YAML.parseDocument(raw, YAML_OPTS);
      if (doc.errors.length > 0) return { meta: {}, body: s };
      value = doc.toJS({ maxAliasCount: 100 });
    } catch {
      return { meta: {}, body: s }; // e.g. excessive alias expansion
    }
    if (value === null || value === undefined) value = {}; // comments only
    if (typeof value !== 'object' || Array.isArray(value)) return { meta: {}, body: s };
    meta = value;
  }
  return { meta, body: s.slice(m[0].length).replace(/^[\r\n]+/, '') };
}

function scalarString(v) {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'nan';
    if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  }
  if (v instanceof Date) return isoDate(v);
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function isoDate(d) {
  if (Number.isNaN(d.getTime())) return 'Invalid Date';
  const iso = d.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
}

// Flatten parsed frontmatter into JSON-safe scalars for the index: lists are
// joined with ", ", nested mappings become JSON text, null is dropped, NaN/±∞
// (which JSON can't carry) are stringified, empty keys are skipped.
//
// `source` is set LAST: it is the note's vault-relative path, the key every
// update/delete/prune is matched on, so a frontmatter field that happens to be
// called `source:` (web clippings use it for the URL) must never shadow it.
export function flattenMeta(meta, source) {
  const out = {};
  for (const [rawKey, value] of Object.entries(meta ?? {})) {
    const key = String(rawKey);
    if (!key || value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : scalarString(value);
    else if (typeof value === 'bigint') out[key] = value.toString();
    else if (Array.isArray(value)) out[key] = value.map(scalarString).join(', ');
    else out[key] = scalarString(value);
  }
  out.source = source;
  return out;
}
