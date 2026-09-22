"""Durable cross-channel activity log — one of the items scoped from a
reliability/orchestration backlog audit (STEPS.md 151), the real feature
the generic "event bus / pub-sub" wishlist item was actually gesturing at.

`active_turns.py`'s own `_recently_ended` is deliberately transient (a
30-second in-memory window) — exactly right for "did the turn I'm
currently watching just end," wrong for "what happened on the phone
channel, or a Phase 24 unattended automation, while I wasn't looking at
the dashboard at all." That's a real, standing gap given this project's
own repeatedly-stated rule (STEPS.md 122): "I always want to know if
there's a process going on in the background" — the same reasoning that
produced `active_turns.py` itself, extended here to activity that already
finished before anyone was watching.

Records ONE row per supervisor->specialist delegation (the OUTER boundary
`call_specialist` dispatches, in supervisor.py's `_make_specialist_tool`)
— deliberately NOT each specialist's own INNER tool calls
(`_AgentActivityRelay`'s per-tool `agent_activity` frames). Same scope cut
`active_turns.py`'s own module docstring already makes and explains for
the identical reason: `_invoke_agent_graph`'s nested, checkpointer-less
`ainvoke()` has no reliable `configurable.thread_id` to key a durable row
on from inside a specialist's own inner tool loop. The outer boundary
does have it (it's a supervisor-level tool call, InjectedState/get_config
both resolve normally there), and "which specialist ran, when, and
whether it succeeded" is the actually load-bearing summary for "what
happened while I was away" — a full blow-by-blow of every inner tool call
is what the LIVE `agent_activity` SSE stream is already for.

A plain `aiosqlite`-backed store, same dedicated-file convention as
`thread_store.py`/`board_store.py`/`workflow_store.py` — `activity_
log.sqlite`, WAL mode (STEPS.md 151's own WAL-mode item), bounded growth
via `prune_older_than` rather than an unbounded table (this is a recent-
activity view, not a permanent audit trail — Langfuse already owns that).
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import aiosqlite

DEFAULT_DB_PATH = Path("activity_log.sqlite")

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS activity_events (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL
)
"""

OUTCOME_SUCCESS = "success"
OUTCOME_ERROR = "error"


@dataclass
class ActivityEvent:
    id: str
    thread_id: str
    agent: str
    outcome: str
    detail: str
    started_at: str
    finished_at: str


def now_iso() -> str:
    """Public so a caller (supervisor.py's call_specialist) can capture a
    real start timestamp before invoking a specialist, not just rely on
    record_event's own default (which would make started_at == finished_at)."""
    return datetime.now(UTC).isoformat()


@asynccontextmanager
async def _connect(db_path: Path | str) -> AsyncIterator[aiosqlite.Connection]:
    async with aiosqlite.connect(str(db_path)) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute(_CREATE_SQL)
        await db.commit()
        db.row_factory = aiosqlite.Row
        yield db


def _resolve(db_path: Path | str | None) -> Path | str:
    return db_path if db_path is not None else DEFAULT_DB_PATH


async def record_event(
    thread_id: str,
    agent: str,
    outcome: str,
    *,
    detail: str = "",
    started_at: str | None = None,
    db_path: Path | str | None = None,
) -> None:
    """Record one completed supervisor->specialist delegation. Best-effort
    by convention (callers should not let a logging failure break a real
    turn) — callers are responsible for wrapping this in their own
    try/except if they want that guarantee; kept out of this function
    itself so a genuine bug here isn't silently swallowed during testing."""
    now = now_iso()
    async with _connect(_resolve(db_path)) as db:
        await db.execute(
            "INSERT INTO activity_events "
            "(id, thread_id, agent, outcome, detail, started_at, finished_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), thread_id, agent, outcome, detail, started_at or now, now),
        )
        await db.commit()


async def list_recent(limit: int = 50, db_path: Path | str | None = None) -> list[ActivityEvent]:
    """Most recent events first."""
    async with _connect(_resolve(db_path)) as db:
        cursor = await db.execute(
            "SELECT * FROM activity_events ORDER BY finished_at DESC LIMIT ?", (limit,)
        )
        rows = await cursor.fetchall()
    return [
        ActivityEvent(
            id=row["id"],
            thread_id=row["thread_id"],
            agent=row["agent"],
            outcome=row["outcome"],
            detail=row["detail"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
        )
        for row in rows
    ]


async def prune_older_than(days: int = 30, db_path: Path | str | None = None) -> int:
    """Deletes events older than `days` — bounded growth for what is meant
    to be a recent-activity view, not a permanent record (Langfuse already
    owns durable tracing). Returns the number of rows deleted."""
    cutoff = (datetime.now(UTC) - timedelta(days=days)).isoformat()
    async with _connect(_resolve(db_path)) as db:
        cursor = await db.execute("DELETE FROM activity_events WHERE finished_at < ?", (cutoff,))
        await db.commit()
        return cursor.rowcount
