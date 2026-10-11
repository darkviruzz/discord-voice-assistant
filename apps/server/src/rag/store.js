// In-memory vector store + its on-disk persistence.
//
// Vaults are hundreds to a few thousand chunks, so there is no ANN index: every
// chunk vector is L2-normalised once at insert and kept as a flat Float32Array;
// a query is one dot product per chunk (cosine similarity of unit vectors) and
// a bounded top-k insertion. ~3000 chunks × 768 dims is ~2.3 M multiply-adds —
// ~7 ms on a desktop CPU (~1 ms for 500 chunks), well below the embedding
// round-trip of the query itself.
//
// Distances are cosine distances like Chroma's `hnsw:space=cosine`:
// 1 − cos(a, b), 0 = identical .. 2 = opposite (rounded to 4 decimals).
//
// Records are per note: { hash, meta, chunks: [{ text, heading, vec }] }. A
// note is always replaced as a whole (setNote) — synchronous, so a query never
// sees half of an update.
//
// ── Persistence (RAG_INDEX_DIR/index.bin) ───────────────────────────────────
//   bytes 0..7    magic "VARAGIX\n"
//   bytes 8..11   uint32 LE  format version (FORMAT_VERSION)
//   bytes 12..15  uint32 LE  header length H
//   bytes 16..    H bytes UTF-8 JSON header:
//                 { signature, dim, chunks, endian, savedAt,
//                   notes: [{ source, hash, meta, chunks: [{ heading, text }] }] }
//   zero padding to a 4-byte boundary
//   chunks × dim float32 (platform byte order, recorded in `endian`), in
//   header order (notes, then their chunks).
// One file, written to a temp name and renamed over the old one, so a crash
// mid-save leaves the previous index intact. A file whose magic, version,
// endianness, size or embedding signature doesn't match is discarded (the
// next sync rebuilds) — never an error that stops the server.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FORMAT_VERSION = 1;
const MAGIC = Buffer.from('VARAGIX\n', 'latin1');
export const INDEX_FILE = 'index.bin';

export function normalize(vec) {
  const out = Float32Array.from(vec);
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
  const norm = Math.sqrt(sum);
  if (norm > 0 && Number.isFinite(norm)) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

// Four independent accumulators: lets V8 overlap the multiply-adds (~2× over
// the naive loop on 768-dim vectors).
function dot(a, b) {
  const n = a.length;
  let s0 = 0; let s1 = 0; let s2 = 0; let s3 = 0;
  let i = 0;
  for (; i + 3 < n; i += 4) {
    s0 += a[i] * b[i];
    s1 += a[i + 1] * b[i + 1];
    s2 += a[i + 2] * b[i + 2];
    s3 += a[i + 3] * b[i + 3];
  }
  for (; i < n; i++) s0 += a[i] * b[i];
  return (s0 + s1) + (s2 + s3);
}

export class VectorStore {
  constructor(signature = null) {
    this.signature = signature;
    this.dim = 0;
    this.notes = new Map(); // source → { hash, meta, chunks: [{ text, heading, vec }] }
    this.chunkCount = 0;
  }

  reset(signature) {
    this.signature = signature;
    this.dim = 0;
    this.notes.clear();
    this.chunkCount = 0;
  }

  get noteCount() { return this.notes.size; }
  getNote(source) { return this.notes.get(source); }
  sources() { return [...this.notes.keys()]; }

  // Replace a note's chunks. `vectors[i]` belongs to `chunks[i]`. Throws on a
  // dimension mismatch with the vectors already stored (a different embedding
  // space — the caller resets the store and re-embeds).
  setNote(source, { hash, meta = {}, chunks = [], vectors = [] }) {
    if (chunks.length !== vectors.length) throw new Error(`setNote(${source}): ${chunks.length} chunks, ${vectors.length} vectors`);
    const stored = chunks.map((c, i) => ({ text: c.text, heading: c.heading ?? '', vec: normalize(vectors[i]) }));
    const dims = new Set(stored.map((c) => c.vec.length));
    if (dims.size > 1) throw new DimensionMismatch(`mixed vector dimensions ${[...dims].join('/')}`);
    const dim = stored.length ? stored[0].vec.length : 0;
    const others = this.chunkCount - (this.notes.get(source)?.chunks.length ?? 0);
    if (dim && others > 0 && dim !== this.dim) {
      throw new DimensionMismatch(`vector dimension ${dim} != index dimension ${this.dim}`);
    }
    this.deleteNote(source);
    if (dim && this.chunkCount === 0) this.dim = dim;
    this.notes.set(source, { hash, meta, chunks: stored });
    this.chunkCount += stored.length;
  }

  deleteNote(source) {
    const old = this.notes.get(source);
    if (!old) return false;
    this.notes.delete(source);
    this.chunkCount -= old.chunks.length;
    if (this.chunkCount === 0) this.dim = 0;
    return true;
  }

  // Closest chunks first: [{ text, source, distance }]. `threshold` = max
  // cosine distance (inclusive), null/undefined = no filter.
  search(queryVec, { topK = 3, threshold = null } = {}) {
    const k = Math.max(1, Math.floor(topK));
    if (this.chunkCount === 0) return [];
    const q = normalize(queryVec);
    if (q.length !== this.dim) throw new DimensionMismatch(`query vector dimension ${q.length} != index dimension ${this.dim}`);
    const hasThreshold = threshold !== null && threshold !== undefined && Number.isFinite(threshold);
    const top = []; // ascending by distance, at most k entries
    for (const [source, note] of this.notes) {
      for (const c of note.chunks) {
        // Rounded BEFORE the threshold test: the filter then agrees with the
        // reported distance, and float32 noise (an identical text at
        // 0.00000006) still passes a threshold of 0.
        const d = Math.round(Math.min(2, Math.max(0, 1 - dot(q, c.vec))) * 1e4) / 1e4;
        if (hasThreshold && d > threshold) continue;
        if (top.length === k && d >= top[k - 1].d) continue;
        let i = top.length;
        while (i > 0 && top[i - 1].d > d) i--;
        top.splice(i, 0, { d, c, source });
        if (top.length > k) top.pop();
      }
    }
    return top.map(({ d, c, source }) => ({ text: c.text, source, distance: d }));
  }

  // ── persistence ──────────────────────────────────────────────────────────
  serialize() {
    const notes = [];
    const vecBufs = [];
    for (const [source, n] of this.notes) {
      notes.push({ source, hash: n.hash, meta: n.meta, chunks: n.chunks.map((c) => ({ heading: c.heading, text: c.text })) });
      for (const c of n.chunks) vecBufs.push(Buffer.from(c.vec.buffer, c.vec.byteOffset, c.vec.byteLength));
    }
    const header = Buffer.from(JSON.stringify({
      signature: this.signature,
      dim: this.dim,
      chunks: this.chunkCount,
      endian: os.endianness(),
      savedAt: new Date().toISOString(),
      notes,
    }), 'utf8');
    const pre = Buffer.alloc(16);
    MAGIC.copy(pre, 0);
    pre.writeUInt32LE(FORMAT_VERSION, 8);
    pre.writeUInt32LE(header.length, 12);
    const pad = Buffer.alloc((4 - ((16 + header.length) % 4)) % 4);
    return Buffer.concat([pre, header, pad, ...vecBufs]);
  }

  // Parse a serialized index. Throws IndexFormatError with a reason when the
  // file can't be used; a signature mismatch is reported as `stale` (expected
  // after a model change) rather than as corruption.
  static deserialize(buf, { signature } = {}) {
    if (buf.length < 16 || !buf.subarray(0, 8).equals(MAGIC)) throw new IndexFormatError('not a RAG index file');
    const version = buf.readUInt32LE(8);
    if (version !== FORMAT_VERSION) throw new IndexFormatError(`format version ${version} (expected ${FORMAT_VERSION})`, { stale: true });
    const hlen = buf.readUInt32LE(12);
    if (16 + hlen > buf.length) throw new IndexFormatError('truncated header');
    let header;
    try { header = JSON.parse(buf.subarray(16, 16 + hlen).toString('utf8')); }
    catch (e) { throw new IndexFormatError(`bad header: ${e.message}`); }
    if (signature !== undefined && header.signature !== signature) {
      throw new IndexFormatError('embedding signature changed', { stale: true });
    }
    if (header.endian !== os.endianness()) throw new IndexFormatError(`byte order ${header.endian}`, { stale: true });
    const dim = header.dim;
    const count = header.chunks;
    if (!Number.isInteger(dim) || dim < 0 || !Number.isInteger(count) || count < 0 || !Array.isArray(header.notes)) {
      throw new IndexFormatError('bad header fields');
    }
    const off = 16 + hlen + ((4 - ((16 + hlen) % 4)) % 4);
    if (buf.length !== off + count * dim * 4) throw new IndexFormatError(`size mismatch (${buf.length} bytes for ${count}×${dim})`);
    // Copy into an aligned buffer once; every chunk vector is a view into it.
    const all = new Float32Array(count * dim);
    new Uint8Array(all.buffer).set(buf.subarray(off, off + count * dim * 4));
    const store = new VectorStore(header.signature);
    let at = 0;
    for (const n of header.notes ?? []) {
      const chunks = (n.chunks ?? []).map((c) => {
        const vec = all.subarray(at * dim, (at + 1) * dim);
        at++;
        return { text: String(c.text ?? ''), heading: String(c.heading ?? ''), vec };
      });
      store.notes.set(n.source, { hash: n.hash, meta: n.meta ?? {}, chunks });
      store.chunkCount += chunks.length;
    }
    if (at !== count) throw new IndexFormatError(`header lists ${at} chunks, vectors for ${count}`);
    store.dim = store.chunkCount ? dim : 0;
    return store;
  }
}

export class IndexFormatError extends Error {
  constructor(msg, { stale = false } = {}) { super(msg); this.stale = stale; }
}

export class DimensionMismatch extends Error {}

// Write `data` to `file` atomically: temp file in the same directory, fsync,
// rename over the target. On Windows a rename onto a file that an antivirus or
// indexer briefly holds open fails with EPERM/EBUSY/EACCES — retried a few
// times before giving up (the temp file is removed; the old index stays).
export async function writeFileAtomic(file, data, { retries = 5 } = {}) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(tmp, file);
      return;
    } catch (e) {
      const transient = e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES';
      if (!transient || attempt >= retries) {
        await fs.promises.unlink(tmp).catch(() => {});
        throw e;
      }
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

// Remove temp files a crash may have left next to the index.
export async function cleanupTempFiles(dir) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return; }
  await Promise.all(names
    .filter((n) => n.startsWith(`${INDEX_FILE}.`) && n.endsWith('.tmp'))
    .map((n) => fs.promises.unlink(path.join(dir, n)).catch(() => {})));
}
