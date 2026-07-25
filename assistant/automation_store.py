"""Pre-approved automation registry (PLAN.md Phase 24) — a new, deliberately
narrow, explicitly-named exception to the standing confirmation rule
(CLAUDE.md's security model). Separate SQLite file (`automations.sqlite`),
same precedent as `board_store.py`/`thread_store.py`/`phone_store.py`.

Two tables:
- `automations`: the registered definitions — what triggers it, who/what
  it acts on, what it's meant to accomplish, and which single
  `GATED_ACTIONS` key it's pre-approved to fire without a live
  confirmation. `action` is deliberately constrained to a real
  `supervisor.GATED_ACTIONS` key (checked by the caller, not this module,
  same "no import of supervisor.py here" reasoning `board_store.py`/
  `phone_store.py` already follow — this module has no opinion on the
  agent graph, only storage).
- `automation_runs`: an append-only log of every time an automation
  actually fired — what was generated, what happened, when. This is the
  reviewable-after-the-fact record PLAN.md's Phase 24 entry requires,
  since there is deliberately no BEFORE-the-fact review in this specific
  execution path (see `server.py`'s trigger endpoint for why).

Every function takes an optional db_path (resolved inside the function
body against DEFAULT_DB_PATH, not bound as a parameter default) — same
convention as every other *_store.py module here, for the same reason: a
parameter default binds once at function-definition time and would
silently ignore a later test monkeypatch.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import aiosqlite

DEFAULT_DB_PATH = Path("automations.sqlite")

_CREATE_AUTOMATIONS_SQL = """
CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    trigger_description TEXT NOT NULL,
    target TEXT NOT NULL,
    goal TEXT NOT NULL,
    action TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""

_CREATE_RUNS_SQL = """
CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    fired_at TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
)
"""


@dataclass(frozen=True)
class Automation:
    id: str
    name: str
    trigger_description: str
    target: str
    goal: str
    action: str
    enabled: bool
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class AutomationRun:
    id: str
    automation_id: str
    fired_at: str
    outcome: str
    detail: str


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _resolve(db_path: Path | str | None) -> Path | str:
    return db_path if db_path is not None else DEFAULT_DB_PATH


def _row_to_automation(row: aiosqlite.Row) -> Automation:
    d = dict(row)
    d["enabled"] = bool(d["enabled"])
    return Automation(**d)


def _row_to_run(row: aiosqlite.Row) -> AutomationRun:
    return AutomationRun(**dict(row))


@asynccontextmanager
async def _connect(db_path: Path | str) -> AsyncIterator[aiosqlite.Connection]:
    async with aiosqlite.connect(str(db_path)) as db:
        await db.execute(_CREATE_AUTOMATIONS_SQL)
        await db.execute(_CREATE_RUNS_SQL)
        await db.commit()
        db.row_factory = aiosqlite.Row
        yield db


async def list_automations(db_path: Path | str | None = None) -> list[Automation]:
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        rows = await db.execute_fetchall("SELECT * FROM automations ORDER BY created_at")
        return [_row_to_automation(row) for row in rows]


async def get_automation(automation_id: str, db_path: Path | str | None = None) -> Automation | None:
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        rows = await db.execute_fetchall("SELECT * FROM automations WHERE id = ?", (automation_id,))
        return _row_to_automation(rows[0]) if rows else None


async def create_automation(
    name: str,
    trigger_description: str,
    target: str,
    goal: str,
    action: str,
    db_path: Path | str | None = None,
) -> Automation:
    db_path = _resolve(db_path)
    automation_id = str(uuid.uuid4())
    now = _now()
    async with _connect(db_path) as db:
        await db.execute(
            """
            INSERT INTO automations
                (id, name, trigger_description, target, goal, action, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (automation_id, name, trigger_description, target, goal, action, now, now),
        )
        await db.commit()
    return Automation(
        id=automation_id,
        name=name,
        trigger_description=trigger_description,
        target=target,
        goal=goal,
        action=action,
        enabled=True,
        created_at=now,
        updated_at=now,
    )


async def update_automation(
    automation_id: str,
    name: str | None = None,
    trigger_description: str | None = None,
    target: str | None = None,
    goal: str | None = None,
    action: str | None = None,
    enabled: bool | None = None,
    db_path: Path | str | None = None,
) -> Automation:
    """Raises KeyError if automation_id isn't real. Only pass the fields
    you want to change — the rest stay as they are, same convention as
    board_store.update_item."""
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        rows = await db.execute_fetchall("SELECT * FROM automations WHERE id = ?", (automation_id,))
        if not rows:
            raise KeyError(automation_id)
        current = _row_to_automation(rows[0])
        now = _now()
        new = Automation(
            id=current.id,
            name=name if name is not None else current.name,
            trigger_description=(
                trigger_description if trigger_description is not None else current.trigger_description
            ),
            target=target if target is not None else current.target,
            goal=goal if goal is not None else current.goal,
            action=action if action is not None else current.action,
            enabled=enabled if enabled is not None else current.enabled,
            created_at=current.created_at,
            updated_at=now,
        )
        await db.execute(
            """
            UPDATE automations
            SET name = ?, trigger_description = ?, target = ?, goal = ?, action = ?, enabled = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                new.name,
                new.trigger_description,
                new.target,
                new.goal,
                new.action,
                int(new.enabled),
                now,
                automation_id,
            ),
        )
        await db.commit()
        return new


async def delete_automation(automation_id: str, db_path: Path | str | None = None) -> None:
    """Raises KeyError if automation_id isn't real."""
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        cursor = await db.execute("DELETE FROM automations WHERE id = ?", (automation_id,))
        await db.commit()
        if cursor.rowcount == 0:
            raise KeyError(automation_id)


async def log_run(
    automation_id: str,
    outcome: str,
    detail: str = "",
    db_path: Path | str | None = None,
) -> AutomationRun:
    """Append-only — the reviewable-after-the-fact record PLAN.md's Phase
    24 entry requires, since this execution path has no before-the-fact
    review."""
    db_path = _resolve(db_path)
    run_id = str(uuid.uuid4())
    fired_at = _now()
    async with _connect(db_path) as db:
        await db.execute(
            "INSERT INTO automation_runs (id, automation_id, fired_at, outcome, detail) VALUES (?, ?, ?, ?, ?)",
            (run_id, automation_id, fired_at, outcome, detail),
        )
        await db.commit()
    return AutomationRun(
        id=run_id, automation_id=automation_id, fired_at=fired_at, outcome=outcome, detail=detail
    )


async def list_runs(automation_id: str | None = None, db_path: Path | str | None = None) -> list[AutomationRun]:
    """All runs, most recent first — optionally scoped to one automation."""
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        if automation_id is not None:
            rows = await db.execute_fetchall(
                "SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY fired_at DESC",
                (automation_id,),
            )
        else:
            rows = await db.execute_fetchall("SELECT * FROM automation_runs ORDER BY fired_at DESC")
        return [_row_to_run(row) for row in rows]
