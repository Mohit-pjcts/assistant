"""Durable per-turn gated-write counter backing write_tools.MAX_WRITES_PER_TURN.

Why a store, not message scanning (supersedes the additional_kwargs marker
design of 929745b, which had two documented undercount edges): the cap must
span every specialist delegation of one top-level turn, but each delegation
runs in a fresh, ISOLATED message list (agents-as-tools rewrite), and the
outer list that carried the markers can lose them mid-turn (compaction) or
never receive one (a delegation that executed writes and THEN errored
returns no ToolMessage to stamp). A single-row-per-write durable record has
neither edge: the write is counted at the moment it actually executes,
independently of what happens to any message list afterwards.

Key: (thread_id, turn_id, tool_call_id).
- thread_id: the ambient LangGraph thread (get_config), same source
  _run_delegation already relies on.
- turn_id: supervisor.py's _write_cap_turn_id — the id (or a content hash)
  of the most recent genuine human message in the OUTER state, so every
  delegation of one top-level turn shares one bucket and a new user
  message starts a fresh one.
- tool_call_id: LangChain's own injected id — stable and unique per
  logical tool invocation and, critically, FIXED across any LangGraph
  replay of that call (idempotency_store.py relies on the same property).
  INSERT OR IGNORE on this key is what makes a /resume replay, a
  concurrent duplicate resume, or a circuit-breaker retry never
  double-count.

Plain synchronous sqlite3, same precedent as idempotency_store.py: a
single-row check/insert, sub-millisecond, callable from any tool without
threading async through it.

Failure direction, stated plainly: if the store write itself fails (disk
error), the wrapper's real work has already succeeded and the record is
simply missing — the cap may allow one extra individually-confirmed
write. It can never skip a confirmation; the per-action interrupt()
remains the authorization boundary. This mirrors the rest of the
security model's "fail toward confirmation" rule.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

DEFAULT_DB_PATH = Path("write_caps.sqlite")

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS turn_writes (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    executed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (thread_id, turn_id, tool_call_id)
)
"""


def _connect(db_path: Path | str | None = None) -> sqlite3.Connection:
    resolved = Path(db_path) if db_path else DEFAULT_DB_PATH
    conn = sqlite3.connect(str(resolved))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(_CREATE_SQL)
    conn.commit()
    return conn


def record_write(
    thread_id: str,
    turn_id: str,
    tool_call_id: str,
    tool_name: str,
    db_path: Path | str | None = None,
) -> None:
    """Count one EXECUTED gated write. Idempotent per (thread, turn,
    tool_call_id): replays of the same logical call record once."""
    conn = _connect(db_path)
    try:
        conn.execute(
            "INSERT OR IGNORE INTO turn_writes (thread_id, turn_id, tool_call_id, tool_name)"
            " VALUES (?, ?, ?, ?)",
            (thread_id, turn_id, tool_call_id, tool_name),
        )
        conn.commit()
    finally:
        conn.close()


def count_writes(thread_id: str, turn_id: str, db_path: Path | str | None = None) -> int:
    """How many gated writes this top-level turn has already executed."""
    conn = _connect(db_path)
    try:
        (n,) = conn.execute(
            "SELECT COUNT(*) FROM turn_writes WHERE thread_id = ? AND turn_id = ?",
            (thread_id, turn_id),
        ).fetchone()
        return int(n)
    finally:
        conn.close()
