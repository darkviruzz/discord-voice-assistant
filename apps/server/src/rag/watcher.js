// Vault file watcher: debounced per-note re-sync on change.
//
// fs.watch(vault, { recursive: true }) — native on Windows/macOS, a per-
// directory inotify emulation in Node >= 20 on Linux. The event TYPE is not
// trusted (editors save via temp file + rename, sync clients delete + create,
// events arrive late or out of order): every event only says "look at this
// path again", and the indexer syncs the note from its CURRENT state on disk
// (exists → (re)index, gone → drop). Bursts are debounced per note, so an
// Obsidian autosave every few seconds costs one sync, not one per keystroke.
//
// Events that may stand for a whole directory (folder renamed/moved/deleted —
// per-file events are not guaranteed for its contents on every platform) or
// with no filename at all trigger one debounced full rescan instead; that is
// cheap, unchanged notes are skipped by content hash.
//
// The watcher must never take the server down: a platform without recursive
// watch support, an exhausted inotify limit (ENOSPC) or a runtime 'error'
// event just turns it off with a warning — the periodic rescan in the indexer
// keeps the index current anyway, only with more latency.

import fs from 'node:fs';
import path from 'node:path';
import { isHidden } from './scanner.js';

const FULL = '\0full-rescan';

export class VaultWatcher {
  constructor(root, { debounceMs = 1000, onNote, onRescan, ignore = () => false, logger, watchFn = fs.watch } = {}) {
    this.root = root;
    this.debounceMs = debounceMs;
    this.onNote = onNote;
    this.onRescan = onRescan;
    this.ignore = ignore;
    this.logger = logger;
    this.watchFn = watchFn;
    this.timers = new Map();
    this.watcher = null;
    this.state = 'off'; // 'watching' | 'off' | 'failed'
  }

  // Returns true when watching. Never throws.
  start() {
    if (this.watcher) return true;
    try {
      this.watcher = this.watchFn(this.root, { recursive: true, persistent: false }, (type, name) => this._event(type, name));
    } catch (e) {
      this.state = 'failed';
      this.logger?.warn(`rag: file watcher unavailable (${e.code || e.message}) — relying on the periodic rescan`);
      return false;
    }
    this.watcher.on('error', (e) => {
      this.logger?.warn(`rag: file watcher failed (${e.code || e.message}) — relying on the periodic rescan`);
      this.close();
      this.state = 'failed';
    });
    this.state = 'watching';
    return true;
  }

  close() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* already closed */ }
      this.watcher = null;
    }
    if (this.state === 'watching') this.state = 'off';
  }

  _event(_type, name) {
    try {
      if (name === null || name === undefined) { this._debounce(FULL, this.onRescan); return; }
      const rel = String(name).split(path.sep).join('/');
      if (!rel || isHidden(rel) || this.ignore(rel)) return;
      if (rel.toLowerCase().endsWith('.md')) {
        this._debounce(rel, () => this.onNote(rel));
        return;
      }
      // Not a note: only a directory (created/renamed/removed) can affect the
      // index. A path that is gone may have been one → rescan; an existing
      // non-directory (an image, a PDF) is irrelevant.
      fs.promises.stat(path.join(this.root, rel)).then(
        (st) => { if (st.isDirectory()) this._debounce(FULL, this.onRescan); },
        () => this._debounce(FULL, this.onRescan),
      );
    } catch (e) {
      this.logger?.warn(`rag: watcher event failed: ${e.message}`);
    }
  }

  _debounce(key, fn) {
    if (!this.watcher) return; // closed meanwhile (async stat above)
    const old = this.timers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      // Drop our own entry so the map doesn't grow with every note ever touched.
      if (this.timers.get(key) === timer) this.timers.delete(key);
      Promise.resolve()
        .then(fn)
        .catch((e) => this.logger?.warn(`rag: watch sync failed for ${key === FULL ? 'vault' : key}: ${e.message}`));
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(key, timer);
  }
}
