"""Durable record of everything an agent does that the checkpoint doesn't keep
— the data behind the dashboard's History panel (STEPS.md 158: "every tool
call, every agent delegation... History should contain every piece of
information in every call").

Why this exists as its own store: the checkpoint already keeps the
SUPERVISOR's tool calls (an AIMessage's `tool_calls` plus the matching
ToolMessage) and its own replies, but nothing keeps a specialist's work —
`supervisor.py`'s `_invoke_agent_graph` runs a fresh, checkpointer-less
`ainvoke()` and throws its message list away the moment it returns, so its
inner tool calls and what it said between them only ever existed as live
`agent_activity` SSE frames (names only, no arguments, no output).
`activity_log.py` is the other nearby record, but it is deliberately one row
per supervisor->specialist boundary with no arguments or outputs, and it
prunes itself. This one is the full record, written by
`tool_trace.ToolTraceMiddleware` as each step ends.

**Two kinds of row** (`kind`), both in one table so a specialist's run reads
back as one ordered list (`seq`):

- `'tool'` — one tool call: `input` is the JSON of its arguments, `output` its
  result text, `extras` the JSON of whatever else its ToolMessage carried
  (`additional_kwargs`: an A2UI surface, a phone action, ...).
- `'assistant'` — one model turn of a specialist: `output` is what it said,
  `thinking` what it reasoned, `extras` its token usage and stop reason, `name`
  the model. (The supervisor's own turns are in the checkpoint; recording
  them here too would duplicate.)

`parent_tool_call_id` is what makes the specialists' discarded work
recoverable: a specialist's rows point at the supervisor-level delegation call
that spawned them, and `history_trace.py` nests them back under it. A
supervisor-level call has no parent.

Same dedicated-file convention as `activity_log.py`/`thread_store.py`
(`traces.sqlite`, WAL mode, one short connection per operation; already
gitignored by `*.sqlite`). Two deliberate differences from `activity_log.py`:
nothing prunes automatically (the user wants the whole history;
`prune_older_than` exists for a later retention decision and nothing calls
it), and each text field is capped at `MAX_FIELD_CHARS` with an explicit tail
saying how much was left out, so one runaway tool result can't grow the file
without bound while a clipped value still says it was clipped.

This holds full tool inputs and outputs — email bodies, file contents,
screen text — the same sensitivity as `conversation_memory.sqlite`, which is
why the endpoints that read it are loopback-only (`local_only.py`).
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
import threading
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, closing
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import aiosqlite

DEFAULT_DB_PATH = Path("traces.sqlite")

# Per text field (input, output, thinking, extras, error). Generous on purpose
# — the cap exists for a pathological result (a whole mailbox, a runaway shell
# output), not to trim normal ones.
MAX_FIELD_CHARS = 200_000

STATUS_OK = "ok"
STATUS_ERROR = "error"
# A confirmation gate paused the call (interrupt()). The call is replayed on
# /resume and recorded again then, under the same tool_call_id.
STATUS_INTERRUPTED = "interrupted"

KIND_TOOL = "tool"
KIND_ASSISTANT = "assistant"

_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS trace_rows (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        thread_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        parent_tool_call_id TEXT,
        agent TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'tool',
        input TEXT NOT NULL,
        output TEXT,
        thinking TEXT,
        extras TEXT,
        status TEXT NOT NULL,
        error TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        duration_ms INTEGER
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_trace_rows_thread_seq ON trace_rows (thread_id, seq)",
    "CREATE INDEX IF NOT EXISTS idx_trace_rows_tool_call_id ON trace_rows (tool_call_id)",
    # Only for `record_call`'s MAX(seq): without it every insert would scan
    # the whole table to find the next number.
    "CREATE INDEX IF NOT EXISTS idx_trace_rows_seq ON trace_rows (seq)",
)


@dataclass
class TraceRow:
    """One recorded row (see the module docstring for the two kinds).
    `input` is the JSON text of a tool call's arguments (empty for a model
    turn); `output`/`thinking`/`extras`/`error` are None when there was none —
    an interrupted call has neither output nor error, a bare model turn no
    thinking. `extras` is JSON text. `seq` is the insert order, so rows sort
    the way things finished even when two share a timestamp. For a model turn,
    `tool_call_id` is the reply's own message id (or a generated one) and
    `name` the model."""

    id: str
    seq: int
    thread_id: str
    tool_call_id: str
    parent_tool_call_id: str | None
    agent: str
    name: str
    kind: str
    input: str
    output: str | None
    thinking: str | None
    extras: str | None
    status: str
    error: str | None
    started_at: str
    ended_at: str
    duration_ms: int | None


def now_iso() -> str:
    """Public so a caller can take a real start timestamp before running a
    call — `record_call`'s own default would make started_at == ended_at."""
    return datetime.now(UTC).isoformat()


def _cap(text: str | None) -> str | None:
    """`text` clipped to MAX_FIELD_CHARS, with a tail that says how many
    characters were dropped — a clipped value must never pass for a whole
    one."""
    if text is None or len(text) <= MAX_FIELD_CHARS:
        return text
    dropped = len(text) - MAX_FIELD_CHARS
    return f"{text[:MAX_FIELD_CHARS]}\n[… {dropped} more characters not stored]"


# Files whose WAL mode and schema this process has already set up.
_ready: set[str] = set()
_setup_lock = threading.Lock()


def _setup(path: str) -> None:
    """One-time WAL mode + schema for a file, one thread at a time.

    Done once per file rather than on every connection (the pattern in
    activity_log.py/thread_store.py) because here several calls routinely
    finish at the same instant — a research agent fans out web searches in
    parallel — and on a brand-new file every one of them would race to
    CREATE TABLE: each connection reads the schema, then tries to upgrade to a
    write after another has already committed, and SQLite fails that upgrade
    at once ("database is locked") instead of waiting. Found by this module's
    own concurrent-insert test. WAL is stored in the file, so once is enough;
    the INSERTs that follow take the write lock at the start of their
    statement and wait their turn normally."""
    with _setup_lock:
        if path in _ready and os.path.exists(path):
            return
        with closing(sqlite3.connect(path)) as db:
            db.execute("PRAGMA journal_mode=WAL")
            for statement in _SCHEMA:
                db.execute(statement)
            db.commit()
        _ready.add(path)


@asynccontextmanager
async def _connect(db_path: Path | str) -> AsyncIterator[aiosqlite.Connection]:
    path = os.path.abspath(str(db_path))
    # The existence check covers a file deleted under a running server (the
    # user clearing traces.sqlite): it is set up again instead of failing on a
    # missing table forever.
    if path not in _ready or not os.path.exists(path):
        await asyncio.to_thread(_setup, path)
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        yield db


def _resolve(db_path: Path | str | None) -> Path | str:
    # Looked up per call, not bound as a parameter default, so a later
    # override of DEFAULT_DB_PATH (server.py's env redirect, a test's
    # monkeypatch) is honoured.
    return db_path if db_path is not None else DEFAULT_DB_PATH


async def record_call(
    thread_id: str,
    tool_call_id: str,
    agent: str,
    name: str,
    *,
    parent_tool_call_id: str | None = None,
    kind: str = KIND_TOOL,
    input: str = "",  # named like the column, so a row reads the same in SQL and in code
    output: str | None = None,
    thinking: str | None = None,
    extras: str | None = None,
    status: str = STATUS_OK,
    error: str | None = None,
    started_at: str | None = None,
    ended_at: str | None = None,
    duration_ms: int | None = None,
    db_path: Path | str | None = None,
) -> str:
    """Record one finished (or interrupted) tool call or model turn and return
    its row id. Best-effort by convention, same as `activity_log.record_event`:
    a caller that must not fail on a logging problem wraps this itself
    (`tool_trace.ToolTraceMiddleware` does) — kept out of here so a genuine
    bug isn't silently swallowed under test.

    `extras` is JSON text, serialised by the caller like `input`.

    `seq` is taken inside the INSERT itself (`MAX(seq) + 1`), so two calls
    finishing at once can't draw the same number: SQLite serialises writers
    and the subselect runs under the write lock the INSERT already holds."""
    now = now_iso()
    row_id = str(uuid.uuid4())
    async with _connect(_resolve(db_path)) as db:
        await db.execute(
            "INSERT INTO trace_rows "
            "(id, seq, thread_id, tool_call_id, parent_tool_call_id, agent, name, kind, input, "
            "output, thinking, extras, status, error, started_at, ended_at, duration_ms) "
            "VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM trace_rows), ?, ?, ?, ?, ?, ?, ?, "
            "?, ?, ?, ?, ?, ?, ?, ?)",
            (
                row_id,
                thread_id,
                tool_call_id,
                parent_tool_call_id,
                agent,
                name,
                kind,
                _cap(input),
                _cap(output),
                _cap(thinking),
                _cap(extras),
                status,
                _cap(error),
                started_at or now,
                ended_at or now,
                duration_ms,
            ),
        )
        await db.commit()
    return row_id


async def calls_for_thread(thread_id: str, db_path: Path | str | None = None) -> list[TraceRow]:
    """Every recorded row (tool calls and model turns) for one thread, oldest
    first (by `seq`)."""
    async with _connect(_resolve(db_path)) as db:
        cursor = await db.execute(
            "SELECT * FROM trace_rows WHERE thread_id = ? ORDER BY seq", (thread_id,)
        )
        rows = await cursor.fetchall()
    return [
        TraceRow(
            id=row["id"],
            seq=row["seq"],
            thread_id=row["thread_id"],
            tool_call_id=row["tool_call_id"],
            parent_tool_call_id=row["parent_tool_call_id"],
            agent=row["agent"],
            name=row["name"],
            kind=row["kind"],
            input=row["input"],
            output=row["output"],
            thinking=row["thinking"],
            extras=row["extras"],
            status=row["status"],
            error=row["error"],
            started_at=row["started_at"],
            ended_at=row["ended_at"],
            duration_ms=row["duration_ms"],
        )
        for row in rows
    ]


async def prune_older_than(days: int, db_path: Path | str | None = None) -> int:
    """Deletes rows that ended more than `days` ago and returns how many.
    Unused on purpose: the user wants the full history, so nothing prunes
    automatically. It's here so a retention rule, if one is ever wanted, is a
    one-line caller rather than a new migration."""
    cutoff = (datetime.now(UTC) - timedelta(days=days)).isoformat()
    async with _connect(_resolve(db_path)) as db:
        cursor = await db.execute("DELETE FROM trace_rows WHERE ended_at < ?", (cutoff,))
        await db.commit()
        return cursor.rowcount
