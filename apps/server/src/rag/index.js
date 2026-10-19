// Vault RAG — semantic search over the Obsidian campaign vault, in-process.
//
// This is the server-facing API (campaignContext.js,
// control.js, index.js). It replaces the former Python service (apps/rag/,
// FastAPI + ChromaDB): the index lives in this process (rag/indexer.js +
// rag/store.js), embeddings come from providers/embed.js (Ollama /api/embed by
// default, any OpenAI-compatible /embeddings optionally), and the vectors are
// persisted in RAG_INDEX_DIR — no second process, port, venv or image.
//
//   startRag()        boot: start the indexer for the configured vault in the
//                     background (load index → watch → sync). Never blocks.
//   stopRag()         shutdown: stop watching, flush the index to disk.
//   queryRag(q, opts) → [{ text, source, distance }], closest first. Fail-soft:
//                     disabled / not ready yet / backend down / timeout → [].
//                     Bounded by RAG_TIMEOUT_MS (or opts.timeoutMs).
//   formatRagHits()   hits → one text block, each chunk prefixed with its source.
//   warmRag(reason)   load the embedding model (Ollama) without the query's
//                     tight deadline: at boot, on the bot's voice join
//                     (keepWarm.js) and in the background after a failed query.
//   ragEnabled()      RAG_ENABLED (default true) AND OBSIDIAN_VAULT_PATH set.
//   ragConfig()       effective settings + index stats (session_meta report).
//
// Settings are read from process.env on use, so the settings panel applies
// them live: queryRag() reconciles the running indexer with the current
// configuration (vault path, index dir, chunk size, rescan interval, enabled)
// and restarts it when one of them changed. Embedding settings (EMBED_*) are
// checked by the indexer itself via the embedding signature (→ rebuild).
//
// `distance` is the cosine distance (0 = identical .. 2 = opposite);
// RAG_SCORE_THRESHOLD is the max distance a hit may have to be kept.

import path from 'node:path';
import { log, warn, debug } from '../logger.js';
import { embed, embedSignature, embedModel, embedProvider } from '../providers/embed.js';
import { RagIndexer, DEFAULT_TOP_K, MAX_TOP_K, clampTopK } from './indexer.js';
import { DEFAULT_MAX_CHUNK_CHARS } from './chunker.js';

export { MAX_TOP_K, clampTopK };

const DEFAULT_TIMEOUT_MS = 800;
// setTimeout() clamps larger delays to 1 ms (TimeoutOverflowWarning), which
// would abort every query instantly.
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_RESCAN_MS = 300_000;

function envStr(key) {
  const v = process.env[key];
  return typeof v === 'string' ? v.trim() : '';
}

function envPositiveInt(key, fallback, { allowZero = false } = {}) {
  const raw = envStr(key);
  if (!raw) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  if (allowZero && v === 0) return 0;
  return v > 0 ? Math.min(Math.floor(v), MAX_TIMEOUT_MS) : fallback;
}

export function ragEnabled() {
  return !/^(false|0|off|no)$/i.test(envStr('RAG_ENABLED')) && envStr('OBSIDIAN_VAULT_PATH') !== '';
}

function timeoutMs() {
  return envPositiveInt('RAG_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
}

// Max cosine distance for hits. Empty/unset/invalid/negative → null = no filter.
function scoreThreshold() {
  const raw = envStr('RAG_SCORE_THRESHOLD');
  if (!raw) return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function maxChunkChars() {
  return envPositiveInt('RAG_MAX_CHUNK_CHARS', DEFAULT_MAX_CHUNK_CHARS);
}

// 0 = no periodic rescan (watcher only).
function rescanIntervalMs() {
  return envPositiveInt('RAG_RESCAN_INTERVAL_MS', DEFAULT_RESCAN_MS, { allowZero: true });
}

// Default ./data/rag (relative to the server's working directory, next to
// config.overrides.json); compose sets /data/rag on the server-data volume.
function indexDir() {
  return path.resolve(envStr('RAG_INDEX_DIR') || path.join(envStr('DATA_DIR') || './data', 'rag'));
}

// ── indexer lifecycle ───────────────────────────────────────────────────────

let active = null;          // { key, indexer } for the current configuration
let transition = Promise.resolve();
let shutDown = false;       // stopRag() was called: no implicit restarts
let indexerOptions = {};    // test hooks (embed, debounceMs, …) from startRag()

function desiredConfig() {
  if (!ragEnabled()) return null;
  return {
    vaultPath: path.resolve(envStr('OBSIDIAN_VAULT_PATH')),
    indexDir: indexDir(),
    maxChunkChars: maxChunkChars(),
    rescanIntervalMs: rescanIntervalMs(),
  };
}

// Bring the running indexer in line with the current settings: start, stop or
// replace it. Cheap when nothing changed (string compare). The old indexer is
// stopped (and its index flushed) before the new one loads the same file.
function reconcile() {
  const cfg = desiredConfig();
  const key = cfg ? JSON.stringify(cfg) : null;
  if ((active?.key ?? null) === key) return transition;
  const old = active;
  const next = cfg ? {
    key,
    cfg,
    indexer: new RagIndexer({
      ...cfg,
      embed,
      signature: embedSignature,
      logger: { log, warn, debug },
      ...indexerOptions,
    }),
  } : null;
  active = next;
  transition = transition
    .then(async () => {
      if (old) await old.indexer.stop();
      if (next && active === next) {
        log(`rag: vault ${next.cfg.vaultPath} → index ${next.cfg.indexDir} (embeddings: ${embedProvider()}/${embedModel()})`);
        await next.indexer.start();
      }
    })
    .catch((e) => warn(`rag: indexer start/stop failed: ${e.message}`));
  return transition;
}

// Start (or re-configure) the vault indexer in the background. The returned
// promise resolves once the persisted index is loaded — callers on the boot
// path must not await it. `options` are RagIndexer overrides (tests).
export function startRag(options = {}) {
  shutDown = false;
  indexerOptions = options;
  if (!ragEnabled()) {
    debug('rag: disabled (RAG_ENABLED=false or no OBSIDIAN_VAULT_PATH) — CAMPAIGN.md only');
  }
  return reconcile();
}

// Stop the indexer and flush the index to disk.
export async function stopRag() {
  shutDown = true;
  const old = active;
  active = null;
  transition = transition
    .then(() => old?.indexer.stop())
    .catch((e) => warn(`rag: stop failed: ${e.message}`));
  await transition;
}

// Index state for diagnostics/tests (null when no indexer runs).
export function ragStatus() {
  return active ? active.indexer.status() : null;
}

// Test/diagnostic hook: the running indexer (null when none).
export function _activeIndexer() {
  return active?.indexer ?? null;
}

// ── embedding warm-up ───────────────────────────────────────────────────────

// A query embed must finish within RAG_TIMEOUT_MS (800 ms) and is aborted at
// the deadline. A cold embedding model takes about that long to load, and
// Ollama drops a load whose client went away ("client connection closed
// before llama-server finished loading, aborting load"). With the index loaded
// from disk nothing else ever loaded the model, so on 2026-10-18 every query of
// the evening fell back to CAMPAIGN.md. The warm-up embeds one short query
// without that deadline (timeout like the indexer's), so the model gets
// resident and its keep_alive (EMBED_KEEP_ALIVE) is reset. Ollama only — an
// OpenAI-style server keeps its model loaded itself (like llm.js warmUp()).
// Single-flight; never throws; resolves true when the model answered.
const WARM_TIMEOUT_MS = 120_000;
let warming = null;
let warmFailing = false;

async function embedWarm(reason) {
  const embedFn = indexerOptions.embed ?? embed;
  const t0 = Date.now();
  try {
    await embedFn(['warm-up'], { kind: 'query', timeoutMs: WARM_TIMEOUT_MS });
    warmFailing = false;
    debug(`rag: embedding model ${embedModel()} warm (${reason}, ${Date.now() - t0} ms)`);
    return true;
  } catch (e) {
    // Model missing / Ollama down: say it once, not after every query.
    if (warmFailing) debug(`rag: embedding warm-up failed again (${reason}): ${e.message}`);
    else warn(`rag: embedding warm-up failed (${reason}): ${e.message}`);
    warmFailing = true;
    return false;
  }
}

export function warmRag(reason = 'warm-up') {
  if (!ragEnabled() || embedProvider() !== 'ollama') return Promise.resolve(false);
  if (warming) return warming;
  const run = embedWarm(reason).finally(() => { if (warming === run) warming = null; });
  warming = run;
  return run;
}

// ── query path ──────────────────────────────────────────────────────────────

// Reachability state, only used to keep the log readable: warn once when RAG
// queries start failing (a model that was never pulled must not hide behind
// DEBUG), stay quiet while it keeps failing, and log once when it recovers.
let failing = false;

function noteFailure(reason) {
  if (failing) {
    debug(`rag: query failed (degrading to fallback): ${reason}`);
    return;
  }
  failing = true;
  warn(`rag: vault search unavailable (${reason}) — falling back to CAMPAIGN.md until it recovers`);
}

function noteSuccess() {
  if (!failing) return;
  failing = false;
  log('rag: vault search available again');
}

// Semantic vault search. Never throws; resolves to [] when RAG is disabled,
// the query is blank, the index isn't loaded/built yet, the embedding backend
// fails, or the deadline passes. topK is clamped to 1..20 (invalid → 3);
// `scoreThreshold` undefined → RAG_SCORE_THRESHOLD, null → no filter.
export async function queryRag(query, { topK = DEFAULT_TOP_K, scoreThreshold: threshold, timeoutMs: timeoutOverride } = {}) {
  if (!shutDown) reconcile();
  if (!ragEnabled()) return [];
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) return [];
  const indexer = active?.indexer;
  if (!indexer?.ready) {
    debug('rag: index not loaded yet — no vault context for this query');
    return [];
  }

  const limit = Number.isFinite(timeoutOverride) && timeoutOverride > 0
    ? Math.min(timeoutOverride, MAX_TIMEOUT_MS)
    : timeoutMs();
  const ac = new AbortController();
  let timer;
  // The deadline covers the whole query (embedding round-trip + search), also
  // for an embed implementation that ignores the abort signal.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`timeout after ${limit} ms`));
    }, limit);
  });
  try {
    const hits = await Promise.race([
      indexer.query(text, {
        topK: clampTopK(topK),
        threshold: threshold === undefined ? scoreThreshold() : threshold,
        timeoutMs: limit,
        signal: ac.signal,
      }),
      deadline,
    ]);
    noteSuccess();
    // Distances in the debug log are what RAG_SCORE_THRESHOLD is tuned with.
    debug(`rag: query "${text.slice(0, 40)}" → ${hits.length} hit(s) [${hits.map((h) => `${h.source} ${h.distance}`).join(', ')}]`);
    return hits;
  } catch (e) {
    noteFailure(e.message);
    // The aborted embed may have been the one loading the model (see
    // warmRag): load it in the background so the next query finds it ready.
    warmRag('after a failed query');
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Render hits into a compact text block, one chunk per paragraph, each
// prefixed with its source note for traceability.
export function formatRagHits(hits) {
  return (Array.isArray(hits) ? hits : [])
    .filter((r) => r && typeof r.text === 'string' && r.text.trim())
    .map((r) => {
      const src = r.source ? `[Quelle: ${r.source}]\n` : '';
      return `${src}${r.text.trim()}`;
    })
    .join('\n\n');
}

// Effective RAG settings as they are applied + index stats (session_meta).
export function ragConfig() {
  const st = ragStatus();
  return {
    enabled: ragEnabled(),
    provider: embedProvider(),
    model: embedModel(),
    timeoutMs: timeoutMs(),
    scoreThreshold: scoreThreshold(),
    maxChunkChars: maxChunkChars(),
    rescanIntervalMs: rescanIntervalMs(),
    indexDir: indexDir(),
    index: st ? {
      ready: st.ready,
      indexing: st.indexing,
      notes: st.notes,
      chunks: st.chunks,
      lastSyncAt: st.lastSyncAt,
      lastError: st.lastError,
      watcher: st.watcher,
    } : null,
  };
}

// Test hook: forget the reachability state (log de-duplication) and a
// previous stopRag(), i.e. behave like a freshly imported module.
export function _resetState() { failing = false; shutDown = false; warming = null; warmFailing = false; }
