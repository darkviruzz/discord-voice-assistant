"""RAG service for the Obsidian campaign vault.

A small, self-contained FastAPI service that turns a folder of Markdown notes
into a semantic search index. Embeddings are produced by the already-running
Ollama instance (`nomic-embed-text`), vectors are stored in a local, persistent
ChromaDB. A watchdog file-watcher re-indexes notes as they change so the index
stays warm without a manual re-run.

Endpoints
---------
POST /index   – (re)scan VAULT_PATH, chunk every .md by `##` sections, parse
                frontmatter and (re)write the whole collection. Returns
                {"ok": true, "indexed": N, "files": M}.
POST /query   – body {"query": "...", "top_k": 3, "score_threshold": null} →
                [{"text": "...", "source": "...", "distance": 0.0}] (closest
                chunks first). score_threshold (optional, max cosine distance)
                drops hits above it; falls back to RAG_SCORE_THRESHOLD when
                omitted from the request.
GET  /health  – {"ok": true, "indexed": N}.

Environment variables
---------------------
VAULT_PATH    Root of the Obsidian vault to index (required for indexing).
CHROMA_DIR    Directory for the persistent Chroma store (default ./chroma).
OLLAMA_URL    Ollama base URL (default http://localhost:11434).
EMBED_MODEL   Ollama embedding model (default nomic-embed-text).
RAG_PORT      Port for `python -m uvicorn server:app` convenience (default 5001).
RAG_SCORE_THRESHOLD  Max cosine distance for /query hits (0=identical..2=far);
                     empty/unset/invalid/negative = no filtering (default).
                     Overridden per-request by the query body's score_threshold.

Run with:  python -m uvicorn server:app --host 0.0.0.0 --port %RAG_PORT%
"""

import logging
import os
import signal
import threading
from typing import Optional

import requests
import yaml
import chromadb
from fastapi import FastAPI, HTTPException
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


def _parse_score_threshold(raw: Optional[str]) -> Optional[float]:
    """Parse RAG_SCORE_THRESHOLD: empty/unset/invalid/negative → None (no filter)."""
    if not raw or not raw.strip():
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if value >= 0 else None


# Service-wide default max cosine distance for /query hits; a request's own
# score_threshold (see QueryRequest) takes precedence when present. None = off.
RAG_SCORE_THRESHOLD = _parse_score_threshold(os.environ.get("RAG_SCORE_THRESHOLD"))

app = FastAPI(title="discord-voice-assistant RAG")

# Chroma operations come from two threads (HTTP handlers + the file-watcher);
# serialize them behind one lock so a re-index never races a query.
_lock = threading.RLock()
_client = chromadb.PersistentClient(path=CHROMA_DIR)


def _collection():
    return _client.get_or_create_collection(
        COLLECTION, metadata={"hnsw:space": "cosine"}
    )


# ── Embeddings (via Ollama) ──────────────────────────────────────────────────

def embed(text: str) -> list[float]:
    """Embed a single string with the configured Ollama embedding model."""
    res = requests.post(
        f"{OLLAMA_URL}/api/embeddings",
        json={"model": EMBED_MODEL, "prompt": text},
        timeout=60,
    )
    res.raise_for_status()
    vec = res.json().get("embedding")
    if not vec:
        raise RuntimeError("ollama returned an empty embedding")
    return vec


# ── Markdown parsing / chunking ──────────────────────────────────────────────

def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split a leading `--- ... ---` YAML frontmatter block from the body."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    raw = text[3:end].strip()
    body = text[end + 4:].lstrip("\n")
    try:
        meta = yaml.safe_load(raw) or {}
        if not isinstance(meta, dict):
            meta = {}
    except yaml.YAMLError:
        meta = {}
    return meta, body


def _flatten_meta(meta: dict, source: str) -> dict:
    """Chroma metadata values must be scalars — flatten lists/dicts to strings."""
    out = {"source": source}
    for key, value in meta.items():
        if isinstance(value, (str, int, float, bool)):
            out[str(key)] = value
        elif isinstance(value, list):
            out[str(key)] = ", ".join(str(v) for v in value)
        elif value is not None:
            out[str(key)] = str(value)
    return out


def chunk_markdown(text: str, source: str) -> list[dict]:
    """Chunk one note: frontmatter + split the body at every `##` heading.

    Content above the first `##` (the note intro / `#` title) becomes its own
    chunk so short notes aren't lost. Each chunk carries the source path and the
    flattened frontmatter as metadata.
    """
    meta, body = parse_frontmatter(text)
    base_meta = _flatten_meta(meta, source)

    sections: list[tuple[str, list[str]]] = []
    heading = ""
    buf: list[str] = []
    for line in body.splitlines():
        if line.startswith("## "):
            sections.append((heading, buf))
            heading = line.lstrip("# ").strip()
            buf = [line]
        else:
            buf.append(line)
    sections.append((heading, buf))

    chunks = []
    for idx, (head, lines) in enumerate(sections):
        section_text = "\n".join(lines).strip()
        if not section_text:
            continue
        meta = dict(base_meta)
        if head:
            meta["heading"] = head
        chunks.append({
            "id": f"{source}::{idx}",
            "text": section_text,
            "metadata": meta,
        })
    return chunks


def _iter_markdown(root: str):
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if name.lower().endswith(".md"):
                full = os.path.join(dirpath, name)
                yield full, os.path.relpath(full, root).replace("\\", "/")


# ── Index operations ─────────────────────────────────────────────────────────

def index_file(path: str, source: str) -> int:
    """(Re)index a single note: drop its old chunks, add the current ones."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        log.warning("cannot read %s: %s", path, exc)
        return 0
    chunks = chunk_markdown(text, source)
    with _lock:
        col = _collection()
        col.delete(where={"source": source})
        if chunks:
            col.add(
                ids=[c["id"] for c in chunks],
                documents=[c["text"] for c in chunks],
                embeddings=[embed(c["text"]) for c in chunks],
                metadatas=[c["metadata"] for c in chunks],
            )
    return len(chunks)


def remove_file(source: str) -> None:
    with _lock:
        _collection().delete(where={"source": source})


def reindex_all() -> dict:
    """Wipe and rebuild the whole collection from VAULT_PATH."""
    if not VAULT_PATH or not os.path.isdir(VAULT_PATH):
        raise HTTPException(status_code=400, detail=f"VAULT_PATH not a directory: {VAULT_PATH!r}")
    with _lock:
        # Recreate the collection so stale/renamed notes don't linger.
        try:
            _client.delete_collection(COLLECTION)
        except Exception:  # noqa: BLE001 — first run: collection doesn't exist yet
            pass
        col = _collection()
        files = 0
        indexed = 0
        for full, source in _iter_markdown(VAULT_PATH):
            chunks = chunk_markdown(open(full, "r", encoding="utf-8").read(), source)
            files += 1
            if not chunks:
                continue
            col.add(
                ids=[c["id"] for c in chunks],
                documents=[c["text"] for c in chunks],
                embeddings=[embed(c["text"]) for c in chunks],
                metadatas=[c["metadata"] for c in chunks],
            )
            indexed += len(chunks)
    log.info("reindex: %d chunks from %d files", indexed, files)
    return {"ok": True, "indexed": indexed, "files": files}


# ── File-watcher ─────────────────────────────────────────────────────────────

class _VaultHandler(FileSystemEventHandler):
    """Debounced re-index of individual notes on change/create/delete/move."""

    def __init__(self):
        self._timers: dict[str, threading.Timer] = {}

    def _rel(self, path: str) -> Optional[str]:
        if not path.lower().endswith(".md"):
            return None
        return os.path.relpath(path, VAULT_PATH).replace("\\", "/")

    def _schedule(self, path: str, deleted: bool = False):
        source = self._rel(path)
        if source is None:
            return
        old = self._timers.pop(source, None)
        if old:
            old.cancel()

        def run():
            try:
                if deleted:
                    remove_file(source)
                    log.info("watch: removed %s", source)
                else:
                    n = index_file(path, source)
                    log.info("watch: reindexed %s (%d chunks)", source, n)
            except Exception as exc:  # noqa: BLE001 — watcher must never crash
                log.warning("watch: failed for %s: %s", source, exc)

        timer = threading.Timer(1.0, run)
        self._timers[source] = timer
        timer.daemon = True
        timer.start()

    def on_modified(self, event):
        if not event.is_directory:
            self._schedule(event.src_path)

    def on_created(self, event):
        if not event.is_directory:
            self._schedule(event.src_path)

    def on_deleted(self, event):
        if not event.is_directory:
            self._schedule(event.src_path, deleted=True)

    def on_moved(self, event):
        if not event.is_directory:
            self._schedule(event.src_path, deleted=True)
            self._schedule(event.dest_path)


_observer: Optional[Observer] = None


def _start_watcher():
    global _observer
    if not VAULT_PATH or not os.path.isdir(VAULT_PATH):
        log.warning("VAULT_PATH not set or missing — file-watcher disabled")
        return
    _observer = Observer()
    _observer.schedule(_VaultHandler(), VAULT_PATH, recursive=True)
    _observer.daemon = True
    _observer.start()
    log.info("file-watcher started on %s", VAULT_PATH)


# ── Request schemas ──────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    query: str
    top_k: int = Field(default=3, ge=1, le=20)
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
            item["distance"] = round(dist, 4)
        out.append(item)
    return out


# ── Lifecycle ────────────────────────────────────────────────────────────────

@app.on_event("startup")
def _startup():
    _start_watcher()
    # Index in the background so the service comes up immediately even when the
    # vault is large (every chunk costs one Ollama embedding call).
    if VAULT_PATH and os.path.isdir(VAULT_PATH) and _collection().count() == 0:
        def warm():
            try:
                reindex_all()
            except Exception as exc:  # noqa: BLE001
                log.warning("startup index failed: %s", exc)
        threading.Thread(target=warm, daemon=True).start()


@app.on_event("shutdown")
def _shutdown_event():
    if _observer:
        _observer.stop()


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.post("/index")
def index() -> dict:
    return reindex_all()


@app.post("/query")
def query(req: QueryRequest) -> list[dict]:
    text = req.query.strip()
    if not text:
        return []
    with _lock:
        col = _collection()
        if col.count() == 0:
            return []
        vec = embed(text)
        res = col.query(
            query_embeddings=[vec],
            n_results=req.top_k,
            include=["documents", "metadatas", "distances"],
        )
    docs = (res.get("documents") or [[]])[0]
    metas = (res.get("metadatas") or [[]])[0]
    dists_raw = res.get("distances")
    dists = dists_raw[0] if dists_raw else None
    threshold = req.score_threshold if req.score_threshold is not None else RAG_SCORE_THRESHOLD
    return _apply_threshold(docs, metas, dists, threshold)


@app.get("/health")
def health() -> dict:
    try:
        n = _collection().count()
    except Exception:  # noqa: BLE001
        n = 0
    return {"ok": True, "indexed": n}


@app.post("/shutdown")
def shutdown() -> dict:
    if _observer:
        _observer.stop()
    os.kill(os.getpid(), signal.SIGINT)
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("RAG_PORT", "5001")))
