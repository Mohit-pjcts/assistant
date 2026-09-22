"""Tests for assistant.conversation_search — semantic search over past
conversation threads (STEPS.md 151's reliability/orchestration backlog
audit, the real narrower version of the generic "embeddings index for past
conversations" wishlist item).

Same approach as test_vault_search.py: no real sentence-transformers model
loaded — a fake model with hand-picked, deterministic vectors tests this
module's own logic (caching by last_active_at, ranking, thresholding),
not embedding quality.
"""

from __future__ import annotations

import tempfile
from contextlib import contextmanager
from pathlib import Path

import numpy as np
from langchain_core.messages import AIMessage, HumanMessage

import assistant.conversation_search as conversation_search
from assistant.thread_store import Thread


class _FakeModel:
    def __init__(self, vectors: dict[str, list[float]]) -> None:
        self._vectors = vectors
        self.encode_calls: list[str] = []

    def encode(self, text: str) -> np.ndarray:
        self.encode_calls.append(text)
        for key, vector in self._vectors.items():
            if key in text:
                return np.array(vector, dtype=np.float32)
        return np.array([0.0, 0.0, 1.0], dtype=np.float32)


def _thread(id_: str, title: str, last_active_at: str = "2026-01-01T00:00:00") -> Thread:
    return Thread(id=id_, title=title, created_at=last_active_at, last_active_at=last_active_at)


@contextmanager
def _isolated(monkeypatch, threads: list[Thread]):
    with tempfile.TemporaryDirectory() as tmp:
        cache_path = Path(tmp) / "cache.npz"
        monkeypatch.setattr(conversation_search, "_CACHE_PATH", cache_path)

        async def _fake_list_threads(*args, **kwargs):
            return threads

        monkeypatch.setattr(conversation_search.thread_store, "list_threads", _fake_list_threads)
        conversation_search._model = None
        yield


def _messages_fetcher(by_thread: dict[str, list]):
    async def _fetch(thread_id: str):
        return by_thread.get(thread_id, [])

    return _fetch


async def test_semantic_search_ranks_by_similarity_and_applies_threshold(monkeypatch) -> None:
    fake_model = _FakeModel(
        {
            "Close Thread": [1.0, 0.0, 0.0],
            "Query": [1.0, 0.0, 0.0],
            "Distant Thread": [0.5, 0.5, 0.0],
            "Unrelated Thread": [0.0, 1.0, 0.0],
        }
    )
    monkeypatch.setattr(conversation_search, "_load_model", lambda: fake_model)

    threads = [
        _thread("t1", "Close Thread"),
        _thread("t2", "Distant Thread"),
        _thread("t3", "Unrelated Thread"),
    ]
    fetch = _messages_fetcher(
        {
            "t1": [HumanMessage(content="something about Close Thread")],
            "t2": [HumanMessage(content="something about Distant Thread")],
            "t3": [HumanMessage(content="something about Unrelated Thread")],
        }
    )

    with _isolated(monkeypatch, threads):
        results = await conversation_search.semantic_search("Query", fetch)

    titles = [title for _tid, title, _score in results]
    assert titles == ["Close Thread", "Distant Thread"]
    assert results[0][2] > results[1][2]


async def test_semantic_search_reuses_cached_embedding_for_unchanged_thread(monkeypatch) -> None:
    fake_model = _FakeModel({"Thread": [1.0, 0.0, 0.0], "Query": [1.0, 0.0, 0.0]})
    monkeypatch.setattr(conversation_search, "_load_model", lambda: fake_model)

    threads = [_thread("t1", "Thread", last_active_at="2026-01-01T00:00:00")]
    fetch = _messages_fetcher({"t1": [HumanMessage(content="Thread content")]})

    with _isolated(monkeypatch, threads):
        await conversation_search.semantic_search("Query", fetch)
        first_calls = len(fake_model.encode_calls)
        await conversation_search.semantic_search("Query", fetch)
        second_calls = len(fake_model.encode_calls)

    assert second_calls - first_calls == 1  # only the query re-encoded


async def test_semantic_search_re_embeds_when_last_active_at_changes(monkeypatch) -> None:
    fake_model = _FakeModel({"Thread": [1.0, 0.0, 0.0], "Query": [1.0, 0.0, 0.0]})
    monkeypatch.setattr(conversation_search, "_load_model", lambda: fake_model)

    threads_v1 = [_thread("t1", "Thread", last_active_at="2026-01-01T00:00:00")]
    threads_v2 = [_thread("t1", "Thread", last_active_at="2026-01-02T00:00:00")]
    fetch = _messages_fetcher({"t1": [HumanMessage(content="Thread content")]})

    with _isolated(monkeypatch, threads_v1):
        await conversation_search.semantic_search("Query", fetch)

    with _isolated(monkeypatch, threads_v2):
        calls_before = len(fake_model.encode_calls)
        await conversation_search.semantic_search("Query", fetch)
        calls_after = len(fake_model.encode_calls)

    assert calls_after - calls_before == 2  # thread re-embedded AND query encoded


async def test_semantic_search_prunes_cache_for_deleted_threads(monkeypatch) -> None:
    fake_model = _FakeModel({"Thread": [1.0, 0.0, 0.0], "Query": [1.0, 0.0, 0.0]})
    monkeypatch.setattr(conversation_search, "_load_model", lambda: fake_model)

    threads = [_thread("t1", "Thread")]
    fetch = _messages_fetcher({"t1": [HumanMessage(content="Thread content")]})

    with _isolated(monkeypatch, threads):
        await conversation_search.semantic_search("Query", fetch)
        assert len(conversation_search._load_cache()) == 1

    with _isolated(monkeypatch, []):
        await conversation_search.semantic_search("Query", fetch)
        assert conversation_search._load_cache() == {}


async def test_semantic_search_returns_empty_list_when_no_threads_exist(monkeypatch) -> None:
    with _isolated(monkeypatch, []):
        results = await conversation_search.semantic_search("anything", _messages_fetcher({}))
    assert results == []


async def test_semantic_search_skips_threads_with_no_genuine_text(monkeypatch) -> None:
    """A thread with only synthetic/tool messages (no genuine human/AI
    text) must not crash or produce a bogus embedding."""
    fake_model = _FakeModel({"Query": [1.0, 0.0, 0.0]})
    monkeypatch.setattr(conversation_search, "_load_model", lambda: fake_model)

    threads = [_thread("t1", "Empty Thread")]
    fetch = _messages_fetcher({"t1": []})

    with _isolated(monkeypatch, threads):
        results = await conversation_search.semantic_search("Query", fetch)

    assert results == []


def test_excerpt_from_messages_uses_only_genuine_human_and_ai_text() -> None:
    messages = [
        HumanMessage(content="real question"),
        AIMessage(content="real answer"),
    ]
    excerpt = conversation_search._excerpt_from_messages(messages)
    assert "real question" in excerpt
    assert "real answer" in excerpt
