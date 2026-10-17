"""Semantic search over Oni's own Obsidian vault (assistant/obsidian_tools.py),
a backlog Section 3 feature — `search_vault`'s substring matching degrades as
the vault grows past its current 138+ notes plus Oni's own accumulating
writes (a paraphrase or a synonym-shaped query finds nothing a keyword
scanner can). Deliberately additive, not a replacement: `obsidian_tools.py`'s
`search_vault` runs its existing exact substring search first (fast, precise,
and the right answer for e.g. a course code) and only adds semantic hits for
titles that search missed.

**Local embedding model, no external service** — the feature's own original
framing explicitly ruled out a per-query API cost or a new external
dependency to trust. `sentence-transformers` needs `torch`, which was
ALREADY an installed dependency of `mlx-whisper` (Phase 8's STT) — the
marginal new weight is the package itself plus a small (~90MB)
`all-MiniLM-L6-v2` model, fetched once from Hugging Face Hub on first use
and cached locally after that (confirmed live: a cold load took ~140s on
this network, a `local_files_only=True` load after caching took ~0.3s — the
difference is entirely a network round-trip checking for model updates, not
actual load time, so `_load_model()` below tries the fast local-only path
first and only falls back to a network fetch if nothing is cached yet).

**A single content-hashed cache file, not a real vector store** — the same
minimalism call this project's own Tech stack section already made once for
Facts (Chroma considered and rejected at Phase 7, "revisit if that
assumption stops holding"): at vault-scale (hundreds, not millions, of
notes), a brute-force cosine-similarity scan over an in-memory NumPy matrix
is sub-millisecond — no approximate-nearest-neighbor index is needed.
`_CACHE_PATH` (a `.npz` file, NOT inside `~/Documents/OniVault` itself,
which would put a binary non-note file into the user's real Obsidian vault
folder) stores each note's relative path, a SHA-256 of its current content,
and its embedding — a note whose hash hasn't changed reuses its cached
embedding instead of re-encoding on every search; new/edited notes are
encoded and the cache updated in place.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import numpy as np

from assistant.obsidian_tools import VAULT_DIR, in_reserved_dir

_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
_CACHE_PATH = Path(__file__).resolve().parent.parent / "vault_embeddings_cache.npz"

# Below this cosine-similarity score, a "match" is noise, not a real
# semantic hit — chosen from the live spot-check in this module's own
# build (STEPS.md 150): genuinely related text scored ~0.5, unrelated text
# ~0.1, so 0.3 sits clearly between the two rather than at either extreme.
_MIN_SIMILARITY = 0.3
_MAX_SEMANTIC_RESULTS = 5

_model: Any = None


def _load_model() -> Any:
    """Lazy singleton — never imported/loaded at module import time (this
    module is imported by obsidian_tools.py's own callers), only when a
    search actually needs it, so a request that never searches the vault
    never pays the load cost at all."""
    global _model
    if _model is not None:
        return _model
    from sentence_transformers import SentenceTransformer

    try:
        _model = SentenceTransformer(_MODEL_NAME, local_files_only=True)
    except Exception:  # noqa: BLE001 — anything from "not cached yet" to a transient
        # HF Hub hiccup all mean the same thing here: fall back to a real,
        # network-enabled load (which caches the model for every future
        # call to take the fast path above).
        _model = SentenceTransformer(_MODEL_NAME)
    return _model


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _load_cache() -> dict[str, dict[str, Any]]:
    """Returns {relpath: {"hash": str, "embedding": np.ndarray}}. Fails
    soft to an empty cache on any read/parse problem (corrupt file, wrong
    shape from a prior model version) — same "a cache is only ever a
    speed optimization, never a correctness dependency" posture as
    `cost_cache.py`'s own fail-soft `_load()`."""
    if not _CACHE_PATH.is_file():
        return {}
    try:
        data = np.load(_CACHE_PATH, allow_pickle=False)
        paths = data["paths"]
        hashes = data["hashes"]
        embeddings = data["embeddings"]
    except Exception:  # noqa: BLE001
        return {}
    return {
        str(p): {"hash": str(h), "embedding": e}
        for p, h, e in zip(paths, hashes, embeddings, strict=True)
    }


def _save_cache(cache: dict[str, dict[str, Any]]) -> None:
    try:
        paths = np.array(list(cache.keys()))
        hashes = np.array([entry["hash"] for entry in cache.values()])
        embeddings = np.array([entry["embedding"] for entry in cache.values()], dtype=np.float32)
        np.savez(_CACHE_PATH, paths=paths, hashes=hashes, embeddings=embeddings)
    except OSError:
        pass  # best-effort — a failed write only costs the next search a re-embed, not correctness


def _current_notes() -> list[Path]:
    if not VAULT_DIR.exists():
        return []
    return sorted(p for p in VAULT_DIR.rglob("*.md") if not in_reserved_dir(p, VAULT_DIR))


def semantic_search(query: str, *, top_k: int = _MAX_SEMANTIC_RESULTS) -> list[tuple[str, float]]:
    """Returns up to `top_k` (title, similarity) pairs scoring at or above
    `_MIN_SIMILARITY`, best first. Embeds the query and every current
    note's title + first ~500 characters (short enough to stay a genuine
    "what is this note about" signal, not the whole body diluting it with
    unrelated later sections) — reusing a note's cached embedding when its
    content hasn't changed since the last search."""
    notes = _current_notes()
    cache = _load_cache()
    cache_changed = False

    # Prune cache entries for notes that no longer exist (renamed/deleted
    # since the cache was last saved) — done BEFORE the "nothing to
    # search" early return below, deliberately: an empty vault (every note
    # just deleted) must still clear a now-fully-stale cache, not skip
    # pruning just because there's nothing left to embed. Needs no model,
    # so it's cheap regardless of whether a search actually proceeds.
    current_relpaths = {str(p.relative_to(VAULT_DIR)) for p in notes}
    stale = set(cache) - current_relpaths
    if stale:
        for relpath in stale:
            del cache[relpath]
        cache_changed = True

    if not notes:
        if cache_changed:
            _save_cache(cache)
        return []

    model = _load_model()
    titles: list[str] = []
    embeddings: list[np.ndarray] = []
    for path in notes:
        try:
            content = path.read_text()
        except (OSError, UnicodeDecodeError):
            continue
        relpath = str(path.relative_to(VAULT_DIR))
        excerpt = f"{path.stem}\n\n{content[:500]}"
        content_hash = _content_hash(excerpt)

        cached = cache.get(relpath)
        if cached is not None and cached["hash"] == content_hash:
            embedding = cached["embedding"]
        else:
            embedding = model.encode(excerpt)
            cache[relpath] = {"hash": content_hash, "embedding": embedding}
            cache_changed = True

        titles.append(path.stem)
        embeddings.append(embedding)

    if cache_changed:
        _save_cache(cache)

    if not embeddings:
        return []

    query_embedding = model.encode(query)
    matrix = np.array(embeddings)
    # Cosine similarity via normalized dot product — a single matrix-vector
    # multiply over the whole vault, sub-millisecond at this scale (no
    # approximate-nearest-neighbor index needed, see module docstring).
    matrix_norms = np.linalg.norm(matrix, axis=1)
    query_norm = np.linalg.norm(query_embedding)
    scores = (matrix @ query_embedding) / (matrix_norms * query_norm + 1e-8)

    ranked = sorted(zip(titles, scores.tolist(), strict=True), key=lambda pair: -pair[1])
    return [(title, score) for title, score in ranked if score >= _MIN_SIMILARITY][:top_k]
