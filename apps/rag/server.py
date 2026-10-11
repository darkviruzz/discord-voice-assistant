"""RAG service for the Obsidian campaign vault.

A small, self-contained FastAPI service that turns a folder of Markdown notes
into a semantic search index. Embeddings are produced by the already-running
Ollama instance (`nomic-embed-text`), vectors are stored in a local, persistent
ChromaDB. A watchdog file-watcher re-indexes notes as they change so the index
stays warm without a manual re-run.

Endpoints
---------
POST /index   – (re)scan VAULT_PATH, chunk every .md by `##` sections, parse
                frontmatter and bring the collection in sync with the vault
                (changed notes re-embedded, unchanged ones skipped, chunks of
                deleted/renamed notes dropped). Returns
                {"ok": true, "indexed": N, "files": M, "failed": F}.
                400 when VAULT_PATH is missing, 503 when Ollama can't embed.
POST /query   – body {"query": "...", "top_k": 3, "score_threshold": null} →
                [{"text": "...", "source": "...", "distance": 0.0}] (closest
                chunks first). score_threshold (optional, max cosine distance)
                drops hits above it; falls back to RAG_SCORE_THRESHOLD when
                omitted from the request. top_k is clamped to 1..20.
                503 when Ollama can't embed the query.
GET  /health  – {"ok": true, "indexed": N, "indexing": bool, "vault": bool,
                 "ollama": true|false|null, "last_error": str|null}.
                "ok" covers the process + vector store (503 + ok:false when
                Chroma is unusable); Ollama/indexing state is reported, not
                gated on, so a slow model pull doesn't flap the container.

Environment variables
---------------------
VAULT_PATH    Root of the Obsidian vault to index (required for indexing).
CHROMA_DIR    Directory for the persistent Chroma store (default ./chroma).
OLLAMA_URL    Ollama base URL (default http://localhost:11434).
EMBED_MODEL   Ollama embedding model (default nomic-embed-text). Changing it
              drops and rebuilds the collection on the next start.
RAG_EMBED_KEEP_ALIVE  How long Ollama keeps the embedding model loaded after a
                      call (default 30m; Ollama's own default is 5m, after which
                      the first query pays a cold load). Empty = Ollama default.
RAG_PORT     Port for `python -m uvicorn server:app` convenience (default 5001).
RAG_SCORE_THRESHOLD  Max cosine distance for /query hits (0=identical..2=far);
                     empty/unset/invalid/negative = no filtering (default).
                     Overridden per-request by the query body's score_threshold.
RAG_MAX_CHUNK_CHARS  Upper bound for one chunk's text (default 2000). Longer
                     `##` sections are split at paragraph/line boundaries so a
                     single hit can't flood the LLM prompt.

Run with:  python -m uvicorn server:app --host 0.0.0.0 --port %RAG_PORT%
"""

import hashlib
import logging
import os
import re
import signal
import threading
from contextlib import asynccontextmanager
from typing import Optional

import requests
import yaml
import chromadb
from chromadb.config import Settings
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("rag")

# ── Configuration ────────────────────────────────────────────────────────────

VAULT_PATH  = os.environ.get("VAULT_PATH", "")
CHROMA_DIR  = os.environ.get("CHROMA_DIR", os.path.join(os.path.dirname(__file__), "chroma"))
OLLAMA_URL  = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "nomic-embed-text")
COLLECTION  = "vault"

# /query top_k is clamped to this instead of rejecting larger values with a 422
# (the Node client treats any non-2xx as "no context" — silently).
MAX_TOP_K = 20
# Notes larger than this are skipped (logged) — a multi-MB export dumped into
# the vault would otherwise cost hundreds of embedding calls per edit.
MAX_FILE_BYTES = 2 * 1024 * 1024
# Bump when chunk_markdown()'s output changes so every note is re-embedded once.
CHUNKER_VERSION = "2"
# Ollama timeouts (s): indexing tolerates a cold model load, a query doesn't
# need to wait longer than the Node client (which gives up after ~800 ms).
EMBED_TIMEOUT_INDEX = 60
EMBED_TIMEOUT_QUERY = 10
# First retry delay (s) of the startup indexer; doubles up to 5 minutes.
WARM_RETRY_S = 5.0
# Task prefixes some embedding models are trained with: (indexed text, query).
# nomic-embed-text retrieves noticeably better with them. Part of the note
# digest, so changing them re-embeds every note on the next sync.
_TASK_PREFIXES = {
    "nomic-embed-text": ("search_document: ", "search_query: "),
}


def _parse_score_threshold(raw: Optional[str]) -> Optional[float]:
    """Parse RAG_SCORE_THRESHOLD: empty/unset/invalid/negative → None (no filter)."""
    if not raw or not raw.strip():
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if value >= 0 else None


def _parse_positive_int(raw: Optional[str], default: int) -> int:
    try:
        value = int(raw) if raw and raw.strip() else default
    except ValueError:
        return default
    return value if value > 0 else default


# Service-wide default max cosine distance for /query hits; a request's own
# score_threshold (see QueryRequest) takes precedence when present. None = off.
RAG_SCORE_THRESHOLD = _parse_score_threshold(os.environ.get("RAG_SCORE_THRESHOLD"))
MAX_CHUNK_CHARS = _parse_positive_int(os.environ.get("RAG_MAX_CHUNK_CHARS"), 2000)


def _parse_keep_alive(raw: Optional[str]):
    """Ollama takes a duration string ("30m") or a number of seconds (-1 = forever)."""
    raw = (raw or "").strip()
    if not raw:
        return None
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    return raw


EMBED_KEEP_ALIVE = _parse_keep_alive(os.environ.get("RAG_EMBED_KEEP_ALIVE", "30m"))


class EmbeddingUnavailable(RuntimeError):
    """Ollama could not produce an embedding (down, model not pulled, bad reply)."""


class VaultUnavailable(RuntimeError):
    """VAULT_PATH is unset or not a directory."""


# ── Shared state ─────────────────────────────────────────────────────────────

# Chroma operations come from several threads (HTTP handlers, the watcher's
# debounce timers, the startup indexer); serialize them behind one lock. It is
# held ONLY around Chroma calls — never across an Ollama round-trip — so a long
# re-index never blocks /query or /health.
_lock = threading.RLock()
# One full vault scan at a time (startup warm-up vs. POST /index).
_reindex_lock = threading.Lock()
# Per-note locks: read → embed → write of one note must not interleave with
# another update of the same note, or an older read could land last.
_source_locks: dict[str, threading.RLock] = {}
_source_locks_guard = threading.Lock()
# Set on shutdown: stops the startup retry loop.
_stop = threading.Event()

_client = None
_col = None
_state = {"indexing": False, "ollama": None, "last_error": None}


def _source_lock(source: str) -> threading.RLock:
    with _source_locks_guard:
        lock = _source_locks.get(source)
        if lock is None:
            lock = _source_locks[source] = threading.RLock()
        return lock


def _get_client():
    """Lazily open the persistent store (keeps import side-effect free)."""
    global _client
    if _client is None:
        os.makedirs(CHROMA_DIR, exist_ok=True)
        _client = chromadb.PersistentClient(
            path=CHROMA_DIR, settings=Settings(anonymized_telemetry=False)
        )
    return _client


def _collection():
    """Return the vault collection, (re)creating it when its setup is stale.

    The collection records the embedding model it was built with. A different
    EMBED_MODEL (other vector dimension / space) or a non-cosine distance
    metric can't be mixed with the stored vectors, so the collection is dropped
    and the startup indexer rebuilds it. Callers must hold `_lock`.
    """
    global _col
    if _col is not None:
        return _col
    client = _get_client()
    wanted = {"hnsw:space": "cosine", "embed_model": EMBED_MODEL}
    try:
        col = client.get_collection(COLLECTION)
    except Exception:  # noqa: BLE001 — NotFoundError (type differs across Chroma versions)
        col = None
    if col is not None:
        meta = col.metadata or {}
        if any(meta.get(k) != v for k, v in wanted.items()):
            log.warning(
                "collection %r was built with %s — dropping it for a rebuild with %s",
                COLLECTION, meta, wanted,
            )
            client.delete_collection(COLLECTION)
            col = None
    if col is None:
        col = client.create_collection(COLLECTION, metadata=wanted)
    _col = col
    return col


# ── Embeddings (via Ollama) ──────────────────────────────────────────────────

def _task_prefix(kind: str) -> str:
    """Model-specific task prefix for `kind` ("document" or "query")."""
    name = EMBED_MODEL.rsplit("/", 1)[-1].split(":", 1)[0]
    for model, (doc, query) in _TASK_PREFIXES.items():
        if name.startswith(model):
            return query if kind == "query" else doc
    return ""


def embed(text: str, timeout: float = EMBED_TIMEOUT_INDEX, kind: str = "document") -> list[float]:
    """Embed a single string with the configured Ollama embedding model.

    `kind` selects the model's task prefix (indexed chunk vs. search query).
    Every failure (connection refused, timeout, HTTP error such as "model not
    found", malformed/empty reply) is raised as EmbeddingUnavailable so callers
    can tell "Ollama is the problem" apart from bugs.
    """
    payload = {"model": EMBED_MODEL, "prompt": _task_prefix(kind) + text}
    if EMBED_KEEP_ALIVE is not None:
        payload["keep_alive"] = EMBED_KEEP_ALIVE
    try:
        res = requests.post(
            f"{OLLAMA_URL}/api/embeddings",
            json=payload,
            timeout=timeout,
        )
        if res.status_code >= 400:
            raise EmbeddingUnavailable(
                f"ollama HTTP {res.status_code}: {res.text.strip()[:200]}"
            )
        vec = res.json().get("embedding")
    except EmbeddingUnavailable as exc:
        _note_ollama(False, str(exc))
        raise
    except (requests.RequestException, ValueError, AttributeError) as exc:
        _note_ollama(False, str(exc))
        raise EmbeddingUnavailable(f"ollama embedding request failed: {exc}") from exc
    if not vec:
        _note_ollama(False, "ollama returned an empty embedding")
        raise EmbeddingUnavailable("ollama returned an empty embedding")
    _note_ollama(True)
    return vec


def _note_ollama(ok: bool, error: Optional[str] = None) -> None:
    _state["ollama"] = ok
    if not ok:
        _state["last_error"] = error


# ── Markdown parsing / chunking ──────────────────────────────────────────────

# Opening `---` line, YAML, closing `---` (or `...`) line — each delimiter must
# be a line of its own, so `----` or a `--- text` line never counts.
_FRONTMATTER_RE = re.compile(
    r"\A---[ \t]*\r?\n(.*?)(?:\r?\n)?^(?:---|\.\.\.)[ \t]*(?:\r?\n|\Z)",
    re.DOTALL | re.MULTILINE,
)
_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split a leading `--- ... ---` YAML frontmatter block from the body.

    Anything that isn't a YAML mapping (invalid YAML, a list, or a note that
    merely opens with a `---` horizontal rule) is NOT frontmatter: the text is
    returned unchanged so no note content is ever dropped.
    """
    if text.startswith("﻿"):
        text = text[1:]
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    raw = m.group(1)
    try:
        meta = yaml.safe_load(raw) if raw.strip() else {}
    except yaml.YAMLError:
        return {}, text
    if meta is None:
        meta = {}
    if not isinstance(meta, dict):
        return {}, text
    return meta, text[m.end():].lstrip("\r\n")


# Chroma stores ints as int64; anything outside is stringified instead of
# failing the whole note's insert.
_INT64_MIN, _INT64_MAX = -(2 ** 63), 2 ** 63 - 1


def _flatten_meta(meta: dict, source: str) -> dict:
    """Chroma metadata values must be scalars — flatten lists/dicts to strings.

    `source` is set LAST: it is the key every delete/update filters on, so a
    frontmatter field that happens to be called `source:` must never shadow it
    (its chunks would otherwise never be cleaned up again).
    """
    out = {}
    for key, value in meta.items():
        key = str(key)
        if not key or key.startswith("chroma:"):
            continue  # empty / Chroma-reserved keys are rejected on insert
        if isinstance(value, bool) or isinstance(value, str):
            out[key] = value
        elif isinstance(value, int):
            out[key] = value if _INT64_MIN <= value <= _INT64_MAX else str(value)
        elif isinstance(value, float):
            out[key] = value if value == value and abs(value) != float("inf") else str(value)
        elif isinstance(value, list):
            out[key] = ", ".join(str(v) for v in value)
        elif value is not None:
            out[key] = str(value)
    out["source"] = source
    return out


def _split_long(text: str, limit: int) -> list[str]:
    """Split `text` into pieces of at most `limit` chars.

    Prefers paragraph boundaries, then line boundaries, then whitespace; only a
    single unbroken run longer than `limit` is cut mid-word.
    """
    if len(text) <= limit:
        return [text]
    units: list[str] = []
    for para in re.split(r"\n[ \t]*\n", text):
        para = para.strip("\n")
        if not para.strip():
            continue
        if len(para) <= limit:
            units.append(para)
            continue
        for line in para.split("\n"):
            while len(line) > limit:
                cut = line.rfind(" ", 0, limit)
                if cut <= 0:
                    cut = limit
                units.append(line[:cut])
                line = line[cut:].lstrip(" ")
            if line.strip():
                units.append(line)
    pieces: list[str] = []
    cur = ""
    for unit in units:
        if cur and len(cur) + 2 + len(unit) > limit:
            pieces.append(cur)
            cur = unit
        else:
            cur = f"{cur}\n\n{unit}" if cur else unit
    if cur:
        pieces.append(cur)
    return pieces


def chunk_markdown(text: str, source: str, max_chars: Optional[int] = None) -> list[dict]:
    """Chunk one note: frontmatter + split the body at every `##` heading.

    Content above the first `##` (the note intro / `#` title) becomes its own
    chunk so short notes aren't lost. `##` lines inside fenced code blocks don't
    split. A section longer than `max_chars` is split further; continuation
    pieces repeat the `## heading` line so they still embed with their topic.
    Each chunk carries the source path and the flattened frontmatter as
    metadata. IDs are `<source>::<n>` (n = 0.. in note order): unique across the
    vault and stable as long as the note's content doesn't change.
    """
    limit = max_chars or MAX_CHUNK_CHARS
    meta, body = parse_frontmatter(text)
    base_meta = _flatten_meta(meta, source)

    sections: list[tuple[str, list[str]]] = []
    heading = ""
    buf: list[str] = []
    fence: Optional[str] = None
    for line in body.splitlines():
        m = _FENCE_RE.match(line)
        if m:
            marker = m.group(1)[0]
            if fence is None:
                fence = marker
            elif marker == fence:
                fence = None
        elif fence is None and line.startswith("## "):
            sections.append((heading, buf))
            heading = line[3:].strip()
            buf = [line]
            continue
        buf.append(line)
    sections.append((heading, buf))

    chunks = []
    for head, lines in sections:
        section_text = "\n".join(lines).strip()
        if not section_text:
            continue
        # Leave room for the repeated heading line on continuation pieces.
        budget = max(limit - (len(head) + 4 if head else 0), limit // 2, 1)
        for part_no, part in enumerate(_split_long(section_text, budget)):
            if part_no > 0 and head:
                part = f"## {head}\n{part}"
            chunk_meta = dict(base_meta)
            if head:
                chunk_meta["heading"] = head
            chunks.append({
                "id": f"{source}::{len(chunks)}",
                "text": part,
                "metadata": chunk_meta,
            })
    return chunks


def _is_hidden(source: str) -> bool:
    """True for paths inside dot-directories (.obsidian, .trash, .git, …)."""
    return any(part.startswith(".") for part in source.split("/"))


def _iter_markdown(root: str):
    for dirpath, dirs, files in os.walk(root):
        # Skip Obsidian's config/trash and other dot-dirs: notes moved to the
        # vault's .trash must not resurface as RAG context.
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if name.lower().endswith(".md") and not name.startswith("."):
                full = os.path.join(dirpath, name)
                yield full, os.path.relpath(full, root).replace("\\", "/")


def _read_note(path: str) -> Optional[str]:
    """Read a note as text; None when it can't be read (keep its old chunks).

    utf-8-sig drops a BOM (which would hide the frontmatter); undecodable bytes
    (e.g. a cp1252 note) are replaced instead of aborting the whole index.
    Oversized files yield "" so their chunks are dropped, not left stale.
    """
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            log.warning("skipping %s: larger than %d bytes", path, MAX_FILE_BYTES)
            return ""
        with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
            return fh.read()
    except OSError as exc:
        log.warning("cannot read %s: %s", path, exc)
        return None


def _note_digest(text: str) -> str:
    """Fingerprint of a note + everything that shapes its stored vectors."""
    h = hashlib.sha256()
    for part in (EMBED_MODEL, _task_prefix("document"), CHUNKER_VERSION,
                 str(MAX_CHUNK_CHARS), text):
        h.update(part.encode("utf-8", "surrogatepass"))
        h.update(b"\0")
    return h.hexdigest()


# ── Index operations ─────────────────────────────────────────────────────────

def index_file(path: str, source: str) -> int:
    """(Re)index a single note: replace its chunks with the current ones.

    Skips the embedding round-trips when the note is unchanged since its last
    indexing. All embeddings are computed BEFORE the old chunks are touched, so
    an Ollama failure (EmbeddingUnavailable) leaves the note's previous chunks
    searchable. Returns the note's chunk count.
    """
    with _source_lock(source):
        text = _read_note(path)
        if text is None:
            return 0
        digest = _note_digest(text)
        with _lock:
            existing = _collection().get(where={"source": source}, include=["metadatas"])
        metas = existing.get("metadatas") or []
        if metas and all((m or {}).get("rag_hash") == digest for m in metas):
            return len(metas)

        chunks = chunk_markdown(text, source)
        embeddings = [embed(c["text"]) for c in chunks]
        with _lock:
            col = _collection()
            col.delete(where={"source": source})
            if chunks:
                col.add(
                    ids=[c["id"] for c in chunks],
                    documents=[c["text"] for c in chunks],
                    embeddings=embeddings,
                    metadatas=[{**c["metadata"], "rag_hash": digest} for c in chunks],
                )
        return len(chunks)


def remove_file(source: str) -> None:
    with _source_lock(source), _lock:
        _collection().delete(where={"source": source})


def sync_path(path: str, source: str) -> int:
    """Bring one note's chunks in line with the file's CURRENT state on disk.

    Used by the watcher instead of trusting the event type: whatever happened
    (edit, create, delete, rename, atomic save via temp file), the final file
    state decides — so late or out-of-order events can't leave stale chunks.
    """
    with _source_lock(source):
        if os.path.isfile(path):
            return index_file(path, source)
        remove_file(source)
        return 0


def _vault_ok() -> bool:
    return bool(VAULT_PATH) and os.path.isdir(VAULT_PATH)


def _prune_stale() -> int:
    """Drop chunks of notes that no longer exist (deleted/renamed/now hidden)."""
    with _lock:
        metas = _collection().get(include=["metadatas"]).get("metadatas") or []
    sources = {(m or {}).get("source") for m in metas} - {None, ""}
    removed = 0
    for source in sources:
        path = os.path.join(VAULT_PATH, source)
        with _source_lock(source):
            # Re-checked under the note's lock: a note the watcher has just
            # (re)created must not be pruned.
            if _is_hidden(source) or not os.path.isfile(path):
                remove_file(source)
                removed += 1
    return removed


def reindex_all() -> dict:
    """Sync the whole collection with VAULT_PATH (incremental, non-destructive).

    Every note is (re)indexed via index_file (unchanged notes are skipped), then
    chunks of notes that disappeared are pruned. The index is never wiped up
    front: if Ollama goes away mid-run, EmbeddingUnavailable is raised and the
    notes not yet processed keep their previous chunks. A single unreadable or
    un-insertable note is logged and skipped instead of failing the whole run.
    """
    if not _vault_ok():
        raise VaultUnavailable(f"VAULT_PATH not a directory: {VAULT_PATH!r}")
    with _reindex_lock:
        _state["indexing"] = True
        try:
            files = indexed = failed = 0
            for full, source in _iter_markdown(VAULT_PATH):
                files += 1
                try:
                    indexed += index_file(full, source)
                except EmbeddingUnavailable:
                    raise
                except Exception as exc:  # noqa: BLE001 — one bad note must not stop the scan
                    failed += 1
                    log.warning("index: skipped %s: %s", source, exc)
            pruned = _prune_stale()
        finally:
            _state["indexing"] = False
    log.info("reindex: %d chunks from %d files (%d failed, %d stale pruned)",
             indexed, files, failed, pruned)
    return {"ok": True, "indexed": indexed, "files": files, "failed": failed}


# ── File-watcher ─────────────────────────────────────────────────────────────

class _VaultHandler(FileSystemEventHandler):
    """Debounced re-sync of individual notes on change/create/delete/move.

    Watchdog delivers events on its single observer thread, so `_timers` is
    only touched from there; the timer callbacks run on their own threads and
    are serialized per note by sync_path's per-source lock.
    """

    DEBOUNCE_S = 1.0
    _FULL = "\0full-rescan"

    def __init__(self):
        self._timers: dict[str, threading.Timer] = {}

    def _rel(self, path: str) -> Optional[str]:
        if not path.lower().endswith(".md"):
            return None
        source = os.path.relpath(path, VAULT_PATH).replace("\\", "/")
        if source.startswith("../") or _is_hidden(source):
            return None
        return source

    def _debounce(self, key: str, fn) -> None:
        old = self._timers.pop(key, None)
        if old:
            old.cancel()

        def run():
            # Drop our own entry so the dict doesn't grow with every note ever
            # touched (only if no newer timer replaced it meanwhile).
            if self._timers.get(key) is timer:
                self._timers.pop(key, None)
            try:
                fn()
            except Exception as exc:  # noqa: BLE001 — watcher must never crash
                log.warning("watch: failed for %s: %s", key, exc)

        timer = threading.Timer(self.DEBOUNCE_S, run)
        timer.daemon = True
        self._timers[key] = timer
        timer.start()

    def _schedule(self, path: str):
        source = self._rel(path)
        if source is None:
            return

        def run():
            n = sync_path(path, source)
            log.info("watch: synced %s (%d chunks)", source, n)

        self._debounce(source, run)

    def _schedule_full(self):
        # Directory moved/deleted: per-file events aren't guaranteed on every
        # platform, so reconcile the whole vault (cheap — unchanged notes skip).
        self._debounce(self._FULL, reindex_all)

    def on_modified(self, event):
        if not event.is_directory:
            self._schedule(event.src_path)

    def on_created(self, event):
        if not event.is_directory:
            self._schedule(event.src_path)

    def on_deleted(self, event):
        if event.is_directory:
            self._schedule_full()
        else:
            self._schedule(event.src_path)

    def on_moved(self, event):
        if event.is_directory:
            self._schedule_full()
        else:
            self._schedule(event.src_path)
            self._schedule(event.dest_path)


_observer: Optional[Observer] = None


def _start_watcher():
    global _observer
    if not _vault_ok():
        log.warning("VAULT_PATH not set or missing — file-watcher disabled")
        return
    try:
        _observer = Observer()
        _observer.schedule(_VaultHandler(), VAULT_PATH, recursive=True)
        _observer.daemon = True
        _observer.start()
    except Exception as exc:  # noqa: BLE001 — e.g. inotify watch limit; serve anyway
        _observer = None
        log.warning("file-watcher could not start (%s) — use POST /index after edits", exc)
        return
    log.info("file-watcher started on %s", VAULT_PATH)


def _stop_watcher():
    global _observer
    if _observer:
        _observer.stop()
        _observer = None


def _warm_index():
    """Startup sync with retry: Ollama may still be starting / pulling the model.

    Runs on every start (not only on an empty store) so notes changed while the
    service was down are picked up; unchanged notes cost no embedding calls.
    """
    delay = WARM_RETRY_S
    while not _stop.is_set():
        try:
            reindex_all()
            return
        except VaultUnavailable as exc:
            log.warning("startup index skipped: %s", exc)
            return
        except Exception as exc:  # noqa: BLE001 — Ollama down, store busy, …
            _state["last_error"] = str(exc)
            log.warning("startup index failed (retry in %.0fs): %s", delay, exc)
        if _stop.wait(delay):
            return
        delay = min(delay * 2, 300.0)


# ── Request schemas ──────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    query: str
    # Values above MAX_TOP_K are clamped in /query (not rejected).
    top_k: int = Field(default=3, ge=1)
    # Per-request max cosine distance; overrides RAG_SCORE_THRESHOLD when set.
    score_threshold: Optional[float] = Field(default=None, ge=0)


# ── Query filtering ──────────────────────────────────────────────────────────

def _apply_threshold(
    docs: list[str],
    metas: list[Optional[dict]],
    dists: Optional[list[Optional[float]]],
    threshold: Optional[float],
) -> list[dict]:
    """Zip Chroma's parallel /query result lists into response items.

    Drops hits whose cosine distance exceeds `threshold` (smaller = more
    similar; None = no filtering). Pure and Chroma/FastAPI-free so it is
    testable on its own. `dists` may be None or contain None entries — older
    Chroma versions may omit distances, or a single hit may lack one; either
    way the hit is kept (we can't judge it) and its "distance" key is left out.
    """
    if dists is None:
        dists = [None] * len(docs)
    out = []
    for doc, meta, dist in zip(docs, metas, dists):
        if threshold is not None and dist is not None and dist > threshold:
            continue
        item = {"text": doc, "source": (meta or {}).get("source", "")}
        if dist is not None:
            # float(): some Chroma builds hand back numpy scalars, which the
            # JSON response encoder can't serialize.
            item["distance"] = round(float(dist), 4)
        out.append(item)
    return out


# ── Lifecycle ────────────────────────────────────────────────────────────────

@asynccontextmanager
async def _lifespan(_app: FastAPI):
    _stop.clear()
    _start_watcher()
    # Index in the background so the service (and its healthcheck) comes up
    # immediately even when the vault is large or Ollama isn't ready yet.
    if _vault_ok():
        threading.Thread(target=_warm_index, name="rag-warm", daemon=True).start()
    else:
        log.warning("VAULT_PATH not set or missing — nothing to index: %r", VAULT_PATH)
    try:
        yield
    finally:
        _stop.set()
        _stop_watcher()


app = FastAPI(title="discord-voice-assistant RAG", lifespan=_lifespan)


# ── Endpoints ────────────────────────────────────────────────────────────────
# Plain `def` (not `async def`) on purpose: Ollama HTTP and Chroma calls are
# blocking, so FastAPI runs these handlers in its threadpool instead of
# stalling the event loop.

@app.post("/index")
def index() -> dict:
    try:
        return reindex_all()
    except VaultUnavailable as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except EmbeddingUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"embedding failed: {exc}") from exc


@app.post("/query")
def query(req: QueryRequest) -> list[dict]:
    text = req.query.strip()
    if not text:
        return []
    with _lock:
        n = _collection().count()
    if n == 0:
        return []
    try:
        vec = embed(text, timeout=EMBED_TIMEOUT_QUERY, kind="query")
    except EmbeddingUnavailable as exc:
        raise HTTPException(status_code=503, detail=f"embedding failed: {exc}") from exc
    with _lock:
        res = _collection().query(
            query_embeddings=[vec],
            n_results=max(1, min(req.top_k, MAX_TOP_K, n)),
            include=["documents", "metadatas", "distances"],
        )
    docs = (res.get("documents") or [[]])[0]
    metas = (res.get("metadatas") or [[]])[0]
    dists_raw = res.get("distances")
    dists = dists_raw[0] if dists_raw else None
    threshold = req.score_threshold if req.score_threshold is not None else RAG_SCORE_THRESHOLD
    return _apply_threshold(docs, metas, dists, threshold)


@app.get("/health")
def health():
    body = {
        "ok": True,
        "indexed": 0,
        "indexing": _state["indexing"],
        "vault": _vault_ok(),
        "ollama": _state["ollama"],
        "last_error": _state["last_error"],
    }
    try:
        with _lock:
            body["indexed"] = _collection().count()
    except Exception as exc:  # noqa: BLE001 — store unusable (permissions, corruption)
        body["ok"] = False
        body["last_error"] = f"chroma: {exc}"
        return JSONResponse(status_code=503, content=body)
    return body


@app.post("/shutdown")
def shutdown() -> dict:
    _stop.set()
    _stop_watcher()
    # Raise SIGINT in-process shortly after this response is sent: uvicorn's
    # handler then shuts down gracefully. (os.kill(pid, SIGINT) would instead
    # hard-terminate on Windows via TerminateProcess, before replying.)
    threading.Timer(0.2, signal.raise_signal, args=(signal.SIGINT,)).start()
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("RAG_PORT", "5001")))
