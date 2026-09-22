"""Semantic search over past conversation threads — one of the items
scoped from a reliability/orchestration backlog audit (STEPS.md 151), the
real, narrower version of the generic "embeddings index for past
conversations" wishlist item. Reuses `vault_search.py`'s exact embedding
approach (same local `sentence-transformers`/`all-MiniLM-L6-v2` model, same
content-hashed `.npz` cache pattern) for a genuinely distinct corpus: real
chat history, not Obsidian notes.

**Why this exists alongside Facts and the Vault, not instead of them:**
most real conversational content never gets promoted to either — Facts are
curated and explicitly approved (memory_review_agent.py's nightly review
queue), and Vault notes are only written when Oni itself decides something
is worth saving. Everything else — a decision reached mid-conversation
that was never explicitly "a fact," an explanation given once and never
repeated — is only searchable today by scrolling the History panel one
thread at a time. This closes that gap.

**Not exposed as an agent tool, deliberately — a server-side dashboard
feature instead.** An agent tool would need the SUPERVISOR's own compiled
graph to call `graph.aget_state()` per thread (this project's own
established, correct way to read persisted state — `/history`'s own
docstring already flags hand-parsing the checkpointer directly as "the
wrong way to do it", STEPS.md 54), but the graph object doesn't exist yet
while its own tools are still being constructed inside `build_graph()` — a
real circular dependency. Building it as `GET /search/conversations`
instead (server.py, which already holds `app.state.graph` post-construction)
sidesteps that entirely, and a human digging through their own past threads
is at least as real a use case as an agent doing it autonomously.

Decoupled from the graph itself via a plain `fetch_messages` callable
parameter (`str -> Awaitable[list[BaseMessage]]`) rather than importing
`assistant.server` or taking a graph object directly — keeps this module
unit-testable with a fake, and avoids a supervisor.py<->server.py import
cycle.

Cache keyed by `last_active_at` (from `thread_store.list_threads()`, a
cheap SQLite read), not a content hash of the full message list — cheaper
to check "has this thread changed" without needing to fetch and re-render
every thread's full history on every search just to compute a hash.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import numpy as np
from langchain_core.messages import AnyMessage, BaseMessage

from assistant import thread_store
from assistant.compaction import is_genuine_human_turn
from assistant.memory_extraction import text_only_content

_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
_CACHE_PATH = Path(__file__).resolve().parent.parent / "conversation_embeddings_cache.npz"

# Same calibration as vault_search.py's own — same model, same scoring
# scale, no reason to re-derive a separate threshold for a different corpus.
_MIN_SIMILARITY = 0.3
_MAX_RESULTS = 5

# How many of a thread's most recent genuine (non-synthetic) text messages
# to fold into its embedded excerpt — the RECENT end of a thread, not the
# start (vault_search.py uses a note's first ~500 chars because a note's
# opening is usually its summary; a conversation's most recent turns are
# usually the better signal for "what did this thread end up being about,"
# especially once compaction has already summarized everything earlier).
_EXCERPT_MESSAGE_COUNT = 6
_EXCERPT_MAX_CHARS = 500

_model: Any = None


def _load_model() -> Any:
    """Lazy singleton, same as vault_search.py's own — shares the actual
    loaded model object with it at the Python-module level (importing
    sentence_transformers twice doesn't double-load; both modules calling
    SentenceTransformer(_MODEL_NAME) hit the SAME underlying HF cache),
    but each module keeps its own singleton variable rather than sharing
    one, since a truly shared cache would create exactly the "which
    module's monkeypatch wins" test-isolation risk test_vault_search.py's
    own STEPS.md 150 already documented once."""
    global _model
    if _model is not None:
        return _model
    from sentence_transformers import SentenceTransformer

    try:
        _model = SentenceTransformer(_MODEL_NAME, local_files_only=True)
    except Exception:  # noqa: BLE001 — see vault_search.py's own identical comment
        _model = SentenceTransformer(_MODEL_NAME)
    return _model


def _load_cache() -> dict[str, dict[str, Any]]:
    if not _CACHE_PATH.is_file():
        return {}
    try:
        data = np.load(_CACHE_PATH, allow_pickle=False)
        thread_ids = data["thread_ids"]
        marks = data["marks"]
        embeddings = data["embeddings"]
    except Exception:  # noqa: BLE001
        return {}
    return {
        str(tid): {"mark": str(m), "embedding": e}
        for tid, m, e in zip(thread_ids, marks, embeddings, strict=True)
    }


def _save_cache(cache: dict[str, dict[str, Any]]) -> None:
    try:
        thread_ids = np.array(list(cache.keys()))
        marks = np.array([entry["mark"] for entry in cache.values()])
        embeddings = np.array([entry["embedding"] for entry in cache.values()], dtype=np.float32)
        np.savez(_CACHE_PATH, thread_ids=thread_ids, marks=marks, embeddings=embeddings)
    except OSError:
        pass  # best-effort, same posture as vault_search.py's own _save_cache


def _excerpt_from_messages(messages: list[AnyMessage]) -> str:
    """The most recent genuine (non-synthetic) text turns, concatenated and
    capped — mirrors vault_search.py's own "title + short excerpt" idea for
    a corpus where there's no title, just message text."""
    genuine_text = [
        text_only_content(m.content) for m in messages if is_genuine_human_turn(m) or m.type == "ai"
    ]
    genuine_text = [t for t in genuine_text if t.strip()]
    recent = genuine_text[-_EXCERPT_MESSAGE_COUNT:]
    excerpt = "\n".join(recent)
    return excerpt[:_EXCERPT_MAX_CHARS]


async def semantic_search(
    query: str,
    fetch_messages: Callable[[str], Awaitable[list[BaseMessage]]],
    *,
    top_k: int = _MAX_RESULTS,
) -> list[tuple[str, str, float]]:
    """Returns up to `top_k` (thread_id, title, similarity) triples at or
    above `_MIN_SIMILARITY`, best first. `fetch_messages(thread_id)` is the
    caller's own way of reading a thread's persisted messages — server.py
    passes a small wrapper around `graph.aget_state()`; tests pass a fake."""
    threads = await thread_store.list_threads()
    cache = _load_cache()
    cache_changed = False

    current_ids = {t.id for t in threads}
    stale = set(cache) - current_ids
    if stale:
        for thread_id in stale:
            del cache[thread_id]
        cache_changed = True

    if not threads:
        if cache_changed:
            _save_cache(cache)
        return []

    model = _load_model()
    thread_ids: list[str] = []
    titles: list[str] = []
    embeddings: list[np.ndarray] = []

    for thread in threads:
        cached = cache.get(thread.id)
        if cached is not None and cached["mark"] == thread.last_active_at:
            embedding = cached["embedding"]
        else:
            messages = await fetch_messages(thread.id)
            excerpt = _excerpt_from_messages(messages)
            if not excerpt:
                continue
            title = thread.title or "(untitled thread)"
            embedding = model.encode(f"{title}\n\n{excerpt}")
            cache[thread.id] = {"mark": thread.last_active_at, "embedding": embedding}
            cache_changed = True

        thread_ids.append(thread.id)
        titles.append(thread.title or "(untitled thread)")
        embeddings.append(embedding)

    if cache_changed:
        _save_cache(cache)

    if not embeddings:
        return []

    query_embedding = model.encode(query)
    matrix = np.array(embeddings)
    matrix_norms = np.linalg.norm(matrix, axis=1)
    query_norm = np.linalg.norm(query_embedding)
    scores = (matrix @ query_embedding) / (matrix_norms * query_norm + 1e-8)

    ranked = sorted(
        zip(thread_ids, titles, scores.tolist(), strict=True), key=lambda triple: -triple[2]
    )
    return [(tid, title, score) for tid, title, score in ranked if score >= _MIN_SIMILARITY][:top_k]
