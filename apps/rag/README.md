# RAG service (`apps/rag/`)

Semantic search over the Obsidian campaign vault. A standalone FastAPI process
(its own port, its own lifecycle) that the Node server queries over HTTP; if it
is down the server silently falls back to the static `CAMPAIGN.md`.

## How it works

1. **Scan** – every `.md` under `VAULT_PATH` is read, its YAML frontmatter is
   parsed, and the body is chunked at each `##` heading (not inside fenced
   code blocks). Sections longer than `RAG_MAX_CHUNK_CHARS` are split further
   so a single hit can't flood the LLM prompt. Dot-directories (`.obsidian`,
   `.trash`, `.git`, …) are skipped, so notes in Obsidian's trash never come
   back as context. Non-UTF-8 bytes are replaced instead of failing the scan;
   notes over 2 MiB are skipped.
2. **Embed** – each chunk is embedded with the already-running Ollama
   (`nomic-embed-text`, with its `search_document:` / `search_query:` task
   prefixes), so no extra model server is needed.
3. **Store** – vectors land in a local, persistent ChromaDB (`CHROMA_DIR`,
   cosine distance). Each note's chunks carry a content hash, so a re-scan
   only re-embeds notes that actually changed; chunks of deleted/renamed notes
   are pruned. Changing `EMBED_MODEL` drops the collection and rebuilds it.
4. **Watch** – a `watchdog` file-watcher re-syncs individual notes (debounced)
   as they change, so the index stays current without a manual re-run.

On every start the service syncs the vault in the background (also catching
edits made while it was down) and retries with backoff while Ollama or the
embedding model isn't available yet — the HTTP API is up immediately.

## Endpoints

| Method | Path      | Body / result |
|--------|-----------|---------------|
| `POST` | `/index`  | sync the collection with the vault → `{ ok, indexed, files, failed }`; `400` without a vault, `503` when Ollama can't embed (already-indexed notes stay searchable) |
| `POST` | `/query`  | `{ "query": "...", "top_k": 3, "score_threshold": 0.4 }` → `[{ "text", "source", "distance" }]`; `top_k` is clamped to 1..20; `503` when Ollama can't embed the query |
| `GET`  | `/health` | `{ "ok": true, "indexed": N, "indexing": bool, "vault": bool, "ollama": bool\|null, "last_error": str\|null }`; `503` + `ok:false` only when the vector store is unusable |
| `POST` | `/shutdown` | graceful stop (used by `scripts/Start-VoiceAssistant.ps1`) |

`score_threshold` (optional, max cosine distance — smaller means more similar)
drops hits above it; when omitted it falls back to the `RAG_SCORE_THRESHOLD`
env var below. Each result's `distance` is the cosine distance to the query;
it is left out when the running Chroma version doesn't report one.

The API has no authentication: keep the port private (the Compose stack does
not publish it; for a local run prefer `--host 127.0.0.1`).

## Setup

```sh
ollama pull nomic-embed-text
pip install -r apps/rag/requirements.txt
```

## Run

```sh
# VAULT_PATH=... CHROMA_DIR=... OLLAMA_URL=... RAG_PORT=5001
python -m uvicorn server:app --host 0.0.0.0 --port 5001
```

On Windows the service is started together with the others by
`scripts/Start-VoiceAssistant.ps1`.

## Tests

```sh
pip install -r apps/rag/requirements.txt -r apps/rag/requirements-dev.txt
pytest apps/rag/tests -q
```

No Ollama needed: the suite stubs the embedding call and runs a real ChromaDB
in a tmp dir. CI runs it in `.github/workflows/test.yml`.

## Environment

| Variable      | Default                  | Meaning |
|---------------|--------------------------|---------|
| `VAULT_PATH`  | – (required for indexing)| Obsidian vault root to index |
| `CHROMA_DIR`  | `apps/rag/chroma`        | Persistent vector store directory |
| `OLLAMA_URL`  | `http://localhost:11434` | Ollama base URL for embeddings |
| `EMBED_MODEL` | `nomic-embed-text`       | Ollama embedding model (change → index rebuilt on next start) |
| `RAG_EMBED_KEEP_ALIVE` | `30m`           | How long Ollama keeps the embedding model loaded after a call (`-1` = forever, empty = Ollama's 5m default) |
| `RAG_MAX_CHUNK_CHARS` | `2000`           | Max characters per chunk; longer `##` sections are split at paragraph/line boundaries |
| `RAG_PORT`    | `5001`                   | Port (when run via `python server.py`) |
| `RAG_SCORE_THRESHOLD` | – (no filter)    | Max cosine distance for `/query` hits (0=identical..2=opposite); empty/invalid/negative = no filtering. Overridden per-request by `score_threshold` in the body. |
