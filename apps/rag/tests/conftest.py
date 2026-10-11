"""Shared fixtures for the RAG service tests.

The real service needs Ollama for embeddings; here `server.embed` is replaced
by a deterministic bag-of-words embedder so cosine distances are meaningful
(same words → distance ~0, disjoint words → distance ~1) without any network.
ChromaDB itself is real, persisted into a per-test tmp dir.
"""

import hashlib
import os
import re
import sys
import threading

import pytest

RAG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, RAG_DIR)

# Import-time config must not pick up a developer's real vault/env.
os.environ.pop("VAULT_PATH", None)
os.environ.pop("RAG_SCORE_THRESHOLD", None)
os.environ.pop("RAG_MAX_CHUNK_CHARS", None)

import server  # noqa: E402

DIM = 64


def fake_vector(text: str) -> list[float]:
    vec = [0.0] * DIM
    for word in re.findall(r"\w+", text.lower()):
        vec[int(hashlib.md5(word.encode()).hexdigest(), 16) % DIM] += 1.0
    vec[0] += 1e-3  # never a zero vector (cosine undefined)
    return vec


class FakeEmbedder:
    """Callable stand-in for server.embed; counts calls, can fail or stall."""

    def __init__(self):
        self.calls = 0
        self.kinds = []
        self.fail = False
        self.doc_delay = 0.0  # stall only indexing calls, never query embeddings
        self._mu = threading.Lock()

    def __call__(self, text, timeout=None, kind="document"):
        with self._mu:
            self.calls += 1
            self.kinds.append(kind)
        if self.doc_delay and kind == "document":
            threading.Event().wait(self.doc_delay)
        if self.fail:
            raise server.EmbeddingUnavailable("ollama down (test)")
        return fake_vector(text)


@pytest.fixture
def embedder(monkeypatch):
    fake = FakeEmbedder()
    monkeypatch.setattr(server, "embed", fake)
    return fake


@pytest.fixture
def vault(tmp_path, monkeypatch, embedder):
    """Empty vault + fresh Chroma store wired into the server module."""
    vault_dir = tmp_path / "vault"
    vault_dir.mkdir()
    monkeypatch.setattr(server, "VAULT_PATH", str(vault_dir))
    monkeypatch.setattr(server, "CHROMA_DIR", str(tmp_path / "chroma"))
    monkeypatch.setattr(server, "RAG_SCORE_THRESHOLD", None)
    monkeypatch.setattr(server, "_client", None)
    monkeypatch.setattr(server, "_col", None)
    monkeypatch.setattr(server, "_state", {"indexing": False, "ollama": None, "last_error": None})
    server._stop.clear()
    yield vault_dir
    server._stop.set()
    server._stop_watcher()


def write(vault_dir, rel: str, text: str, encoding: str = "utf-8"):
    path = vault_dir / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode(encoding))
    return path
