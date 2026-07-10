# Discord Voice Assistant — RAG service (FastAPI + ChromaDB).
#
# Build context is the repository ROOT (deploy/docker-compose.yml uses
# `context: ..`, `dockerfile: apps/rag/Dockerfile`), so build with:
#
#   docker build -f apps/rag/Dockerfile -t va-rag .
#
# No GPU needed: embeddings are computed by the already-running `ollama`
# service over HTTP (OLLAMA_URL) — this container only serves FastAPI,
# ChromaDB and the vault file-watcher.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 10001 -m app

WORKDIR /app

# requirements first so `pip install` is cached across server.py-only changes.
COPY apps/rag/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY apps/rag/server.py ./

# Entrypoint: start as root, chown CHROMA_DIR (fresh named volumes are created
# root:root — the same EACCES root cause fixed for the server in
# apps/server/docker-entrypoint.sh), then drop to the unprivileged `app` user
# before exec-ing the real command. There's no separate script file here (this
# app may only add files under apps/rag/Dockerfile) — generated in-image
# instead, same content/behaviour as the server's entrypoint.
# python:3.11-slim has no gosu but ships setpriv (util-linux is part of the
# Debian slim base) — used here instead. Fail the BUILD if that assumption is
# ever wrong, not the container at 3am.
RUN printf '%s\n' \
        '#!/bin/sh' \
        'set -eu' \
        'mkdir -p "$CHROMA_DIR"' \
        'chown app:app "$CHROMA_DIR"' \
        'exec setpriv --reuid=app --regid=app --clear-groups -- "$@"' \
        > /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh \
    && command -v setpriv >/dev/null \
    || { echo "setpriv missing from base image — install util-linux or switch the entrypoint to gosu" >&2; exit 1; }

ENV CHROMA_DIR=/data/chroma

EXPOSE 5001

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "5001"]
