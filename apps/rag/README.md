# RAG service (`apps/rag/`)

Semantic search over the Obsidian campaign vault. A standalone FastAPI process
(its own port, its own lifecycle) that the Node server queries over HTTP; if it
is down the server silently falls back to the static `CAMPAIGN.md`.

## How it works

1. **Scan** – every `.md` under `VAULT_PATH` is read, its YAML frontmatter is
   parsed, and the body is chunked at each `##` heading.
2. **Embed** – each chunk is embedded with the already-running Ollama
   (`nomic-embed-text`), so no extra model server is needed.
3. **Store** – vectors land in a local, persistent ChromaDB (`CHROMA_DIR`).
4. **Watch** – a `watchdog` file-watcher re-indexes individual notes as they
   change, so the index stays current without a manual re-run.

## Endpoints

| Method | Path      | Body / result |
|--------|-----------|---------------|
| `POST` | `/index`  | (re)build the whole collection → `{ ok, indexed, files }` |
| `POST` | `/query`  | `{ "query": "...", "top_k": 3, "score_threshold": 0.4 }` → `[{ "text", "source", "distance" }]` |
| `GET`  | `/health` | `{ "ok": true, "indexed": N }` |

`score_threshold` (optional, max cosine distance — smaller means more similar)
drops hits above it; when omitted it falls back to the `RAG_SCORE_THRESHOLD`
env var below. Each result's `distance` is the cosine distance to the query;
it is left out when the running Chroma version doesn't report one.

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

## Environment

| Variable      | Default                  | Meaning |
|---------------|--------------------------|---------|
| `VAULT_PATH`  | – (required for indexing)| Obsidian vault root to index |
| `CHROMA_DIR`  | `apps/rag/chroma`        | Persistent vector store directory |
| `OLLAMA_URL`  | `http://localhost:11434` | Ollama base URL for embeddings |
| `EMBED_MODEL` | `nomic-embed-text`       | Ollama embedding model |
| `RAG_PORT`    | `5001`                   | Port (when run via `python server.py`) |
| `RAG_SCORE_THRESHOLD` | – (no filter)    | Max cosine distance for `/query` hits (0=identical..2=opposite); empty/invalid/negative = no filtering. Overridden per-request by `score_threshold` in the body. |
