"""Offline tests for chunk-level vault retrieval (assistant/vault_index.py) and the search_vault /
read_vault_note changes built on it. A temp vault and a fake bag-of-words encoder stand in for the
real vault and the sentence-transformers model, so nothing loads a model or touches OniVault."""

from __future__ import annotations

import zlib

import numpy as np
import pytest

from assistant import obsidian_tools, vault_index, vault_search

DIM = 64


def _fake_encode(texts: list[str]) -> np.ndarray:
    out = np.zeros((len(texts), DIM), dtype=np.float32)
    for row, text in enumerate(texts):
        for word in vault_index.tokenize(text):
            out[row, zlib.crc32(word.encode()) % DIM] += 1.0
    norms = np.linalg.norm(out, axis=1, keepdims=True)
    return out / np.where(norms == 0, 1.0, norms)


FILLER = ("Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt. " * 12).strip()


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "vault"
    root.mkdir()
    monkeypatch.setattr(obsidian_tools, "VAULT_DIR", root)
    monkeypatch.setattr(vault_index, "_CACHE_PATH", tmp_path / "chunks.npz")
    monkeypatch.setattr(vault_index, "_encode", _fake_encode)
    monkeypatch.setattr(vault_index, "_model_loaded", lambda: True)
    vault_index.reset_for_tests()
    yield root
    vault_index.reset_for_tests()


def _note(root, name: str, body: str, oni: bool = False) -> None:
    front = "---\noni: true\ncreated: 2026-10-01\n---\n\n" if oni else ""
    path = root / f"{name}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(front + body)


# --- chunking -----------------------------------------------------------------------------------


def test_chunks_are_heading_aware_and_offsets_map_back_to_the_body():
    body = f"intro text {FILLER}\n\n# Alpha\n{FILLER}\n\n## Beta\nbeta facts here {FILLER}\n"
    chunks = vault_index.chunk_note("T", "T.md", "---\nx: 1\n---\n" + body)
    assert {c.heading for c in chunks} >= {"Alpha", "Beta"}
    stripped = vault_index.strip_frontmatter("---\nx: 1\n---\n" + body)
    assert all(stripped[c.start : c.end].strip() in c.text for c in chunks)
    assert [c.position for c in chunks] == list(range(len(chunks)))
    assert all(len(c.text) <= vault_index.CHUNK_CHARS + 200 for c in chunks)


def test_an_empty_note_still_gets_one_chunk_so_its_title_is_searchable():
    chunks = vault_index.chunk_note("Empty Title", "Empty Title.md", "")
    assert len(chunks) == 1 and "Empty Title" in chunks[0].text


# --- retrieval ----------------------------------------------------------------------------------


def test_finds_text_deep_in_a_note_that_the_first_500_characters_never_show(vault):
    _note(vault, "Study Plan", f"# Overview\n{FILLER}\n\n# Week 3 deadlines\nThe zymurgy essay is due Friday.\n")
    _note(vault, "Other", f"# Misc\n{FILLER}\n")
    top = vault_index.search("when is the zymurgy essay due", top_k=3)
    assert top and top[0][0].title == "Study Plan"
    assert top[0][0].heading == "Week 3 deadlines"


def test_unrelated_query_returns_nothing_not_the_least_bad_note(vault):
    _note(vault, "Study Plan", f"# Overview\n{FILLER}\n")
    assert vault_index.search("qqqqq xxxxx", top_k=3) == []


def test_dense_is_fused_in_when_embeddings_are_ready(vault):
    _note(vault, "A", "# One\nalpha beta gamma\n")
    _note(vault, "B", "# Two\ndelta epsilon zeta\n")
    index = vault_index.get_index()
    assert vault_index._dense_matrix(index) is not None  # embeds inline: tiny vault, model "loaded"
    assert vault_index.dense_scores(index, "alpha beta") is not None


def test_bm25_only_while_a_large_embedding_job_runs_in_the_background(vault, monkeypatch):
    for i in range(30):
        _note(vault, f"N{i}", f"# H\n{FILLER} unique{i}word\n")
    started = []
    monkeypatch.setattr(vault_index, "_SYNC_EMBED_LIMIT", 3)
    monkeypatch.setattr(vault_index, "_start_warm", lambda: started.append(1))
    hits = vault_index.search("unique7word")
    assert hits and hits[0][0].title == "N7"  # BM25 answered immediately
    assert started, "the missing embeddings should have been handed to the background warm-up"


def test_embeddings_are_cached_by_content_so_unchanged_chunks_are_not_re_encoded(vault, monkeypatch):
    _note(vault, "A", "# One\nalpha beta gamma\n")
    calls: list[int] = []

    def counting(texts):
        calls.append(len(texts))
        return _fake_encode(texts)

    monkeypatch.setattr(vault_index, "_encode", counting)
    vault_index.search("alpha")
    first = sum(calls)
    vault_index.reset_for_tests()  # drop memory; the .npz on disk must carry it
    calls.clear()
    vault_index.search("alpha")
    assert first >= 1 and sum(calls) == 1  # only the query itself


def test_index_rebuilds_when_a_note_changes(vault):
    _note(vault, "A", "# One\nalpha\n")
    assert vault_index.search("omegaterm") == []
    _note(vault, "A", "# One\nalpha omegaterm\n")
    assert vault_index.search("omegaterm")[0][0].title == "A"


def test_reserved_dirs_are_not_indexed(vault):
    _note(vault, "_trash/Gone", "# X\nsecretword\n")
    assert vault_index.search("secretword") == []


# --- sections and passages ----------------------------------------------------------------------


def test_read_section_matches_exact_then_substring_and_stops_at_a_same_level_heading():
    body = "# Top\nintro\n## Budget\nline1\n### Sub\nsubline\n## Other\nx\n"
    got = vault_index.read_section(body, "budget")
    assert got.startswith("## Budget") and "subline" in got and "## Other" not in got
    assert vault_index.read_section(body, "bud") == got
    assert vault_index.read_section(body, "nope") is None


def test_outline_ignores_hashes_inside_code_fences():
    body = "# Real\n```\n# not a heading\n```\n## Also real\n"
    assert [h for _, _, h in vault_index.outline(body)] == ["Real", "Also real"]


def test_read_relevant_returns_matching_passages_with_neighbours_in_order(vault):
    _note(vault, "Long", f"# A\n{FILLER}\n\n# B\n{FILLER}\n\n# C\nthe quokka budget is 40\n\n# D\n{FILLER}\n")
    out = vault_index.read_relevant("Long.md", "quokka budget")
    assert "quokka budget is 40" in out
    assert out.index("quokka") < out.rindex("Lorem")  # position order, the D neighbour comes after


# --- the tools ----------------------------------------------------------------------------------


def test_short_note_is_returned_byte_for_byte(vault):
    _note(vault, "Short", "# Hi\njust a little note\n")
    assert obsidian_tools.read_vault_note.invoke({"title": "Short"}) == "# Hi\njust a little note\n"


def test_long_note_is_cut_loudly_with_outline_and_a_way_to_get_the_rest(vault):
    big = "".join(f"# Section {i}\n{FILLER}\n\n" for i in range(40))
    _note(vault, "Big", big)
    out = obsidian_tools.read_vault_note.invoke({"title": "Big"})
    assert "[CUT:" in out and "Section 39" in out  # the outline lists headings that were cut
    assert "section=" in out and "query=" in out and "update_vault_note" in out
    assert len(out) < len(big)


def test_long_note_written_by_oni_is_never_cut_because_updates_are_based_on_reads(vault):
    big = "".join(f"# Section {i}\n{FILLER}\n\n" for i in range(40))
    _note(vault, "OniBig", big, oni=True)
    assert obsidian_tools.read_vault_note.invoke({"title": "OniBig"}).count("Lorem ipsum") == big.count("Lorem ipsum")


def test_read_by_section_and_query_and_a_missing_section_lists_headings(vault):
    _note(vault, "Trip Plan", f"# Flights\n{FILLER}\n\n# Budget\nfood 200, hotel 800\n\n# Packing\n{FILLER}\n")
    sec = obsidian_tools.read_vault_note.invoke({"title": "Trip Plan", "section": "budget"})
    assert "hotel 800" in sec and "Flights" not in sec
    qry = obsidian_tools.read_vault_note.invoke({"title": "Trip Plan", "query": "hotel cost"})
    assert "hotel 800" in qry
    miss = obsidian_tools.read_vault_note.invoke({"title": "Trip Plan", "section": "zzz"})
    assert miss.startswith("Error") and "Flights" in miss and "Packing" in miss


def test_search_vault_keeps_every_old_hit_and_adds_chunk_matches(vault, monkeypatch):
    _note(vault, "CCHU9053 Notes", "# Exam\nexam covers chapters 1 to 4\n")
    _note(vault, "Semantic Only", "# X\nnothing literal\n")
    _note(vault, "Deep", f"# Intro\n{FILLER}\n\n# Appendix\nthe obscurantist clause is on page nine\n")
    monkeypatch.setattr(vault_search, "semantic_search", lambda query, **kw: [("Semantic Only", 0.55)])

    old = obsidian_tools.search_vault.invoke({"query": "exam covers"})
    assert "[[CCHU9053 Notes]]" in old  # exact substring hit unchanged
    assert "[[Semantic Only]] (semantic match" in old  # old semantic hit unchanged

    new = obsidian_tools.search_vault.invoke({"query": "where is the obscurantist clause"})
    assert "[[Deep]] (best match under 'Appendix')" in new
    assert "[[Semantic Only]]" in new  # old semantic hit still present alongside the new one


def test_search_vault_survives_a_broken_index(vault, monkeypatch):
    _note(vault, "Plain", "# A\nfindme\n")
    monkeypatch.setattr(vault_index, "search", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    monkeypatch.setattr(vault_search, "semantic_search", lambda query, **kw: [])
    assert "[[Plain]]" in obsidian_tools.search_vault.invoke({"query": "findme"})
