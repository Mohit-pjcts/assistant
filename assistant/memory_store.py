"""Long-term memory storage — Phase 7 Part B.

A separate SQLite file from conversation_memory.sqlite (memory.py) — that
file's schema is owned entirely by AsyncSqliteSaver's own checkpoint
machinery; a custom facts table has no business sharing it. Uses aiosqlite
directly (already a transitive dependency of langgraph-checkpoint-sqlite,
now made explicit) rather than SQLAlchemy or an ORM — one small table, no
migrations story needed yet.

Storage choice (PLAN.md Phase 7 checkpoint, confirmed at scope time rather
than defaulting to Chroma just because it was named once in Phase 1): plain
SQLite + recency/keyword retrieval. A single user's durable facts are
expected to number in the dozens to low hundreds — small enough that a full
embedding-based vector store is premature complexity (a new embedding-model
choice, a cost line, another persistence file) for a recall problem this
small. Revisit if fact volume ever outgrows keyword matching.
"""

from __future__ import annotations

import re
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator

import aiosqlite

DEFAULT_DB_PATH = Path("long_term_memory.sqlite")

_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    provenance TEXT,
    created_at TEXT NOT NULL
)
"""

# Facts at or below this count are always all recalled (cheap enough that
# keyword filtering would just add noise for no benefit) — see recall_facts.
_SMALL_STORE_THRESHOLD = 5
_RECALL_LIMIT = 5
_WORD_RE = re.compile(r"[a-z0-9]+")


@dataclass(frozen=True)
class Fact:
    id: int
    content: str
    provenance: str | None
    created_at: str


@asynccontextmanager
async def _connect(db_path: Path | str) -> AsyncIterator[aiosqlite.Connection]:
    async with aiosqlite.connect(str(db_path)) as db:
        await db.execute(_CREATE_TABLE_SQL)
        await db.commit()
        yield db


async def save_fact(
    content: str,
    provenance: str | None = None,
    db_path: Path | str | None = None,
) -> int:
    """Persist a fact. `content` must be exactly the string the user
    approved at the confirmation gate — callers must never re-extract or
    re-render before calling this (memory_extraction.py's TOCTOU
    requirement).

    db_path defaults to None (resolved to DEFAULT_DB_PATH inside the
    function body, not bound as a parameter default) so tests can redirect
    storage by monkeypatching the module-level DEFAULT_DB_PATH — a
    parameter default is bound once at function-definition time and would
    silently ignore a later monkeypatch (caught by a real test failure)."""
    db_path = db_path if db_path is not None else DEFAULT_DB_PATH
    created_at = datetime.now(timezone.utc).isoformat()
    async with _connect(db_path) as db:
        cursor = await db.execute(
            "INSERT INTO facts (content, provenance, created_at) VALUES (?, ?, ?)",
            (content, provenance, created_at),
        )
        await db.commit()
        return cursor.lastrowid


async def list_facts(db_path: Path | str | None = None) -> list[Fact]:
    db_path = db_path if db_path is not None else DEFAULT_DB_PATH
    async with _connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        rows = await db.execute_fetchall(
            "SELECT id, content, provenance, created_at FROM facts ORDER BY created_at DESC"
        )
        return [Fact(**dict(row)) for row in rows]


async def delete_fact(fact_id: int, db_path: Path | str | None = None) -> bool:
    """Delete a stored fact by id. Phase 9's memory-review panel: the USER
    curating their own already-saved data, not a new agent-authored side
    effect — deliberately does not go through interrupt() (that gate is for
    the agent's own autonomous writes; see memory_extraction.py's
    docstring). Returns whether a row was actually deleted, so callers can
    tell an already-gone id apart from a real deletion."""
    db_path = db_path if db_path is not None else DEFAULT_DB_PATH
    async with _connect(db_path) as db:
        cursor = await db.execute("DELETE FROM facts WHERE id = ?", (fact_id,))
        await db.commit()
        return cursor.rowcount > 0


def _keywords(text: str) -> set[str]:
    return set(_WORD_RE.findall(text.lower()))


async def recall_facts(
    query_text: str,
    limit: int = _RECALL_LIMIT,
    db_path: Path | str | None = None,
) -> list[Fact]:
    """Selective recall, not dump-everything (PLAN.md's Phase 7 requirement):
    below _SMALL_STORE_THRESHOLD facts, return all of them (filtering would
    just add noise for no real benefit at that scale); above it, score by
    keyword overlap with `query_text` and recency, returning only facts that
    actually share a keyword with the query."""
    db_path = db_path if db_path is not None else DEFAULT_DB_PATH
    facts = await list_facts(db_path)
    if not facts:
        return []
    if len(facts) <= _SMALL_STORE_THRESHOLD:
        return facts

    query_words = _keywords(query_text)
    if not query_words:
        return facts[:limit]  # nothing to score against — fall back to most recent

    scored = [(len(query_words & _keywords(f.content)), f) for f in facts]
    scored = [(score, f) for score, f in scored if score > 0]
    scored.sort(key=lambda pair: (pair[0], pair[1].created_at), reverse=True)
    return [f for _, f in scored[:limit]]
