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
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

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

# Candidates the nightly memory_review_agent proposes — never recalled,
# never treated as known facts, until a human approves them (approve_
# pending_fact moves a row into `facts` above; decline_pending_fact just
# deletes it). This table is the actual confirmation gate for memory writes
# now that extraction runs unattended overnight instead of inline in a live
# conversation — see memory_review_agent.py's module docstring for the full
# reasoning for the switch away from the old per-turn interrupt() gate.
_CREATE_PENDING_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS pending_facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    provenance TEXT,
    created_at TEXT NOT NULL
)
"""

# One row per thread: how many of that thread's genuine human turns
# memory_review_agent has already scanned, so a repeat nightly run (or a
# manual "check now") never re-proposes the same turn's facts twice.
_CREATE_REVIEW_CURSOR_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS review_cursor (
    thread_id TEXT PRIMARY KEY,
    human_turns_processed INTEGER NOT NULL
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


@dataclass(frozen=True)
class PendingFact:
    id: int
    content: str
    provenance: str | None
    created_at: str


@asynccontextmanager
async def _connect(db_path: Path | str) -> AsyncIterator[aiosqlite.Connection]:
    async with aiosqlite.connect(str(db_path)) as db:
        await db.execute(_CREATE_TABLE_SQL)
        await db.execute(_CREATE_PENDING_TABLE_SQL)
        await db.execute(_CREATE_REVIEW_CURSOR_TABLE_SQL)
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
    created_at = datetime.now(UTC).isoformat()
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


async def update_fact(
    fact_id: int,
    content: str,
    db_path: Path | str | None = None,
) -> bool:
    """Edit an already-saved fact's content in place. Same category as
    delete_fact below — the USER curating their own already-saved data, not
    a new agent-authored side effect — so this deliberately does not go
    through interrupt() either. Returns whether a row was actually updated,
    so callers can tell an already-gone id apart from a real edit."""
    db_path = db_path if db_path is not None else DEFAULT_DB_PATH
    async with _connect(db_path) as db:
        cursor = await db.execute(
            "UPDATE facts SET content = ? WHERE id = ?", (content, fact_id)
        )
        await db.commit()
        return cursor.rowcount > 0


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


async def propose_pending_fact(
    content: str,
    provenance: str | None = None,
    db_path: Path | str | None = None,
) -> int:
    """Queue a candidate fact for human review — called only by
    memory_review_agent.py's nightly pass, never directly saved to `facts`.
    Mirrors save_fact's own shape/db_path convention."""
    db_path = db_path if db_path is not None else DEFAULT_DB_PATH
    created_at = datetime.now(UTC).isoformat()
    async with _connect(db_path) as db:
        cursor = await db.execute(
            "INSERT INTO pending_facts (content, provenance, created_at) VALUES (?, ?, ?)",
            (content, provenance, created_at),
        )
        await db.commit()
        return cursor.lastrowid


async def list_pending_facts(db_path: Path | str | None = None) -> list[PendingFact]:
    db_path = db_path if db_path is not None else DEFAULT_DB_PATH
    async with _connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        rows = await db.execute_fetchall(
            "SELECT id, content, provenance, created_at FROM pending_facts ORDER BY created_at DESC"
        )
        return [PendingFact(**dict(row)) for row in rows]


async def approve_pending_fact(pending_id: int, db_path: Path | str | None = None) -> Fact | None:
    """The actual confirmation step for a nightly-proposed fact: moves it
    from `pending_facts` into the real `facts` table, verbatim — same
    TOCTOU discipline save_fact's own docstring requires (no re-extraction
    or re-rendering between what was shown and what gets saved). Returns
    the newly saved Fact, or None if `pending_id` no longer exists (already
    approved/declined, or never existed)."""
    db_path = db_path if db_path is not None else DEFAULT_DB_PATH
    async with _connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT content, provenance FROM pending_facts WHERE id = ?", (pending_id,)
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        content, provenance = row["content"], row["provenance"]
        created_at = datetime.now(UTC).isoformat()
        insert_cursor = await db.execute(
            "INSERT INTO facts (content, provenance, created_at) VALUES (?, ?, ?)",
            (content, provenance, created_at),
        )
        await db.execute("DELETE FROM pending_facts WHERE id = ?", (pending_id,))
        await db.commit()
        return Fact(id=insert_cursor.lastrowid, content=content, provenance=provenance, created_at=created_at)


async def decline_pending_fact(pending_id: int, db_path: Path | str | None = None) -> bool:
    """Discard a nightly-proposed fact without ever saving it. Returns
    whether a row was actually deleted, same already-gone-id convention as
    delete_fact above."""
    db_path = db_path if db_path is not None else DEFAULT_DB_PATH
    async with _connect(db_path) as db:
        cursor = await db.execute("DELETE FROM pending_facts WHERE id = ?", (pending_id,))
        await db.commit()
        return cursor.rowcount > 0


async def get_review_cursor(thread_id: str, db_path: Path | str | None = None) -> int:
    """How many of `thread_id`'s genuine human turns memory_review_agent has
    already scanned. 0 for a thread never scanned before."""
    db_path = db_path if db_path is not None else DEFAULT_DB_PATH
    async with _connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT human_turns_processed FROM review_cursor WHERE thread_id = ?", (thread_id,)
        )
        row = await cursor.fetchone()
        return row["human_turns_processed"] if row is not None else 0


async def set_review_cursor(
    thread_id: str, human_turns_processed: int, db_path: Path | str | None = None
) -> None:
    db_path = db_path if db_path is not None else DEFAULT_DB_PATH
    async with _connect(db_path) as db:
        await db.execute(
            "INSERT INTO review_cursor (thread_id, human_turns_processed) VALUES (?, ?) "
            "ON CONFLICT(thread_id) DO UPDATE SET human_turns_processed = excluded.human_turns_processed",
            (thread_id, human_turns_processed),
        )
        await db.commit()


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
