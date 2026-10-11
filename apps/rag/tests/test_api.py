"""HTTP-level tests: real FastAPI app + real (tmp-dir) Chroma, stubbed embeddings."""

import threading
import time

import pytest
import requests
from fastapi.testclient import TestClient

import server
from conftest import fake_vector, write

DRAGON = "# Drache\n\n## Hort\nDer rote Drache bewacht seinen Hort im Feuerberg.\n"
TAVERN = "# Taverne\n\n## Wirt\nDer Wirt der Taverne heißt Bruno und braut Bier.\n"


@pytest.fixture
def client(vault):
    # No `with`: lifespan (watcher + startup indexer) stays off unless a test
    # opts in explicitly.
    return TestClient(server.app)


def chunk_ids(source=None):
    with server._lock:
        res = server._collection().get(where={"source": source} if source else None)
    return sorted(res["ids"])


def wait_for(cond, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


# ── /health ─────────────────────────────────────────────────────────────────

def test_health_empty_store(client):
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["indexed"] == 0
    assert body["indexing"] is False
    assert body["vault"] is True


def test_health_reports_unusable_store(client, monkeypatch):
    def boom():
        raise RuntimeError("disk full")

    monkeypatch.setattr(server, "_collection", boom)
    res = client.get("/health")
    assert res.status_code == 503
    assert res.json()["ok"] is False


# ── /index ──────────────────────────────────────────────────────────────────

def test_index_without_vault_is_400(client, monkeypatch, tmp_path):
    monkeypatch.setattr(server, "VAULT_PATH", str(tmp_path / "missing"))
    res = client.post("/index")
    assert res.status_code == 400
    assert client.get("/health").json()["vault"] is False


def test_index_empty_vault(client):
    assert client.post("/index").json() == {"ok": True, "indexed": 0, "files": 0, "failed": 0}


def test_index_and_query_roundtrip(client, vault):
    write(vault, "orte/drache.md", DRAGON)
    write(vault, "orte/taverne.md", TAVERN)
    res = client.post("/index").json()
    assert res == {"ok": True, "indexed": 4, "files": 2, "failed": 0}
    assert client.get("/health").json()["indexed"] == 4

    hits = client.post("/query", json={"query": "Wo ist der Hort des roten Drachen?", "top_k": 2}).json()
    assert len(hits) == 2
    assert hits[0]["source"] == "orte/drache.md"
    assert "Hort" in hits[0]["text"]
    assert set(hits[0]) == {"text", "source", "distance"}
    assert hits[0]["distance"] <= hits[1]["distance"]


def test_query_response_matches_ragclient_contract(client, vault):
    # ragClient.js accepts a bare array of {text, source} (distance optional).
    write(vault, "a.md", DRAGON)
    client.post("/index")
    data = client.post("/query", json={"query": "Drache", "top_k": 3}).json()
    assert isinstance(data, list)
    for item in data:
        assert isinstance(item["text"], str) and item["text"].strip()
        assert isinstance(item["source"], str)
        assert isinstance(item["distance"], float)


def test_reindex_skips_unchanged_notes(client, vault, embedder):
    write(vault, "a.md", DRAGON)
    write(vault, "b.md", TAVERN)
    client.post("/index")
    first = embedder.calls
    assert client.post("/index").json()["indexed"] == 4
    assert embedder.calls == first  # no re-embedding


def test_edit_replaces_chunks_without_stale_ids(client, vault):
    path = write(vault, "a.md", "# A\n\n## Eins\nx\n\n## Zwei\ny\n\n## Drei\nz\n")
    client.post("/index")
    assert chunk_ids("a.md") == ["a.md::0", "a.md::1", "a.md::2", "a.md::3"]
    path.write_text("# A\n\n## Eins\nneu\n")
    client.post("/index")
    assert chunk_ids("a.md") == ["a.md::0", "a.md::1"]
    hits = client.post("/query", json={"query": "neu", "top_k": 5}).json()
    assert all("y" != h["text"].splitlines()[-1] for h in hits)


def test_deleted_and_renamed_notes_are_pruned(client, vault):
    a = write(vault, "a.md", DRAGON)
    b = write(vault, "b.md", TAVERN)
    client.post("/index")
    a.unlink()
    b.rename(vault / "c.md")
    res = client.post("/index").json()
    assert res["files"] == 1
    assert chunk_ids() == ["c.md::0", "c.md::1"]


def test_frontmatter_source_field_does_not_leave_duplicates(client, vault):
    path = write(vault, "clip.md", "---\nsource: https://example.org\n---\n## A\nalt\n")
    client.post("/index")
    path.write_text("---\nsource: https://example.org\n---\n## A\nneu\n")
    client.post("/index")
    ids = chunk_ids()
    assert ids == ["clip.md::0"]
    hit = client.post("/query", json={"query": "neu"}).json()[0]
    assert hit["source"] == "clip.md"


def test_non_utf8_and_bom_notes_do_not_abort_index(client, vault):
    write(vault, "cp1252.md", "## Größe\nÄrger über Öl\n", encoding="cp1252")
    write(vault, "bom.md", "﻿---\ntype: ort\n---\n## Wald\nBäume\n", encoding="utf-8")
    write(vault, "ok.md", DRAGON)
    res = client.post("/index").json()
    assert res["files"] == 3 and res["failed"] == 0
    with server._lock:
        meta = server._collection().get(where={"source": "bom.md"})["metadatas"][0]
    assert meta["type"] == "ort"


def test_hidden_dirs_are_not_indexed_and_pruned(client, vault):
    write(vault, ".trash/alt.md", DRAGON)
    write(vault, ".obsidian/tpl.md", TAVERN)
    write(vault, "a.md", "## X\ny\n")
    assert client.post("/index").json()["files"] == 1
    assert chunk_ids() == ["a.md::0"]


def test_oversized_note_is_skipped(client, vault, monkeypatch):
    monkeypatch.setattr(server, "MAX_FILE_BYTES", 100)
    write(vault, "big.md", "## A\n" + "x " * 200)
    write(vault, "small.md", "## B\ny\n")
    client.post("/index")
    assert chunk_ids() == ["small.md::0"]


def test_one_failing_note_is_skipped_not_fatal(client, vault, monkeypatch):
    write(vault, "a.md", DRAGON)
    write(vault, "b.md", TAVERN)
    real_index = server.index_file

    def flaky_index(path, source):
        if source == "a.md":
            raise ValueError("chroma rejected metadata")
        return real_index(path, source)

    monkeypatch.setattr(server, "index_file", flaky_index)
    res = client.post("/index").json()
    assert res == {"ok": True, "indexed": 2, "files": 2, "failed": 1}


# ── score threshold / top_k ─────────────────────────────────────────────────

@pytest.fixture
def two_notes(client, vault):
    write(vault, "drache.md", "## Hort\nroter drache hort feuerberg\n")
    write(vault, "wirt.md", "## Wirt\nbruno braut bier taverne\n")
    client.post("/index")
    return client


def test_request_threshold_drops_far_hits(two_notes):
    hits = two_notes.post("/query", json={"query": "roter drache hort feuerberg", "top_k": 5}).json()
    assert len(hits) == 2
    assert hits[0]["distance"] < 0.2 and hits[1]["distance"] > 0.5
    hits = two_notes.post(
        "/query", json={"query": "roter drache hort feuerberg", "top_k": 5, "score_threshold": 0.3}
    ).json()
    assert [h["source"] for h in hits] == ["drache.md"]


def test_env_threshold_is_default_and_request_overrides(two_notes, monkeypatch):
    monkeypatch.setattr(server, "RAG_SCORE_THRESHOLD", 0.3)
    q = {"query": "roter drache hort feuerberg", "top_k": 5}
    assert len(two_notes.post("/query", json=q).json()) == 1
    assert len(two_notes.post("/query", json={**q, "score_threshold": 2.0}).json()) == 2


def test_negative_threshold_rejected(two_notes):
    res = two_notes.post("/query", json={"query": "x", "score_threshold": -0.1})
    assert res.status_code == 422


def test_top_k_is_clamped_not_rejected(client, vault):
    for i in range(25):
        write(vault, f"n{i}.md", f"## N{i}\nnotiz nummer {i}\n")
    client.post("/index")
    res = client.post("/query", json={"query": "notiz", "top_k": 50})
    assert res.status_code == 200
    assert len(res.json()) == server.MAX_TOP_K
    assert client.post("/query", json={"query": "notiz", "top_k": 0}).status_code == 422


def test_top_k_larger_than_collection(two_notes):
    assert len(two_notes.post("/query", json={"query": "bier", "top_k": 10}).json()) == 2


def test_blank_query_and_empty_index_return_empty(client):
    assert client.post("/query", json={"query": "   "}).json() == []
    assert client.post("/query", json={"query": "irgendwas"}).json() == []


# ── Ollama failures ─────────────────────────────────────────────────────────

def test_query_when_ollama_down_is_503(two_notes, embedder):
    embedder.fail = True
    res = two_notes.post("/query", json={"query": "bier"})
    assert res.status_code == 503


def test_index_when_ollama_down_keeps_existing_index(client, vault, embedder):
    write(vault, "a.md", DRAGON)
    client.post("/index")
    before = chunk_ids()
    write(vault, "a.md", DRAGON + "\n## Neu\nmehr\n")
    write(vault, "b.md", TAVERN)
    embedder.fail = True
    res = client.post("/index")
    assert res.status_code == 503
    assert chunk_ids() == before  # nothing wiped, old chunks still searchable
    embedder.fail = False
    assert client.post("/index").json()["indexed"] == 5


def test_failed_note_update_keeps_previous_chunks(vault, embedder):
    # Watcher path: an edit arrives while Ollama is down. The note's old chunks
    # must survive (embeddings are computed before anything is deleted).
    path = write(vault, "a.md", DRAGON)
    server.sync_path(str(path), "a.md")
    path.write_text("## Ganz neu\nanderer Text\n")
    embedder.fail = True
    with pytest.raises(server.EmbeddingUnavailable):
        server.sync_path(str(path), "a.md")
    with server._lock:
        docs = server._collection().get(where={"source": "a.md"})["documents"]
    assert any("Hort" in d for d in docs)
    embedder.fail = False
    assert server.sync_path(str(path), "a.md") == 1


def test_documents_and_queries_use_their_embedding_kind(two_notes, embedder):
    assert set(embedder.kinds) == {"document"}
    embedder.kinds.clear()
    two_notes.post("/query", json={"query": "bier"})
    assert embedder.kinds == ["query"]


def test_real_embed_payload_prefix_and_keep_alive(monkeypatch):
    sent = []

    def capture(url, json, timeout):
        sent.append(json)
        return _Resp(200, {"embedding": [1.0]})

    monkeypatch.setattr(server, "_state", {"indexing": False, "ollama": None, "last_error": None})
    monkeypatch.setattr(server.requests, "post", capture)
    monkeypatch.setattr(server, "EMBED_MODEL", "nomic-embed-text:latest")
    monkeypatch.setattr(server, "EMBED_KEEP_ALIVE", "30m")
    server.embed("Drache")
    server.embed("Wo ist der Drache?", kind="query")
    assert sent[0] == {"model": "nomic-embed-text:latest", "prompt": "search_document: Drache",
                       "keep_alive": "30m"}
    assert sent[1]["prompt"] == "search_query: Wo ist der Drache?"

    # Other models: no nomic prefixes; empty keep-alive → Ollama's default.
    monkeypatch.setattr(server, "EMBED_MODEL", "mxbai-embed-large")
    monkeypatch.setattr(server, "EMBED_KEEP_ALIVE", None)
    server.embed("Drache", kind="query")
    assert sent[2] == {"model": "mxbai-embed-large", "prompt": "Drache"}


def test_stored_text_has_no_task_prefix(two_notes):
    hits = two_notes.post("/query", json={"query": "bier"}).json()
    assert all(not h["text"].startswith("search_") for h in hits)


@pytest.mark.parametrize(
    "raw,expected", [(None, None), ("", None), (" ", None), ("30m", "30m"), ("-1", -1), ("3600", 3600)]
)
def test_parse_keep_alive(raw, expected):
    assert server._parse_keep_alive(raw) == expected


def test_real_embed_wraps_connection_errors(monkeypatch):
    # No `embedder` fixture here: server.embed is the real Ollama client.
    monkeypatch.setattr(server, "_state", {"indexing": False, "ollama": None, "last_error": None})

    def refused(*_a, **_kw):
        raise requests.ConnectionError("connection refused")

    monkeypatch.setattr(server.requests, "post", refused)
    with pytest.raises(server.EmbeddingUnavailable):
        server.embed("x")
    assert server._state["ollama"] is False
    assert "refused" in server._state["last_error"]


class _Resp:
    def __init__(self, status, payload=None, text=""):
        self.status_code = status
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


@pytest.mark.parametrize(
    "resp,needle",
    [
        (_Resp(404, text='{"error":"model \\"nomic-embed-text\\" not found"}'), "not found"),
        (_Resp(200, payload={"embedding": []}), "empty"),
        (_Resp(200, payload=None), "no json"),
        (_Resp(200, payload=["unexpected"]), "attribute"),
    ],
)
def test_real_embed_bad_replies(monkeypatch, resp, needle):
    monkeypatch.setattr(server, "_state", {"indexing": False, "ollama": None, "last_error": None})
    monkeypatch.setattr(server.requests, "post", lambda *_a, **_kw: resp)
    with pytest.raises(server.EmbeddingUnavailable) as exc:
        server.embed("x")
    assert needle in str(exc.value).lower()


def test_real_embed_success_marks_ollama_up(monkeypatch):
    monkeypatch.setattr(server, "_state", {"indexing": False, "ollama": None, "last_error": None})
    monkeypatch.setattr(server.requests, "post", lambda *_a, **_kw: _Resp(200, {"embedding": [0.1, 0.2]}))
    assert server.embed("x") == [0.1, 0.2]
    assert server._state["ollama"] is True


# ── model change / store migration ──────────────────────────────────────────

def test_embed_model_change_rebuilds_collection(client, vault, monkeypatch):
    write(vault, "a.md", DRAGON)
    client.post("/index")
    assert client.get("/health").json()["indexed"] == 2
    monkeypatch.setattr(server, "EMBED_MODEL", "mxbai-embed-large")
    monkeypatch.setattr(server, "_col", None)  # as after a restart
    assert client.get("/health").json()["indexed"] == 0
    assert client.post("/index").json()["indexed"] == 2


# ── concurrency ─────────────────────────────────────────────────────────────

def test_long_reindex_does_not_block_query_or_health(client, vault, embedder):
    write(vault, "a.md", DRAGON)
    client.post("/index")
    # One big note: 10 sections x 0.3 s of (stubbed) Ollama time in ONE index_file.
    write(vault, "gross.md", "".join(f"## Teil {i}\ntext {i}\n\n" for i in range(10)))
    embedder.doc_delay = 0.3
    t = threading.Thread(target=lambda: client.post("/index"))
    t.start()
    try:
        assert wait_for(lambda: embedder.kinds.count("document") > 3, timeout=10)
        start = time.monotonic()
        assert client.get("/health").json()["indexing"] is True
        assert client.post("/query", json={"query": "Drache"}).status_code == 200
        assert time.monotonic() - start < 1.0
    finally:
        t.join(timeout=30)


def test_older_read_of_a_note_never_lands_last(vault, monkeypatch):
    # T1 reads version1 and stalls in Ollama; meanwhile the note is saved again
    # and synced (T2). Without per-note serialization T1 would finish last and
    # put version1 back. With it, T2 waits for T1, then reads version2.
    path = write(vault, "a.md", "## V\nversion1\n")
    t2_done = threading.Event()

    def embed(text, timeout=None, kind="document"):
        if "version1" in text:
            t2_done.wait(0.5)
        return fake_vector(text)

    monkeypatch.setattr(server, "embed", embed)
    t1 = threading.Thread(target=server.sync_path, args=(str(path), "a.md"))
    t1.start()
    time.sleep(0.15)  # T1 has read version1 and is embedding it
    path.write_text("## V\nversion2\n")
    server.sync_path(str(path), "a.md")
    t2_done.set()
    t1.join(timeout=5)
    with server._lock:
        docs = server._collection().get(where={"source": "a.md"})["documents"]
    assert docs == ["## V\nversion2"]


# ── lifespan: startup indexing + file watcher ───────────────────────────────

def test_startup_indexes_in_background_and_retries_until_ollama_is_up(vault, embedder, monkeypatch):
    monkeypatch.setattr(server, "WARM_RETRY_S", 0.05)
    write(vault, "a.md", DRAGON)
    embedder.fail = True
    with TestClient(server.app) as c:
        # Service is up (healthcheck passes) while Ollama is still down.
        assert c.get("/health").json()["ok"] is True
        assert wait_for(lambda: embedder.calls >= 2)
        embedder.fail = False
        assert wait_for(lambda: c.get("/health").json()["indexed"] == 2)


def test_startup_picks_up_changes_made_while_down(vault, embedder, monkeypatch):
    write(vault, "a.md", DRAGON)
    server.reindex_all()
    (vault / "a.md").unlink()
    write(vault, "b.md", TAVERN)
    with TestClient(server.app):
        assert wait_for(lambda: chunk_ids() == ["b.md::0", "b.md::1"])


def test_watcher_syncs_edits_deletes_and_renames(vault, embedder, monkeypatch):
    monkeypatch.setattr(server._VaultHandler, "DEBOUNCE_S", 0.05)
    with TestClient(server.app):
        assert wait_for(lambda: not server._state["indexing"])
        path = write(vault, "neu.md", "## A\nalpha\n")
        assert wait_for(lambda: chunk_ids() == ["neu.md::0"])

        path.write_text("## A\nalpha\n\n## B\nbeta\n")
        assert wait_for(lambda: chunk_ids() == ["neu.md::0", "neu.md::1"])

        path.rename(vault / "umbenannt.md")
        assert wait_for(lambda: chunk_ids() == ["umbenannt.md::0", "umbenannt.md::1"])

        (vault / "umbenannt.md").unlink()
        assert wait_for(lambda: chunk_ids() == [])

        # Moving a whole folder triggers a reconcile of the vault.
        write(vault, "ordner/x.md", "## X\nx\n")
        assert wait_for(lambda: chunk_ids() == ["ordner/x.md::0"])
        (vault / "ordner").rename(vault / "anders")
        assert wait_for(lambda: chunk_ids() == ["anders/x.md::0"])

        # Notes moved to Obsidian's .trash disappear from the index.
        (vault / ".trash").mkdir()
        (vault / "anders" / "x.md").rename(vault / ".trash" / "x.md")
        assert wait_for(lambda: chunk_ids() == [])


def test_service_starts_without_vault(monkeypatch, tmp_path, embedder):
    monkeypatch.setattr(server, "VAULT_PATH", "")
    monkeypatch.setattr(server, "CHROMA_DIR", str(tmp_path / "chroma"))
    monkeypatch.setattr(server, "_client", None)
    monkeypatch.setattr(server, "_col", None)
    with TestClient(server.app) as c:
        body = c.get("/health").json()
        assert body["ok"] is True and body["vault"] is False and body["indexed"] == 0
        assert c.post("/index").status_code == 400
        assert c.post("/query", json={"query": "x"}).json() == []
