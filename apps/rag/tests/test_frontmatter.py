import datetime

from server import _flatten_meta, parse_frontmatter


def test_parses_mapping_and_strips_block():
    meta, body = parse_frontmatter("---\ntitle: Graf Zahl\ntags: [npc, adel]\n---\n# Graf\n\nText")
    assert meta == {"title": "Graf Zahl", "tags": ["npc", "adel"]}
    assert body == "# Graf\n\nText"


def test_no_frontmatter_returns_text_unchanged():
    text = "# Title\n\nbody"
    assert parse_frontmatter(text) == ({}, text)


def test_empty_frontmatter_block():
    assert parse_frontmatter("---\n---\nbody") == ({}, "body")


def test_dot_closing_delimiter():
    meta, body = parse_frontmatter("---\na: 1\n...\nbody")
    assert meta == {"a": 1}
    assert body == "body"


def test_crlf_line_endings():
    meta, body = parse_frontmatter("---\r\na: 1\r\n---\r\nbody\r\n")
    assert meta == {"a": 1}
    assert body.strip() == "body"


def test_utf8_bom_before_frontmatter():
    meta, body = parse_frontmatter("﻿---\na: 1\n---\nbody")
    assert meta == {"a": 1}
    assert body == "body"


def test_horizontal_rule_at_top_is_not_frontmatter_and_loses_nothing():
    # A note that merely opens with a thematic break: the "YAML" between the two
    # rules is prose. It must stay in the body instead of being swallowed.
    text = "---\nDer Drache schläft.\n---\nMehr Text"
    assert parse_frontmatter(text) == ({}, text)


def test_invalid_yaml_keeps_full_text():
    text = "---\na: [unclosed\n---\nbody"
    assert parse_frontmatter(text) == ({}, text)


def test_yaml_list_is_not_frontmatter():
    text = "---\n- a\n- b\n---\nbody"
    assert parse_frontmatter(text) == ({}, text)


def test_four_dashes_are_not_a_delimiter():
    text = "----\na: 1\n----\nbody"
    assert parse_frontmatter(text) == ({}, text)


def test_unclosed_frontmatter():
    text = "---\na: 1\nbody without close"
    assert parse_frontmatter(text) == ({}, text)


def test_closing_delimiter_must_be_its_own_line():
    meta, body = parse_frontmatter("---\na: 1\n--- not a close\nb: 2\n---\nbody")
    # The "--- not a close" line is part of the YAML block → YAML error → no meta.
    assert meta == {}
    assert body.startswith("---\na: 1")


def test_flatten_scalars_lists_dates_nested_none():
    meta = {
        "title": "X",
        "level": 3,
        "cr": 0.5,
        "alive": False,
        "tags": ["npc", "adel"],
        "date": datetime.date(2026, 6, 14),
        "stats": {"ac": 15},
        "empty": None,
        42: "int key",
    }
    out = _flatten_meta(meta, "npc/x.md")
    assert out["title"] == "X"
    assert out["level"] == 3
    assert out["cr"] == 0.5
    assert out["alive"] is False
    assert out["tags"] == "npc, adel"
    assert out["date"] == "2026-06-14"
    assert out["stats"] == "{'ac': 15}"
    assert "empty" not in out
    assert out["42"] == "int key"
    assert out["source"] == "npc/x.md"


def test_frontmatter_source_field_cannot_shadow_note_path():
    out = _flatten_meta({"source": "https://example.org/clip"}, "clips/a.md")
    assert out["source"] == "clips/a.md"


def test_values_chroma_would_reject_are_stringified_or_dropped():
    out = _flatten_meta(
        {"big": 2 ** 70, "nan": float("nan"), "inf": float("inf"), "chroma:document": "x", "": 1},
        "a.md",
    )
    assert out["big"] == str(2 ** 70)
    assert out["nan"] == "nan"
    assert out["inf"] == "inf"
    assert "chroma:document" not in out
    assert "" not in out
