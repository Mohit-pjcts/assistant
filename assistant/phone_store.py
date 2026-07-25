"""Phone data sync storage (PLAN.md Phase 21) — a separate SQLite file
(`phone_data.sqlite`), same precedent as `thread_store.py`/`board_store.py`:
a small dedicated table, no shared schema with another module's file.

Holds only the LATEST snapshot per data `kind` (currently just "health") —
a single row per kind, overwritten on each sync, not a history table. This
matches the phase's own deliberately limited design: a snapshot is only
ever as fresh as the last time the user ran the sync Shortcut on their
phone (PLAN.md Phase 21's "user-triggered push only" decision, not a
scheduled/automatic push — there is no live query path to the phone at
all, see phone_tools.py's module docstring for the governing platform
constraint), so there is nothing to gain from keeping old snapshots
around; `get_latest_health_snapshot` (phone_tools.py) always says how old
the returned data is rather than implying it's current.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import aiosqlite

DEFAULT_DB_PATH = Path("phone_data.sqlite")

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS phone_snapshots (
    kind TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    synced_at TEXT NOT NULL
)
"""


@dataclass(frozen=True)
class PhoneSnapshot:
    kind: str
    content: str
    synced_at: str


def _resolve(db_path: Path | str | None) -> Path | str:
    # Resolved inside the function body against DEFAULT_DB_PATH, not bound
    # as a parameter default — same convention as thread_store.py/
    # board_store.py/memory_store.py, so a test's monkeypatch of
    # DEFAULT_DB_PATH (done before these functions are ever called) is
    # actually honored rather than silently ignored by an already-bound
    # default.
    return db_path if db_path is not None else DEFAULT_DB_PATH


async def save_snapshot(
    kind: str, content: str, db_path: Path | str | None = None
) -> PhoneSnapshot:
    """Overwrites any existing snapshot for this `kind` — only the latest
    push is ever kept, per this module's own docstring."""
    db_path = _resolve(db_path)
    synced_at = datetime.now(UTC).isoformat()
    async with aiosqlite.connect(str(db_path)) as db:
        await db.execute(_CREATE_SQL)
        await db.execute(
            """
            INSERT INTO phone_snapshots (kind, content, synced_at) VALUES (?, ?, ?)
            ON CONFLICT(kind) DO UPDATE SET content = excluded.content, synced_at = excluded.synced_at
            """,
            (kind, content, synced_at),
        )
        await db.commit()
    return PhoneSnapshot(kind=kind, content=content, synced_at=synced_at)


async def get_snapshot(kind: str, db_path: Path | str | None = None) -> PhoneSnapshot | None:
    db_path = _resolve(db_path)
    async with aiosqlite.connect(str(db_path)) as db:
        await db.execute(_CREATE_SQL)
        await db.commit()
        db.row_factory = aiosqlite.Row
        rows = await db.execute_fetchall(
            "SELECT kind, content, synced_at FROM phone_snapshots WHERE kind = ?", (kind,)
        )
        if not rows:
            return None
        row = rows[0]
        return PhoneSnapshot(kind=row["kind"], content=row["content"], synced_at=row["synced_at"])
