import os

import pytest

import server
from server import _apply_threshold, _iter_markdown, _parse_score_threshold, chunk_markdown

NOTE = """---
type: npc
tags: [adel]
---
# Graf Zahl

Intro über den Grafen.

## Aussehen
Groß, blass.

### Kleidung
Schwarzer Umhang.

## Motive
Will die Krone.
"""


def test_splits_at_h2_and_keeps_intro():
    chunks = chunk_markdown(NOTE, "npc/graf.md")
    assert [c["text"].splitlines()[0] for c in chunks] == ["# Graf Zahl", "## Aussehen", "## Motive"]
    # ### stays inside its ## section
    assert "### Kleidung" in chunks[1]["text"]
    assert chunks[0]["metadata"].get("heading") is None
    assert chunks[1]["metadata"]["heading"] == "Aussehen"


def test_chunk_ids_sequential_unique_and_stable():
    a = chunk_markdown(NOTE, "npc/graf.md")
    b = chunk_markdown(NOTE, "npc/graf.md")
    ids = [c["id"] for c in a]
    assert ids == ["npc/graf.md::0", "npc/graf.md::1", "npc/graf.md::2"]
    assert ids == [c["id"] for c in b]
    assert len(set(ids)) == len(ids)


def test_frontmatter_metadata_on_every_chunk():
    for c in chunk_markdown(NOTE, "npc/graf.md"):
        assert c["metadata"]["source"] == "npc/graf.md"
        assert c["metadata"]["type"] == "npc"
        assert c["metadata"]["tags"] == "adel"
        assert "type: npc" not in c["text"]


def test_empty_and_frontmatter_only_notes_yield_no_chunks():
    assert chunk_markdown("", "a.md") == []
    assert chunk_markdown("   \n\n", "a.md") == []
    assert chunk_markdown("---\na: 1\n---\n", "a.md") == []


def test_h2_inside_code_fence_does_not_split():
    text = "## Befehle\n```bash\n## kein Heading\necho hi\n```\nnach dem Block\n## Zweite\nx"
    chunks = chunk_markdown(text, "a.md")
    assert len(chunks) == 2
    assert "## kein Heading" in chunks[0]["text"]
    assert "nach dem Block" in chunks[0]["text"]
    assert chunks[1]["metadata"]["heading"] == "Zweite"


def test_tilde_fence_and_unrelated_marker_inside():
    text = "~~~\n```\n## drin\n~~~\n## Draußen\ny"
    chunks = chunk_markdown(text, "a.md")
    assert [c["metadata"].get("heading") for c in chunks] == [None, "Draußen"]


def test_long_section_is_split_with_heading_repeated():
    paras = [f"Absatz {i} " + "wort " * 40 for i in range(20)]
    text = "## Chronik\n" + "\n\n".join(paras)
    chunks = chunk_markdown(text, "log.md", max_chars=500)
    assert len(chunks) > 1
    for c in chunks:
        assert len(c["text"]) <= 500
        assert c["text"].startswith("## Chronik")
        assert c["metadata"]["heading"] == "Chronik"
    # nothing lost: every paragraph lands in some chunk
    joined = "\n".join(c["text"] for c in chunks)
    for i in range(20):
        assert f"Absatz {i} " in joined
    assert [c["id"] for c in chunks] == [f"log.md::{i}" for i in range(len(chunks))]


def test_single_unbroken_line_is_hard_cut():
    text = "x" * 2500
    chunks = chunk_markdown(text, "blob.md", max_chars=1000)
    assert [len(c["text"]) for c in chunks] == [1000, 1000, 500]


def test_default_limit_bounds_huge_note():
    text = "# Riesig\n\n" + ("Lorem ipsum dolor sit amet. " * 20 + "\n\n") * 500
    chunks = chunk_markdown(text, "big.md")
    assert len(chunks) > 1
    assert max(len(c["text"]) for c in chunks) <= server.MAX_CHUNK_CHARS


def test_iter_markdown_skips_hidden_dirs_and_non_md(tmp_path):
    (tmp_path / "npc").mkdir()
    (tmp_path / ".obsidian").mkdir()
    (tmp_path / ".trash").mkdir()
    (tmp_path / "npc" / "a.md").write_text("a")
    (tmp_path / "B.MD").write_text("b")
    (tmp_path / "bild.png").write_text("x")
    (tmp_path / ".obsidian" / "tpl.md").write_text("x")
    (tmp_path / ".trash" / "old.md").write_text("x")
    (tmp_path / ".hidden.md").write_text("x")
    found = sorted(src for _full, src in _iter_markdown(str(tmp_path)))
    assert found == ["B.MD", "npc/a.md"]


def test_is_hidden():
    assert server._is_hidden(".trash/a.md")
    assert server._is_hidden("x/.obsidian/a.md")
    assert server._is_hidden("../outside.md")
    assert not server._is_hidden("npc/a.md")


# ── score threshold (cosine distance: smaller = more similar) ────────────────

DOCS = ["near", "mid", "far"]
METAS = [{"source": "a.md"}, {"source": "b.md"}, None]
DISTS = [0.1, 0.5, 1.2]


def test_threshold_none_keeps_all_in_order():
    out = _apply_threshold(DOCS, METAS, DISTS, None)
    assert [o["text"] for o in out] == DOCS
    assert out[2]["source"] == ""
    assert set(out[0]) == {"text", "source", "distance"}


def test_threshold_drops_hits_above_and_keeps_equal():
    out = _apply_threshold(DOCS, METAS, DISTS, 0.5)
    assert [o["text"] for o in out] == ["near", "mid"]


def test_threshold_zero_keeps_only_exact():
    assert _apply_threshold(DOCS, METAS, [0.0, 0.2, 1.0], 0.0) == [
        {"text": "near", "source": "a.md", "distance": 0.0}
    ]


def test_missing_distances_are_kept_without_key():
    out = _apply_threshold(DOCS, METAS, None, 0.1)
    assert len(out) == 3 and all("distance" not in o for o in out)
    out = _apply_threshold(DOCS, METAS, [0.05, None, 0.9], 0.1)
    assert [o["text"] for o in out] == ["near", "mid"]


def test_numpy_like_distance_is_plain_float():
    class F(float):
        pass

    out = _apply_threshold(["t"], [{"source": "s"}], [F(0.123456)], None)
    assert type(out[0]["distance"]) is float and out[0]["distance"] == 0.1235


@pytest.mark.parametrize(
    "raw,expected",
    [(None, None), ("", None), ("  ", None), ("abc", None), ("-1", None), ("0", 0.0), ("0.6", 0.6)],
)
def test_parse_score_threshold(raw, expected):
    assert _parse_score_threshold(raw) == expected
