"""Chunk-level hybrid retrieval over Oni's Obsidian vault (docs/SPEED_RESEARCH.md R3).

`vault_search.py` (the earlier semantic layer) embeds each note's title plus its first 500 characters,
so a question about anything deeper in a note cannot be answered, and `search_vault`'s substring pass
needs the WHOLE query to appear verbatim, which a natural-language question never does. On the real
vault (454 notes, 7,982 chunks) that scored recall@5 of 0.10 on keyword-style queries and 0.30 on
paraphrases. This module adds what the InnoWing chatbot-challenge repo does: heading-aware chunks,
BM25 plus dense retrieval fused with Reciprocal Rank Fusion (no score calibration needed), and the
best chunk, not the whole note, as the unit handed back.

**Additive by construction.** `obsidian_tools.search_vault` still runs its exact substring pass and the
older semantic pass first; this module's hits are added for notes those passes did not list, so nothing
that is found today stops being found. `read_vault_note` still returns a whole note; only a note longer
than `FULL_READ_CHARS` (and not authored by Oni, so never a basis for `update_vault_note`) is cut, and
the cut is announced with an outline and the exact way to fetch the rest. Nothing is hidden silently.

**BM25 needs no model and no cache, dense does.** BM25 is rebuilt in memory whenever a stat-based
signature of the vault changes (about 15 ms for 454 notes). Chunk embeddings (13 s for the whole
vault) are cached by content hash in a gitignored `.npz`, like `vault_search.py`'s cache. A search
never waits on a large embedding job: with embeddings missing it answers BM25-only and finishes the
job in a background thread (`preload_in_background()` starts it at backend launch), then hybrid
resumes. Both retrievers are local; there is no per-query API cost.
"""

from __future__ import annotations

import hashlib
import logging
import math
import re
import threading
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from assistant import obsidian_tools
from assistant.obsidian_tools import in_reserved_dir

logger = logging.getLogger(__name__)

_CACHE_PATH = Path(__file__).resolve().parent.parent / "vault_chunk_embeddings_cache.npz"

CHUNK_CHARS = 800
CHUNK_OVERLAP = 100
# A note longer than this is cut on a plain read (about 5.7k tokens; 41 of 454 notes today). The
# supervisor's 25-tool context pays for every character a read returns, and the mean read was 3.1k tokens.
FULL_READ_CHARS = 20_000

_BM25_K1, _BM25_B = 1.5, 0.75
_RRF_K = 60
_BM25_WEIGHT, _DENSE_WEIGHT = 2.0, 1.0  # measured best on the vault: keyword-style queries dominate
_MIN_DENSE_SIMILARITY = 0.3  # same calibration as vault_search.py (related ~0.5, unrelated ~0.1)
_CANDIDATES = 20
_SYNC_EMBED_LIMIT = 200  # chunks embedded inline (a note Oni just wrote); more goes to the background

_STOPWORDS = frozenset(
    "the a an and or of to in on for with is are was were be been it this that as at by from your you i my me "
    "we our they their he she his her not but if then so do does did have has had will would can could should "
    "about into over than which who what when where how also just more most some any all one two there here "
    "these those up out no yes".split()
)
_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9\-']+")
_HEADING = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$", re.MULTILINE)
_SPLIT_HEADING = re.compile(r"^(?=#{1,3} )", re.MULTILINE)
_FRONTMATTER = re.compile(r"\A---\n.*?\n---\n", re.DOTALL)


def tokenize(text: str) -> list[str]:
    return [w for w in _TOKEN.findall(text.lower()) if w not in _STOPWORDS]


@dataclass(frozen=True)
class Chunk:
    title: str  # note title (filename stem)
    relpath: str
    heading: str  # the level 1-3 heading the chunk sits under ("" before the first)
    start: int  # offsets into the note body (front matter removed)
    end: int
    position: int  # chunk number within its note
    text: str  # what is indexed: title, heading, then the body slice

    @property
    def hash(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()[:24]


def strip_frontmatter(content: str) -> str:
    return _FRONTMATTER.sub("", content, count=1)


def chunk_note(title: str, relpath: str, content: str) -> list[Chunk]:
    """Heading-aware windows of `CHUNK_CHARS` with `CHUNK_OVERLAP`; always at least one chunk."""
    body = strip_frontmatter(content)
    cuts = sorted({0, *(m.start() for m in _SPLIT_HEADING.finditer(body))})
    edges = [*cuts, len(body)]
    chunks: list[Chunk] = []
    step = CHUNK_CHARS - CHUNK_OVERLAP
    for s, e in zip(edges, edges[1:], strict=False):
        part = body[s:e]
        first = part.lstrip().split("\n", 1)[0]
        heading = first.lstrip("#").strip() if first.startswith("#") else ""
        if not part.strip():
            continue
        for j in range(0, len(part), step):
            seg = part[j : j + CHUNK_CHARS]
            if len(seg.strip()) <= 40 and chunks and j:
                continue  # a tail sliver adds nothing the previous window's overlap does not cover
            text = f"{title}\n{heading}\n{seg}" if heading else f"{title}\n{seg}"
            chunks.append(Chunk(title, relpath, heading, s + j, s + j + len(seg), len(chunks), text))
            if j + CHUNK_CHARS >= len(part):
                break
    if not chunks:
        chunks.append(Chunk(title, relpath, "", 0, 0, 0, title))
    return chunks


@dataclass
class Index:
    chunks: list[Chunk]
    bodies: dict[str, str]  # relpath -> body, for rendering merged ranges
    by_note: dict[str, list[int]]
    postings: dict[str, tuple[np.ndarray, np.ndarray]]
    lengths: np.ndarray
    avg_length: float
    signature: tuple[Any, ...]
    matrix: np.ndarray | None = None  # normalised chunk embeddings once every chunk has one
    _lock: threading.Lock = field(default_factory=threading.Lock)


_state: Index | None = None
_state_lock = threading.RLock()
_emb_cache: dict[str, np.ndarray] | None = None
_warm_thread: threading.Thread | None = None


def _vault_dir() -> Path:
    # Read through the module on every call, not `from ... import VAULT_DIR`: tests (and anything else that
    # retargets the vault) patch `obsidian_tools.VAULT_DIR`, and a second binding here would keep indexing
    # the real vault.
    return obsidian_tools.VAULT_DIR


def _notes() -> list[Path]:
    root = _vault_dir()
    if not root.exists():
        return []
    return sorted(p for p in root.rglob("*.md") if not in_reserved_dir(p, root))


def _signature(paths: list[Path]) -> tuple[Any, ...]:
    sig = []
    for p in paths:
        try:
            st = p.stat()
        except OSError:
            continue
        sig.append((str(p.relative_to(_vault_dir())), st.st_mtime_ns, st.st_size))
    return tuple(sig)


def _build(paths: list[Path], signature: tuple[Any, ...]) -> Index:
    chunks: list[Chunk] = []
    bodies: dict[str, str] = {}
    for p in paths:
        try:
            content = p.read_text()
        except (OSError, UnicodeDecodeError):
            continue
        rel = str(p.relative_to(_vault_dir()))
        bodies[rel] = strip_frontmatter(content)
        chunks.extend(chunk_note(p.stem, rel, content))
    by_note: dict[str, list[int]] = {}
    tf_by_term: dict[str, list[tuple[int, int]]] = {}
    lengths = np.zeros(len(chunks), dtype=np.float32)
    for i, c in enumerate(chunks):
        by_note.setdefault(c.relpath, []).append(i)
        counts = Counter(tokenize(c.text))
        lengths[i] = sum(counts.values())
        for term, n in counts.items():
            tf_by_term.setdefault(term, []).append((i, n))
    postings = {
        term: (np.array([i for i, _ in rows], dtype=np.int32), np.array([n for _, n in rows], dtype=np.float32))
        for term, rows in tf_by_term.items()
    }
    avg = float(lengths.mean()) if len(chunks) else 1.0
    return Index(chunks, bodies, by_note, postings, lengths, avg or 1.0, signature)


def get_index() -> Index:
    """The current index, rebuilt only when a note was added, edited, renamed or removed."""
    global _state
    paths = _notes()
    signature = _signature(paths)
    with _state_lock:
        if _state is None or _state.signature != signature:
            _state = _build(paths, signature)
        return _state


# ---------------------------------------------------------------------------------------------
# Embeddings
# ---------------------------------------------------------------------------------------------


def _load_embedding_cache() -> dict[str, np.ndarray]:
    global _emb_cache
    if _emb_cache is not None:
        return _emb_cache
    cache: dict[str, np.ndarray] = {}
    if _CACHE_PATH.is_file():
        try:
            data = np.load(_CACHE_PATH, allow_pickle=False)
            cache = {str(k): e for k, e in zip(data["keys"], data["embeddings"], strict=True)}
        except Exception:  # noqa: BLE001 - a cache is a speed optimisation, never a correctness dependency
            cache = {}
    _emb_cache = cache
    return cache


def _save_embedding_cache(live: set[str]) -> None:
    cache = _load_embedding_cache()
    for stale in set(cache) - live:
        del cache[stale]
    try:
        keys = np.array(list(cache))
        emb = np.array([cache[k] for k in keys], dtype=np.float32) if cache else np.zeros((0, 1), dtype=np.float32)
        np.savez(_CACHE_PATH, keys=keys, embeddings=emb)
    except OSError:
        pass


def _model() -> Any:
    from assistant import vault_search

    return vault_search._load_model()


def _model_loaded() -> bool:
    from assistant import vault_search

    return vault_search._model is not None


def _encode(texts: list[str]) -> np.ndarray:
    return np.asarray(
        _model().encode(texts, batch_size=64, normalize_embeddings=True, show_progress_bar=False), dtype=np.float32
    )


def _embed_missing(index: Index) -> None:
    """Embed every chunk of `index` that has no cached vector, then publish the matrix."""
    with index._lock:
        cache = _load_embedding_cache()
        missing = {}
        for c in index.chunks:
            if c.hash not in cache:
                missing.setdefault(c.hash, c.text)
        if missing:
            keys = list(missing)
            vectors = _encode([missing[k] for k in keys])
            for k, v in zip(keys, vectors, strict=True):
                cache[k] = v
            _save_embedding_cache({c.hash for c in index.chunks})
        index.matrix = np.stack([cache[c.hash] for c in index.chunks]) if index.chunks else None


def _dense_matrix(index: Index) -> np.ndarray | None:
    """The chunk embedding matrix if it is ready or cheap to finish now, else None (BM25-only)."""
    if index.matrix is not None:
        return index.matrix
    cache = _load_embedding_cache()
    n_missing = len({c.hash for c in index.chunks if c.hash not in cache})
    if n_missing == 0 or (n_missing <= _SYNC_EMBED_LIMIT and _model_loaded()):
        try:
            _embed_missing(index)
        except Exception:  # noqa: BLE001 - dense is an enhancement; BM25 still answers
            logger.exception("vault chunk embedding failed")
            return None
        return index.matrix
    _start_warm()
    return None


def _warm() -> None:
    try:
        index = get_index()
        _model()
        _embed_missing(index)
    except Exception:  # noqa: BLE001
        logger.exception("vault index warm-up failed")


def _start_warm() -> None:
    global _warm_thread
    with _state_lock:
        if _warm_thread is not None and _warm_thread.is_alive():
            return
        _warm_thread = threading.Thread(target=_warm, name="vault-index-warm", daemon=True)
        _warm_thread.start()


def preload_in_background() -> None:
    """Load the embedding model, build the index and embed missing chunks off the request path.

    Called once at backend start so the first `search_vault` of a session neither pays the model load
    (~0.3 s warm, up to ~140 s cold on a bad network) nor the 13 s first-time embedding of the vault."""
    _start_warm()


# ---------------------------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------------------------


def bm25_scores(index: Index, query: str) -> np.ndarray:
    n = len(index.chunks)
    scores = np.zeros(n, dtype=np.float32)
    for term in set(tokenize(query)):
        posting = index.postings.get(term)
        if posting is None:
            continue
        idx, tf = posting
        idf = math.log(1 + (n - len(idx) + 0.5) / (len(idx) + 0.5))
        scores[idx] += idf * tf * (_BM25_K1 + 1) / (tf + _BM25_K1 * (1 - _BM25_B + _BM25_B * index.lengths[idx] / index.avg_length))
    return scores


def dense_scores(index: Index, query: str) -> np.ndarray | None:
    matrix = _dense_matrix(index)
    if matrix is None:
        return None
    try:
        return matrix @ _encode([query])[0]
    except Exception:  # noqa: BLE001
        logger.exception("vault query embedding failed")
        return None


def _note_ranking(index: Index, scores: np.ndarray, floor: float, limit: int) -> list[tuple[str, int]]:
    """Notes ranked by their best chunk above `floor`: [(relpath, best_chunk_index)]."""
    best: dict[str, int] = {}
    for i in np.argsort(-scores)[: limit * 6]:
        if scores[i] <= floor:
            break
        rel = index.chunks[i].relpath
        if rel not in best:
            best[rel] = int(i)
        if len(best) >= limit:
            break
    return list(best.items())


def search(query: str, *, top_k: int = 8) -> list[tuple[Chunk, float]]:
    """Notes best matching `query`, each with its best chunk: BM25 and dense fused with RRF.

    Dense candidates must clear a similarity floor, BM25 candidates must share a query term, so an
    unrelated query returns nothing instead of the least-bad notes."""
    index = get_index()
    if not index.chunks or not tokenize(query) and not query.strip():
        return []
    lists: list[tuple[float, list[tuple[str, int]]]] = [(_BM25_WEIGHT, _note_ranking(index, bm25_scores(index, query), 0.0, _CANDIDATES))]
    dense = dense_scores(index, query)
    if dense is not None:
        lists.append((_DENSE_WEIGHT, _note_ranking(index, dense, _MIN_DENSE_SIMILARITY, _CANDIDATES)))
    fused: dict[str, float] = {}
    best_chunk: dict[str, int] = {}
    for weight, ranking in lists:
        for rank, (rel, chunk_i) in enumerate(ranking, 1):
            fused[rel] = fused.get(rel, 0.0) + weight / (_RRF_K + rank)
            best_chunk.setdefault(rel, chunk_i)  # BM25's pick wins when both found the note
    ordered = sorted(fused, key=lambda r: -fused[r])[:top_k]
    return [(index.chunks[best_chunk[r]], fused[r]) for r in ordered]


def note_rankings(query: str) -> list[str]:
    """Note titles for `query`, best first, for benchmarks and tests."""
    return [c.title for c, _ in search(query, top_k=10)]


# ---------------------------------------------------------------------------------------------
# Reading part of one note
# ---------------------------------------------------------------------------------------------


def outline(body: str) -> list[tuple[int, int, str]]:
    """(level, offset, heading) for each markdown heading, ignoring lines inside code fences."""
    fences = [m.start() for m in re.finditer(r"^```", body, re.MULTILINE)]
    out = []
    for m in _HEADING.finditer(body):
        if sum(1 for f in fences if f < m.start()) % 2:
            continue
        out.append((len(m.group(1)), m.start(), m.group(2).strip()))
    return out


def read_section(body: str, section: str) -> str | None:
    """The text under the heading matching `section` (exact, else substring, case-insensitive),
    through the next heading of the same or a higher level. None if no heading matches."""
    heads = outline(body)
    want = section.strip().lower().lstrip("# ").strip()
    pick = next((h for h in heads if h[2].lower() == want), None) or next((h for h in heads if want in h[2].lower()), None)
    if pick is None:
        return None
    level, start, _ = pick
    end = next((off for lvl, off, _ in heads if off > start and lvl <= level), len(body))
    return body[start:end].rstrip()


def read_relevant(relpath: str, query: str, *, top_chunks: int = 3, neighbours: int = 1) -> str | None:
    """The `top_chunks` chunks of one note that best match `query`, each widened by `neighbours`
    chunks either side, merged into position order. None if the note is not indexed."""
    index = get_index()
    ids = index.by_note.get(relpath)
    if not ids:
        return None
    bm = bm25_scores(index, query)[ids]
    dense = dense_scores(index, query)
    fused = np.zeros(len(ids))
    for weight, scores in ((_BM25_WEIGHT, bm), (_DENSE_WEIGHT, None if dense is None else dense[ids])):
        if scores is None:
            continue
        for rank, k in enumerate(np.argsort(-scores), 1):
            if scores[k] > (0.0 if scores is bm else _MIN_DENSE_SIMILARITY):
                fused[k] += weight / (_RRF_K + rank)
    order = [int(k) for k in np.argsort(-fused) if fused[k] > 0][:top_chunks]
    if not order:
        return ""
    keep: set[int] = set()
    for k in order:
        keep.update(range(max(0, k - neighbours), min(len(ids), k + neighbours + 1)))
    body = index.bodies[relpath]
    spans: list[list[int]] = []
    for k in sorted(keep):
        c = index.chunks[ids[k]]
        if spans and c.start <= spans[-1][1]:
            spans[-1][1] = max(spans[-1][1], c.end)
        else:
            spans.append([c.start, c.end])
    return "\n\n[…]\n\n".join(body[s:e].strip() for s, e in spans)


def reset_for_tests() -> None:
    """Drop all in-memory state (tests patch obsidian_tools.VAULT_DIR and the cache path)."""
    global _state, _emb_cache, _warm_thread
    _state, _emb_cache, _warm_thread = None, None, None
