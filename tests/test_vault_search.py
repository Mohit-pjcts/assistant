"""Tests for assistant.vault_search — semantic search over the Obsidian
vault (backlog Section 3 feature, STEPS.md 150).

The real sentence-transformers model is never loaded here — slow (a cold
load needs a network round-trip) and its actual embedding quality was
already verified live against the real ~268-note vault during this
feature's own build, not something a unit test needs to re-prove. A fake
model with hand-picked, deterministic embeddings tests this module's own
logic instead: caching/invalidation by content hash, stale-entry pruning,
score thresholding, and ranking.
"""

import tempfile
from contextlib import contextmanager
from pathlib import Path

import numpy as np

import assistant.vault_search as vault_search


class _FakeModel:
    """Maps specific strings to fixed 3-D vectors so similarity is
    predictable and hand-checkable, instead of trusting real embedding
    quality (already verified live, see module docstring)."""

    def __init__(self, vectors: dict[str, list[float]]) -> None:
        self._vectors = vectors
        self.encode_calls: list[str] = []

    def encode(self, text: str) -> np.ndarray:
        self.encode_calls.append(text)
        for key, vector in self._vectors.items():
            if key in text:
                return np.array(vector, dtype=np.float32)
        return np.array([0.0, 0.0, 1.0], dtype=np.float32)  # unrelated to everything


@contextmanager
def _temp_vault_and_cache(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        vault = Path(tmp) / "OniVault"
        vault.mkdir()
        cache_path = Path(tmp) / "cache.npz"
        monkeypatch.setattr(vault_search, "VAULT_DIR", vault)
        monkeypatch.setattr(vault_search, "_CACHE_PATH", cache_path)
        vault_search._model = None  # reset the lazy singleton between tests
        yield vault


def test_semantic_search_ranks_by_similarity_and_applies_the_threshold(monkeypatch) -> None:
    fake_model = _FakeModel(
        {
            "Close Match": [1.0, 0.0, 0.0],
            "Query": [1.0, 0.0, 0.0],  # identical direction -> similarity 1.0
            "Distant Match": [0.5, 0.5, 0.0],  # similarity ~0.71 to the query
            "Unrelated": [0.0, 1.0, 0.0],  # orthogonal -> similarity 0.0, below threshold
        }
    )
    monkeypatch.setattr(vault_search, "_load_model", lambda: fake_model)

    with _temp_vault_and_cache(monkeypatch) as vault:
        (vault / "Close Match.md").write_text("Close Match content")
        (vault / "Distant Match.md").write_text("Distant Match content")
        (vault / "Unrelated.md").write_text("Unrelated content")

        results = vault_search.semantic_search("Query")

    titles = [title for title, _score in results]
    assert titles == ["Close Match", "Distant Match"]  # ranked best first, "Unrelated" excluded
    assert results[0][1] > results[1][1]


def test_semantic_search_reuses_cached_embeddings_for_unchanged_notes(monkeypatch) -> None:
    fake_model = _FakeModel({"Note": [1.0, 0.0, 0.0], "Query": [1.0, 0.0, 0.0]})
    monkeypatch.setattr(vault_search, "_load_model", lambda: fake_model)

    with _temp_vault_and_cache(monkeypatch) as vault:
        (vault / "Note.md").write_text("Note content")
        vault_search.semantic_search("Query")
        first_call_count = len(fake_model.encode_calls)

        vault_search.semantic_search("Query")
        second_call_count = len(fake_model.encode_calls)

    # The note's own embedding is reused from cache on the second search —
    # only the query itself needs re-encoding each time.
    assert second_call_count - first_call_count == 1


def test_semantic_search_re_embeds_a_note_whose_content_changed(monkeypatch) -> None:
    fake_model = _FakeModel({"Note": [1.0, 0.0, 0.0], "Query": [1.0, 0.0, 0.0]})
    monkeypatch.setattr(vault_search, "_load_model", lambda: fake_model)

    with _temp_vault_and_cache(monkeypatch) as vault:
        note_path = vault / "Note.md"
        note_path.write_text("Note content v1")
        vault_search.semantic_search("Query")

        note_path.write_text("Note content v2 — genuinely different")
        calls_before = len(fake_model.encode_calls)
        vault_search.semantic_search("Query")
        calls_after = len(fake_model.encode_calls)

    # Both the changed note AND the query get (re-)encoded this time.
    assert calls_after - calls_before == 2


def test_semantic_search_prunes_cache_entries_for_deleted_notes(monkeypatch) -> None:
    fake_model = _FakeModel({"Note": [1.0, 0.0, 0.0], "Query": [1.0, 0.0, 0.0]})
    monkeypatch.setattr(vault_search, "_load_model", lambda: fake_model)

    with _temp_vault_and_cache(monkeypatch) as vault:
        note_path = vault / "Note.md"
        note_path.write_text("Note content")
        vault_search.semantic_search("Query")
        assert len(vault_search._load_cache()) == 1

        note_path.unlink()
        vault_search.semantic_search("Query")
        assert vault_search._load_cache() == {}


def test_semantic_search_returns_empty_list_for_a_missing_vault_directory(monkeypatch) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setattr(vault_search, "VAULT_DIR", Path(tmp) / "does-not-exist")
        assert vault_search.semantic_search("anything") == []


def test_load_model_falls_back_to_a_network_load_when_nothing_is_cached_locally(monkeypatch) -> None:
    """The real cost-saving behavior this module depends on: try the fast
    local-only path first, only hit the network if genuinely nothing is
    cached yet."""
    calls = []

    class _FakeSentenceTransformer:
        def __init__(self, name, local_files_only=False):
            calls.append(local_files_only)
            if local_files_only:
                raise OSError("not cached locally")

    monkeypatch.setattr(
        "sentence_transformers.SentenceTransformer", _FakeSentenceTransformer
    )
    vault_search._model = None
    vault_search._load_model()

    assert calls == [True, False]  # tried local-only first, fell back to a network-enabled load
