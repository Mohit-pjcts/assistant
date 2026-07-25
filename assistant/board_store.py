"""Kanban board persistence — a separate SQLite file (`board.sqlite`), same
precedent as `thread_store.py`/`memory_store.py`: a small custom table with
no business sharing another module's schema/file.

Two tables:
- `board_items`: the actual task rows — id/column/ref/priority/title/
  description/position/created_at/updated_at.
- `ref_counter`: a single row (id=1, same CHECK-constraint-enforced
  singleton pattern as thread_store.py's `active_pointer`) handing out
  monotonically increasing "ONI-N" display refs that never get reused even
  after a delete — a plain COUNT(*) would collide across deletes.

Every function takes an optional db_path (resolved inside the function body
against DEFAULT_DB_PATH, not bound as a parameter default) — same convention
as thread_store.py/memory_store.py, for the same reason: a parameter
default is bound once at function-definition time and would silently
ignore a later monkeypatch in tests.

This module is used by BOTH server.py (the dashboard's REST API, full CRUD
for the user's own UI) and board_tools.py (life_admin_agent's tools, full
CRUD per the user's explicit "full access" request — see board_tools.py's
own module docstring for the security-model reasoning on why this is
deliberately ungated, unlike email/calendar/memory writes).
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

import aiosqlite

DEFAULT_DB_PATH = Path("board.sqlite")

ColumnId = Literal["todo", "in-progress", "in-review", "done"]
Priority = Literal["high", "medium", "low"]
COLUMNS: tuple[ColumnId, ...] = ("todo", "in-progress", "in-review", "done")
PRIORITIES: tuple[Priority, ...] = ("high", "medium", "low")

_CREATE_ITEMS_SQL = """
CREATE TABLE IF NOT EXISTS board_items (
    id TEXT PRIMARY KEY,
    "column" TEXT NOT NULL,
    ref TEXT NOT NULL,
    priority TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""

_CREATE_COUNTER_SQL = """
CREATE TABLE IF NOT EXISTS ref_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_value INTEGER NOT NULL
)
"""


@dataclass(frozen=True)
class BoardItem:
    id: str
    column: ColumnId
    ref: str
    priority: Priority
    title: str
    description: str
    position: int
    created_at: str
    updated_at: str


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _resolve(db_path: Path | str | None) -> Path | str:
    return db_path if db_path is not None else DEFAULT_DB_PATH


def _row_to_item(row: aiosqlite.Row) -> BoardItem:
    d = dict(row)
    d["column"] = d.pop("column")
    return BoardItem(**d)


@asynccontextmanager
async def _connect(db_path: Path | str) -> AsyncIterator[aiosqlite.Connection]:
    async with aiosqlite.connect(str(db_path)) as db:
        await db.execute(_CREATE_ITEMS_SQL)
        await db.execute(_CREATE_COUNTER_SQL)
        await db.commit()
        db.row_factory = aiosqlite.Row
        yield db


async def _next_ref(db: aiosqlite.Connection) -> str:
    rows = await db.execute_fetchall("SELECT next_value FROM ref_counter WHERE id = 1")
    n = rows[0]["next_value"] if rows else 1
    await db.execute(
        """
        INSERT INTO ref_counter (id, next_value) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET next_value = excluded.next_value
        """,
        (n + 1,),
    )
    return f"ONI-{n}"


async def list_items(db_path: Path | str | None = None) -> list[BoardItem]:
    """All items, ordered by column then position — exactly the shape the
    dashboard's board and the agent's own view of it both want."""
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        rows = await db.execute_fetchall(
            'SELECT * FROM board_items ORDER BY "column", position'
        )
        return [_row_to_item(row) for row in rows]


async def create_item(
    column: ColumnId,
    title: str,
    description: str = "",
    priority: Priority = "medium",
    db_path: Path | str | None = None,
) -> BoardItem:
    """Appends to the END of the target column (max(position) + 1) — new
    tasks land at the bottom, matching where a user dragging a fresh card
    would expect it, not shuffling existing ordering."""
    if column not in COLUMNS:
        raise ValueError(f"unknown column: {column!r}")
    if priority not in PRIORITIES:
        raise ValueError(f"unknown priority: {priority!r}")
    db_path = _resolve(db_path)
    item_id = str(uuid.uuid4())
    now = _now()
    async with _connect(db_path) as db:
        pos_rows = await db.execute_fetchall(
            'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM board_items WHERE "column" = ?',
            (column,),
        )
        position = pos_rows[0]["next_pos"]
        ref = await _next_ref(db)
        await db.execute(
            """
            INSERT INTO board_items
                (id, "column", ref, priority, title, description, position, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (item_id, column, ref, priority, title, description, position, now, now),
        )
        await db.commit()
    return BoardItem(
        id=item_id,
        column=column,
        ref=ref,
        priority=priority,
        title=title,
        description=description,
        position=position,
        created_at=now,
        updated_at=now,
    )


async def update_item(
    item_id: str,
    title: str | None = None,
    description: str | None = None,
    priority: Priority | None = None,
    db_path: Path | str | None = None,
) -> BoardItem:
    """Edits fields in place — does NOT move columns (see move_item for
    that, a semantically different operation with its own position
    bookkeeping). Raises KeyError if item_id isn't real."""
    if priority is not None and priority not in PRIORITIES:
        raise ValueError(f"unknown priority: {priority!r}")
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        rows = await db.execute_fetchall("SELECT * FROM board_items WHERE id = ?", (item_id,))
        if not rows:
            raise KeyError(item_id)
        current = _row_to_item(rows[0])
        now = _now()
        new_title = title if title is not None else current.title
        new_description = description if description is not None else current.description
        new_priority = priority if priority is not None else current.priority
        await db.execute(
            "UPDATE board_items SET title = ?, description = ?, priority = ?, updated_at = ? WHERE id = ?",
            (new_title, new_description, new_priority, now, item_id),
        )
        await db.commit()
        return BoardItem(
            id=current.id,
            column=current.column,
            ref=current.ref,
            priority=new_priority,
            title=new_title,
            description=new_description,
            position=current.position,
            created_at=current.created_at,
            updated_at=now,
        )


async def move_item(
    item_id: str,
    column: ColumnId,
    position: int | None = None,
    db_path: Path | str | None = None,
) -> BoardItem:
    """Moves an item to a (possibly different) column, at a given position —
    or to the end of that column if position is omitted (the common case:
    an agent saying "move X to done" doesn't need to know exact ordering).
    Raises KeyError if item_id isn't real."""
    if column not in COLUMNS:
        raise ValueError(f"unknown column: {column!r}")
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        rows = await db.execute_fetchall("SELECT * FROM board_items WHERE id = ?", (item_id,))
        if not rows:
            raise KeyError(item_id)
        current = _row_to_item(rows[0])
        now = _now()
        if position is None:
            pos_rows = await db.execute_fetchall(
                'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM board_items WHERE "column" = ? AND id != ?',
                (column, item_id),
            )
            position = pos_rows[0]["next_pos"]
        await db.execute(
            'UPDATE board_items SET "column" = ?, position = ?, updated_at = ? WHERE id = ?',
            (column, position, now, item_id),
        )
        await db.commit()
        return BoardItem(
            id=current.id,
            column=column,
            ref=current.ref,
            priority=current.priority,
            title=current.title,
            description=current.description,
            position=position,
            created_at=current.created_at,
            updated_at=now,
        )


async def delete_item(item_id: str, db_path: Path | str | None = None) -> None:
    """Raises KeyError if item_id isn't real."""
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        cursor = await db.execute("DELETE FROM board_items WHERE id = ?", (item_id,))
        await db.commit()
        if cursor.rowcount == 0:
            raise KeyError(item_id)
