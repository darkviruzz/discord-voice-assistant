// Vault indexer: keeps the vector store in sync with the Obsidian vault.
//
//   start()      load the persisted index (queries work from here on), start
//                the watcher + periodic rescan, then sync in the background
//                with exponential backoff while the embedding backend is down
//                (Ollama still starting / model not pulled yet). Never blocks
//                on the vault or on embeddings.
//   sync()       full, incremental, single-flight sync: every note is hashed;
//                only new/changed notes are re-embedded (renamed/moved ones
//                take over their old vectors), notes that vanished (deleted,
//                renamed, moved into .trash) are pruned. A call while a sync
//                runs joins it and queues exactly one more pass.
//                sync({ quick: true }) — periodic rescans — trusts an
//                unchanged size + mtime instead of reading every note.
//   syncNote(s)  bring ONE note in line with its current state on disk (the
//                watcher path): exists → (re)index, gone → drop.
//   query(text)  embed the query, brute-force cosine top-k over the store.
//   stop()       stop watcher/timers, abort in-flight embeddings, flush to disk.
//
// Failure model (the spec this was ported from: the former apps/rag service):
//   - The index is never wiped up front. All embeddings of a note are computed
//     BEFORE its old chunks are replaced, so an embedding failure leaves the
//     note's previous chunks searchable; when the backend goes away mid-sync
//     the run aborts (EmbeddingUnavailable) and the notes not processed yet
//     keep their old chunks too.
//   - One unreadable or otherwise broken note is logged and skipped; it never
//     fails the whole run.
//   - The embedding signature (provider/model/task prefixes) is recorded in the
//     index. When it changes — also live, via the settings panel — the index is
//     dropped and rebuilt, because old and new vectors are not comparable.
//     Chunker version + RAG_MAX_CHUNK_CHARS are part of every note's content
//     digest, so changing them re-embeds every note once.
//   - Per-note operations are serialized by a per-note lock: read → embed →
//     write of one note never interleaves with another update of the same note,
//     so an older read can never land last.
//
// The embedding function is injected ({ embed }) so tests run without any
// model server; in production it is providers/embed.js.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chunkMarkdown, CHUNKER_VERSION, DEFAULT_MAX_CHUNK_CHARS } from './chunker.js';
import { listNotes, readNote, noteState, statNote, isHidden, compileExclude, MAX_FILE_BYTES } from './scanner.js';
import { VectorStore, INDEX_FILE, writeFileAtomic, cleanupTempFiles, IndexFormatError, DimensionMismatch } from './store.js';
import { VaultWatcher } from './watcher.js';

export const MAX_TOP_K = 20;
export const DEFAULT_TOP_K = 3;
// Chunks per embedding request: one HTTP round-trip per note for typical
// notes, bounded so a huge note doesn't become one giant request.
const EMBED_BATCH = 16;
// Indexing tolerates a cold model load (the query path has its own, tight
// budget — RAG_TIMEOUT_MS — passed in by the caller).
const EMBED_TIMEOUT_INDEX_MS = 120_000;

// The embedding backend failed (down, model missing, timeout, bad reply).
export class EmbeddingUnavailable extends Error {}
// The vault directory is missing/unreadable.
export class VaultUnavailable extends Error {}
class NoteUnreadable extends Error {}

export function clampTopK(topK) {
  const v = Number(topK);
  return Number.isFinite(v) && v >= 1 ? Math.min(MAX_TOP_K, Math.floor(v)) : DEFAULT_TOP_K;
}

// Fingerprint of a note's text + everything (besides the embedding signature,
// which is index-wide) that shapes its chunks.
export function noteDigest(text, maxChunkChars) {
  return crypto.createHash('sha256')
    .update(`${CHUNKER_VERSION}\0${maxChunkChars}\0`)
    .update(text, 'utf8')
    .digest('hex');
}

const SILENT = { log() {}, warn() {}, debug() {} };

export class RagIndexer {
  constructor({
    vaultPath,
    indexDir,
    embed,
    signature = () => 'default',
    maxChunkChars = DEFAULT_MAX_CHUNK_CHARS,
    maxFileBytes = MAX_FILE_BYTES,
    exclude = [],
    watch = true,
    debounceMs = 1000,
    rescanIntervalMs = 300_000,
    saveDelayMs = 5000,
    retryBaseMs = 5000,
    retryMaxMs = 300_000,
    logger = SILENT,
  } = {}) {
    if (typeof embed !== 'function') throw new TypeError('RagIndexer: embed function required');
    this.vaultPath = path.resolve(vaultPath);
    this.indexDir = path.resolve(indexDir);
    this.indexFile = path.join(this.indexDir, INDEX_FILE);
    this.embedFn = embed;
    this.signatureFn = typeof signature === 'function' ? signature : () => signature;
    this.maxChunkChars = maxChunkChars;
    this.maxFileBytes = maxFileBytes;
    this.exclude = [...exclude];
    this._excluded = compileExclude(this.exclude); // RAG_EXCLUDE (scanner.js)
    this.watchEnabled = watch;
    this.debounceMs = debounceMs;
    this.rescanIntervalMs = rescanIntervalMs;
    this.saveDelayMs = saveDelayMs;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.logger = logger;

    this.store = new VectorStore(null);
    this.ready = false;      // persisted index loaded (or confirmed absent)
    this.indexing = false;   // a full sync is running
    this.stopped = false;
    this.lastError = null;
    this.lastSync = null;    // { at, ms, quick, files, indexed, failed, pruned, embedded, reused }
    this.embedOk = null;     // last embedding call succeeded? (null = none yet)

    this._started = false;
    this._startPromise = null;
    this._warm = null;       // the initial background sync loop
    this._loading = null;
    this._syncing = null;
    this._syncAgain = false;
    this._noteLocks = new Map();
    this._dirty = false;
    this._saving = null;
    this._saveAgain = false;
    this._saveTimer = null;
    this._rescanTimer = null;
    this._sleepers = new Set();
    this._abort = new AbortController();
    this._watcher = null;
    this._embedded = 0; // notes (re-)embedded in the current sync pass
    this._reused = 0;   // notes that took the vectors of an identical note
    this._againFull = false; // a queued extra pass must not be a quick one
    this._failStreak = false;

    // When the index directory lives inside the vault, its writes must not
    // look like vault changes.
    const rel = path.relative(this.vaultPath, this.indexDir);
    this._ignorePrefix = (!rel || rel.startsWith('..') || path.isAbsolute(rel))
      ? null : `${rel.split(path.sep).join('/')}/`;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  // Resolves once the persisted index is loaded; syncing continues in the
  // background (see whenSynced() for tests).
  start() {
    if (this._started) return this._startPromise;
    this._started = true;
    this._startPromise = this._ensureLoaded().then(() => {
      if (this.stopped) return;
      this._startWatcher();
      this._startRescanTimer();
      this._warm = this._warmLoop();
    });
    return this._startPromise;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this._abort.abort();
    this._watcher?.close();
    clearInterval(this._rescanTimer);
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    for (const wake of this._sleepers) wake();
    await this._startPromise;
    try { await this._syncing; } catch { /* aborted */ }
    await this._warm;
    await this.flush();
  }

  // Test/diagnostic helper: resolves after the initial background sync loop
  // has finished (successfully, or given up on a missing vault).
  async whenSynced() {
    await this._startPromise;
    await this._warm;
  }

  // Load the persisted index exactly once — also when sync()/syncNote() run
  // without start() (tests, tools): syncing before loading would overwrite the
  // file on disk with a fresh, empty store and re-embed the whole vault.
  _ensureLoaded() {
    if (!this._loading) {
      this._loading = this._load()
        .catch((e) => {
          this.logger.warn(`rag: loading the index failed (${e.message}) — rebuilding from the vault`);
          this.store = new VectorStore(this.signatureFn());
        })
        .then(() => { if (!this.stopped) this.ready = true; });
    }
    return this._loading;
  }

  status() {
    return {
      ready: this.ready,
      indexing: this.indexing,
      notes: this.store.noteCount,
      chunks: this.store.chunkCount,
      dim: this.store.dim,
      lastSyncAt: this.lastSync?.at ?? null,
      lastSyncMs: this.lastSync?.ms ?? null,
      lastSyncFailed: this.lastSync?.failed ?? null,
      lastError: this.lastError,
      embedOk: this.embedOk,
      watcher: this._watcher?.state ?? 'off',
    };
  }

  async _load() {
    const sig = this.signatureFn();
    await cleanupTempFiles(this.indexDir);
    let buf;
    try {
      buf = await fs.promises.readFile(this.indexFile);
    } catch (e) {
      if (e.code !== 'ENOENT') this.logger.warn(`rag: cannot read ${this.indexFile} (${e.code || e.message}) — rebuilding from the vault`);
      this.store.reset(sig);
      return;
    }
    try {
      this.store = VectorStore.deserialize(buf, { signature: sig });
      this.logger.log(`rag: loaded index ${this.indexFile} (${this.store.noteCount} notes, ${this.store.chunkCount} chunks)`);
    } catch (e) {
      // Stale (other model/format) is expected; anything else is corruption.
      // Either way: start empty and rebuild — never fail the server over it.
      const stale = e instanceof IndexFormatError && e.stale;
      (stale ? this.logger.log : this.logger.warn).call(this.logger,
        `rag: discarding ${this.indexFile}: ${e.message} — rebuilding from the vault`);
      this.store = new VectorStore(sig);
      this._dirty = true;
    }
  }

  _startWatcher() {
    if (!this.watchEnabled) return;
    this._watcher = new VaultWatcher(this.vaultPath, {
      debounceMs: this.debounceMs,
      logger: this.logger,
      ignore: (rel) => (!!this._ignorePrefix && (rel + '/').startsWith(this._ignorePrefix)) || this._excluded(rel),
      onNote: async (source) => {
        const n = await this.syncNote(source);
        this.logger.debug(`rag: watch: synced ${source} (${n} chunks)`);
      },
      // Folder-level events: renamed/moved notes have new paths (read anyway),
      // everything else only needs the cheap size+mtime check.
      onRescan: () => this.sync({ quick: true }),
    });
    this._watcher.start();
  }

  _startRescanTimer() {
    const ms = Number(this.rescanIntervalMs);
    if (!Number.isFinite(ms) || ms <= 0) return;
    this._rescanTimer = setInterval(() => this.requestSync({ quick: true }), Math.min(ms, 2 ** 31 - 1));
    this._rescanTimer.unref?.();
  }

  // Initial sync with backoff: the embedding backend may still be starting.
  // Runs on every start (not only on an empty index) so edits made while the
  // server was down are picked up; unchanged notes cost no embedding calls.
  async _warmLoop() {
    let delay = this.retryBaseMs;
    let warned = null; // repeat the same failure (model not pulled …) only at DEBUG
    while (!this.stopped) {
      try {
        await this.sync();
        if (warned) this.logger.log('rag: initial sync succeeded after retrying');
        return;
      } catch (e) {
        if (this.stopped) return;
        this.lastError = e.message;
        if (e instanceof VaultUnavailable) {
          this.logger.warn(`rag: ${e.message} — not indexed (the periodic rescan retries)`);
          return;
        }
        const msg = `rag: initial sync failed (retry in ${Math.round(delay / 1000)} s; CAMPAIGN.md until then): ${e.message}`;
        if (warned === e.message) this.logger.debug(msg); else this.logger.warn(msg);
        warned = e.message;
      }
      await this._sleep(delay);
      delay = Math.min(delay * 2, this.retryMaxMs);
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const wake = () => { clearTimeout(t); this._sleepers.delete(wake); resolve(); };
      const t = setTimeout(wake, ms);
      t.unref?.();
      this._sleepers.add(wake);
    });
  }

  // ── syncing ───────────────────────────────────────────────────────────────

  // Fire-and-forget sync for timers/queries; failures are logged once per
  // failure streak (a down Ollama must not log every 5 minutes at WARN).
  requestSync(opts) {
    if (this.stopped || this._syncing) return;
    this.sync(opts).then(() => {
      if (this._failStreak) this.logger.log('rag: sync succeeded again');
      this._failStreak = false;
    }, (e) => {
      if (this.stopped) return;
      this.lastError = e.message;
      if (!this._failStreak) this.logger.warn(`rag: background sync failed: ${e.message}`);
      else this.logger.debug(`rag: background sync failed: ${e.message}`);
      this._failStreak = true;
    });
  }

  // `quick` → see _indexNote (periodic rescans). A full request arriving
  // while a quick pass runs makes the queued extra pass a full one.
  sync({ quick = false } = {}) {
    if (this.stopped) return Promise.resolve(null);
    if (this._syncing) {
      this._syncAgain = true;
      if (!quick) this._againFull = true;
      return this._syncing;
    }
    this._syncing = (async () => {
      try {
        let result;
        let q = quick;
        do {
          this._syncAgain = false;
          this._againFull = false;
          result = await this._syncOnce({ quick: q });
          q = !this._againFull && quick;
        } while (this._syncAgain && !this.stopped);
        return result;
      } finally {
        this._syncing = null;
        this.indexing = false;
      }
    })();
    return this._syncing;
  }

  async _syncOnce({ quick = false } = {}) {
    await this._ensureLoaded();
    if (this.stopped) return null;
    const t0 = Date.now();
    try {
      if (!(await fs.promises.stat(this.vaultPath)).isDirectory()) throw new Error('not a directory');
    } catch (e) {
      throw new VaultUnavailable(`vault not available: ${this.vaultPath} (${e.code || e.message})`);
    }
    this._checkSignature();
    this.indexing = true;
    let notes;
    try {
      notes = await listNotes(this.vaultPath, {
        onSkip: (dir, e) => this.logger.warn(`rag: skipping unreadable folder ${dir} (${e.code || e.message})`),
      });
    } catch (e) {
      throw new VaultUnavailable(`vault not readable: ${this.vaultPath} (${e.code || e.message})`);
    }

    let files = 0;
    let indexed = 0;
    let failed = 0;
    this._embedded = 0;
    this._reused = 0;
    const seen = new Set();
    for (const { full, source } of notes) {
      if (this.stopped) return null;
      if (this._ignored(source)) continue;
      files++;
      seen.add(source);
      try {
        indexed += await this._withNoteLock(source, () => this._indexNote(full, source, { quick }));
      } catch (e) {
        if (this.stopped) return null;
        if (e instanceof EmbeddingUnavailable) throw e;
        failed++;
        this.logger.warn(`rag: skipped ${source}: ${e.message}`);
      }
    }
    const pruned = await this._prune(seen);
    const embedded = this._embedded;
    const reused = this._reused;
    this.lastSync = { at: new Date().toISOString(), ms: Date.now() - t0, quick, files, indexed, failed, pruned, embedded, reused };
    this.lastError = failed ? `${failed} note(s) failed in the last sync` : null;
    const msg = `rag: ${quick ? 'rescan' : 'sync'}: ${indexed} chunks from ${files} notes (${embedded} embedded, ${reused} moved, ${failed} failed, ${pruned} pruned) in ${this.lastSync.ms} ms`;
    if (embedded || reused || failed || pruned) this.logger.log(msg); else this.logger.debug(msg);
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    await this.flush();
    return { files, indexed, failed, pruned, embedded, reused };
  }

  // Drop chunks of notes that no longer exist (deleted/renamed/now hidden).
  // Re-checked under the note's lock: a note the watcher has just (re)created
  // after the directory listing must not be pruned.
  async _prune(seen) {
    let removed = 0;
    for (const source of this.store.sources()) {
      if (seen.has(source)) continue;
      await this._withNoteLock(source, async () => {
        const gone = isHidden(source) || this._ignored(source)
          || (await noteState(this._fullPath(source))) === 'missing';
        if (gone && this.store.deleteNote(source)) {
          removed++;
          this._markDirty();
        }
      });
    }
    return removed;
  }

  // Bring one note in line with the file's CURRENT state on disk. Used by the
  // watcher instead of trusting the event type: whatever happened (edit,
  // create, delete, rename, atomic save via temp file), the final file state
  // decides — so late or out-of-order events can't leave stale chunks.
  syncNote(source) {
    return this._withNoteLock(source, async () => {
      await this._ensureLoaded();
      if (this.stopped) return 0;
      if (this.store.signature !== this.signatureFn()) {
        // Different vector space: a single note can't be mixed in — rebuild.
        this.requestSync();
        return 0;
      }
      if (isHidden(source) || this._ignored(source)) {
        if (this.store.deleteNote(source)) this._markDirty();
        return 0;
      }
      const full = this._fullPath(source);
      const state = await noteState(full);
      if (state === 'file') return this._indexNote(full, source);
      if (state === 'missing') {
        if (this.store.deleteNote(source)) this._markDirty();
        return 0;
      }
      return this.store.getNote(source)?.chunks.length ?? 0; // unknown → keep
    });
  }

  // (Re)index one note: replace its chunks with the current ones, skipping the
  // embedding round-trips when the note is unchanged. Caller holds the lock.
  //
  // `quick` (periodic rescans only): trust an unchanged size + mtime and skip
  // even reading the note — a rescan of a large vault on a slow or cloud-
  // synced disk then costs one stat per note. Startup syncs and watcher
  // events always compare content hashes, so an edit that kept size and mtime
  // is still caught there.
  async _indexNote(full, source, { quick = false } = {}) {
    // Stat BEFORE reading: a save racing the read leaves a newer mtime behind,
    // so the next quick rescan still looks at the note again.
    const st = await statNote(full);
    const fp = st ? `${st.size}:${st.mtimeMs}:${CHUNKER_VERSION}:${this.maxChunkChars}` : null;
    const old = this.store.getNote(source);
    if (quick && fp && old?.fp === fp) return old.chunks.length;

    const text = await readNote(full, {
      maxBytes: this.maxFileBytes,
      onWarn: (m) => this.logger.warn(`rag: ${m}`),
    });
    if (text === null) throw new NoteUnreadable('not readable right now — keeping its previous chunks');
    const hash = noteDigest(text, this.maxChunkChars);
    if (old && old.hash === hash) {
      if (fp && old.fp !== fp) { old.fp = fp; this._markDirty(); }
      return old.chunks.length;
    }

    const { meta, chunks } = chunkMarkdown(text, source, { maxChars: this.maxChunkChars });
    // A note with identical content under another path (renamed/moved notes
    // and folders: the old path is only pruned after the scan) donates its
    // vectors — moving a folder in Obsidian costs no embedding calls.
    const donor = this.store.findByHash(hash, source);
    const reuse = donor && donor.chunks.length === chunks.length;
    const vectors = reuse
      ? donor.chunks.map((c) => c.vec)
      : await this._embedDocuments(chunks.map((c) => c.text));
    if (this.stopped) return 0;
    try {
      this.store.setNote(source, { hash, fp, meta, chunks, vectors });
    } catch (e) {
      if (!(e instanceof DimensionMismatch)) throw e;
      // Same signature, different vector size: the model behind the name
      // changed. Old vectors are useless — start over with this note and
      // re-embed the rest in another pass.
      this.logger.warn(`rag: ${e.message} — embedding model changed, rebuilding the index`);
      this.store.reset(this.signatureFn());
      this.store.setNote(source, { hash, fp, meta, chunks, vectors });
      this._syncAgain = true;
      this.requestSync();
    }
    if (reuse) this._reused++; else this._embedded++;
    this._markDirty();
    return chunks.length;
  }

  async _embedDocuments(texts) {
    const out = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      out.push(...await this._embed(texts.slice(i, i + EMBED_BATCH), 'document', EMBED_TIMEOUT_INDEX_MS, this._abort.signal));
    }
    return out;
  }

  // Every failure of the backend (transport, HTTP error, timeout, malformed
  // reply) surfaces as EmbeddingUnavailable, so callers can tell "the model
  // server is the problem" apart from a broken note.
  async _embed(texts, kind, timeoutMs, signal) {
    let vectors;
    try {
      vectors = await this.embedFn(texts, { kind, timeoutMs, signal });
    } catch (e) {
      if (!this.stopped) this.embedOk = false;
      throw new EmbeddingUnavailable(e.message, { cause: e });
    }
    const ok = Array.isArray(vectors) && vectors.length === texts.length
      && vectors.every((v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length > 0);
    if (!ok) {
      this.embedOk = false;
      throw new EmbeddingUnavailable(`embedding backend returned ${Array.isArray(vectors) ? vectors.length : 'no'} vector(s) for ${texts.length} text(s)`);
    }
    this.embedOk = true;
    return vectors;
  }

  // ── querying ─────────────────────────────────────────────────────────────

  // Closest chunks first: [{ text, source, distance }]. [] while the index
  // isn't loaded, is empty, or was built with another embedding signature
  // (a rebuild is requested then). Throws EmbeddingUnavailable when the query
  // can't be embedded. `threshold` = max cosine distance, null = no filter.
  async query(text, { topK = DEFAULT_TOP_K, threshold = null, timeoutMs, signal } = {}) {
    const q = String(text ?? '').trim();
    if (!q || !this.ready || this.store.chunkCount === 0) return [];
    if (this.store.signature !== this.signatureFn()) {
      this.requestSync();
      return [];
    }
    const [vec] = await this._embed([q], 'query', timeoutMs, signal);
    try {
      return this.store.search(vec, { topK: clampTopK(topK), threshold });
    } catch (e) {
      if (!(e instanceof DimensionMismatch)) throw e;
      this.logger.warn(`rag: ${e.message} — embedding model changed, rebuilding the index`);
      this.store.reset(this.signatureFn());
      this._markDirty();
      this.requestSync();
      return [];
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  _fullPath(source) {
    return path.join(this.vaultPath, ...source.split('/'));
  }

  _ignored(source) {
    return (!!this._ignorePrefix && source.startsWith(this._ignorePrefix)) || this._excluded(source);
  }

  _checkSignature() {
    const sig = this.signatureFn();
    if (this.store.signature === sig) return false;
    if (this.store.noteCount > 0) {
      this.logger.log(`rag: embedding setup changed (${this.store.signature} → ${sig}) — rebuilding the index`);
    }
    this.store.reset(sig);
    this._markDirty();
    return true;
  }

  _withNoteLock(source, fn) {
    const prev = this._noteLocks.get(source) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(() => {}, () => {});
    this._noteLocks.set(source, tail);
    tail.then(() => { if (this._noteLocks.get(source) === tail) this._noteLocks.delete(source); });
    return run;
  }

  _markDirty() {
    this._dirty = true;
    if (this._saveTimer || this.stopped) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, this.saveDelayMs);
    this._saveTimer.unref?.();
  }

  // Persist the store if it changed. Single-flight; never throws (a failed
  // save is logged and retried with the next change / sync / shutdown).
  flush() {
    if (this._saving) { this._saveAgain = true; return this._saving; }
    if (!this._dirty) return Promise.resolve();
    this._saving = (async () => {
      try {
        do {
          this._saveAgain = false;
          this._dirty = false;
          try {
            await writeFileAtomic(this.indexFile, this.store.serialize());
          } catch (e) {
            this._dirty = true;
            this.logger.warn(`rag: saving ${this.indexFile} failed: ${e.code || e.message}`);
            return;
          }
        } while (this._saveAgain && this._dirty);
      } finally {
        this._saving = null;
      }
    })();
    return this._saving;
  }
}
