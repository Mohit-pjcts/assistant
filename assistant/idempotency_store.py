"""Idempotency guard for gated write tools — a real, narrow gap found
during a reliability/orchestration backlog audit (STEPS.md 151), verified
empirically before building anything (CLAUDE.md's own verification
discipline), not assumed from how `interrupt()` is documented to behave.

Two things were checked directly against the real installed LangGraph, not
guessed: (1) a SECOND `Command(resume=...)` sent sequentially, after the
first one already ran the node to completion, turns out to be a harmless
no-op — LangGraph just returns the already-final checkpointed state
without re-running the node, so `write_tools.py`'s own docstring claim
("no already-approved side effect ever sits between two interrupts to be
re-run") holds for that case. (2) TWO `Command(resume=...)` calls issued
concurrently for the SAME pending interrupt — e.g. a client (the
dashboard) retrying `POST /resume` after a timeout, before the first
attempt's response ever came back, while the first request is still
in flight server-side — genuinely both re-run the node body: a direct
probe (`asyncio.gather` of two resumes against a bare `interrupt()`-then-
sleep node) showed the post-interrupt code executing twice. That's the
real, narrow window this closes: a concurrently-retried `/resume` for a
still-in-flight gated action could otherwise send a real, duplicate email
or iMessage. Low likelihood, real consequence.

Deliberately a plain synchronous `sqlite3` store, not this project's usual
`aiosqlite` `*_store.py` pattern: the guard needs to be callable from both
async tools (`write_tools.py`'s `send_email`) and sync tools
(`mac_tools.py`'s `send_imessage`) with one implementation, and the actual
operation is a single-row check-and-insert — sub-millisecond, not worth
threading async through a sync tool's call graph for.

Keyed on LangChain's own `tool_call_id` (`InjectedToolCallId`) — stable
and unique per logical tool invocation, fixed across any LangGraph replay
of the same call, which is exactly the property this needs. No new ID
generation required.

Scope, deliberately narrow (moderate depth, not a full sweep — same
precedent as `media_tools.py`'s own test-coverage call, STEPS.md 148):
wired into `send_email` and `send_imessage` only — the two tools where
"already sent" cannot be undone and is most likely to be genuinely
confusing to a real recipient. The remaining gated tools (calendar
create/update, Gmail filters, disk/vault writes) carry the same narrow-
window risk in principle but a lower consequence (a duplicate calendar
event or filter is annoying but harmless and easy to spot/undo) — left as
an explicit, documented follow-up rather than silently claimed as covered.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

DEFAULT_DB_PATH = Path("idempotency.sqlite")

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS executed_actions (
    tool_call_id TEXT PRIMARY KEY,
    tool_name TEXT NOT NULL,
    executed_at TEXT NOT NULL DEFAULT (datetime('now'))
)
"""


def _connect(db_path: Path | str | None) -> sqlite3.Connection:
    resolved = Path(db_path) if db_path else DEFAULT_DB_PATH
    conn = sqlite3.connect(str(resolved))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(_CREATE_SQL)
    conn.commit()
    return conn


def check_and_record(
    tool_call_id: str, tool_name: str, db_path: Path | str | None = None
) -> bool:
    """Atomically check whether `tool_call_id` has already executed and, if
    not, record it as executed now — a single `INSERT OR IGNORE` so the
    check-and-set is race-safe within SQLite's own write serialization,
    not two separate calls a concurrent retry could interleave between.

    Returns:
        True if this is the first time this tool_call_id reached this
        checkpoint (the caller should proceed with the real side effect).
        False if it already executed (the caller should short-circuit with
        an "already sent" message instead of calling the raw tool again).
    """
    conn = _connect(db_path)
    try:
        cursor = conn.execute(
            "INSERT OR IGNORE INTO executed_actions (tool_call_id, tool_name) VALUES (?, ?)",
            (tool_call_id, tool_name),
        )
        conn.commit()
        return cursor.rowcount == 1
    finally:
        conn.close()
