"""Active-thread pointer + thread registry — Phase 15.

A separate SQLite file (`threads.sqlite`) from both `conversation_memory.
sqlite` (memory.py, owned entirely by AsyncSqliteSaver's own checkpoint
machinery) and `long_term_memory.sqlite` (memory_store.py) — same
separate-file precedent, for the same reason: this is a small custom table
with no business sharing another module's schema. Deliberately NOT a JSON
file: a JSON file shared across multiple writing processes (main.py,
voice_daemon.py, server.py) would reintroduce a version of the exact
concurrency class this phase exists to eliminate (STEPS.md 66 — the
collision was two processes touching the same shared state concurrently
with no coordination).

Two tables:
- `threads`: the registry — every thread ever created, id/title/
  created_at/last_active_at.
- `active_pointer`: a single row (id=1, enforced by a CHECK constraint so
  "there is exactly one active thread at a time" is a schema invariant, not
  just a convention in calling code) naming which thread_id a client should
  continue when it doesn't ask for a specific one.

Bootstrap behavior (load-bearing for the "old single-thread behavior still
works" done-when criterion): on a completely fresh threads.sqlite,
get_active_thread_id() seeds both tables with LEGACY_DEFAULT_THREAD_ID —
the same fixed thread_id main.py/server.py/voice_daemon.py all hardcoded
before this phase — rather than a freshly generated uuid. That is what lets
a user who never touches the new thread commands keep talking to exactly
the conversation_memory.sqlite history they already had.

Every function takes an optional db_path (resolved inside the function
body against DEFAULT_DB_PATH, not bound as a parameter default) — same
convention as memory_store.py, for the same reason: a parameter default is
bound once at function-definition time and would silently ignore a later
monkeypatch in tests.

Phase 28 adds a `projects` table + a nullable `project_id` column on
`threads` — a Project groups Threads in the dashboard sidebar (`Oni ->
Project -> Thread`, see CONTEXT.md). One Project per Thread, nullable;
every thread that existed before this column was added stays ungrouped
with no backfill needed. `_migrate_add_project_id_column` adds the column
to an already-existing threads.sqlite via ALTER TABLE (SQLite's
CREATE TABLE IF NOT EXISTS is a no-op against an existing table, so a
fresh-DB-only column definition would never reach a real user's existing
file) — this is the first schema change this module has needed since
Phase 15 shipped.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import aiosqlite

DEFAULT_DB_PATH = Path("threads.sqlite")

# The thread_id every client (CLI, voice daemon, dashboard GUI) shared
# before this phase — main.py's old fixed THREAD_ID constant. See the
# module docstring's Bootstrap section for why this exact string is seeded
# rather than a fresh uuid.
LEGACY_DEFAULT_THREAD_ID = "cli-default-thread"

_CREATE_THREADS_SQL = """
CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id)
)
"""

_CREATE_PROJECTS_SQL = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at TEXT NOT NULL
)
"""

_CREATE_POINTER_SQL = """
CREATE TABLE IF NOT EXISTS active_pointer (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    thread_id TEXT NOT NULL
)
"""

# Real violet tints lifted from instrument/instrument.html's own design
# tokens (--signal/--signal-bright/--p-coding/--p-admin/--p-research/
# --p-vault) rather than invented fresh — Phase 28 Decision 5's "stable,
# static, round-robin-assigned" legend color, kept ready for whenever the
# real theme (same phase, sequenced later) lands so the two agree.
PROJECT_COLORS: list[str] = ["#9b87f5", "#c3b2ff", "#7c6bc9", "#a695e8", "#b9a6ff"]


@dataclass(frozen=True)
class Thread:
    id: str
    title: str | None
    created_at: str
    last_active_at: str
    project_id: str | None = None


@dataclass(frozen=True)
class Project:
    id: str
    name: str
    color: str
    created_at: str


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _resolve(db_path: Path | str | None) -> Path | str:
    return db_path if db_path is not None else DEFAULT_DB_PATH


async def _migrate_add_project_id_column(db: aiosqlite.Connection) -> None:
    """threads.sqlite files created before Phase 28 have no project_id
    column — CREATE TABLE IF NOT EXISTS is a no-op against an
    already-existing table, so a fresh-DB-only column definition would
    never reach a real user's existing file. ALTER TABLE has no
    IF NOT EXISTS form, so PRAGMA table_info is the standard way to check
    first. Must run before row_factory is set (this reads plain tuples)."""
    cursor = await db.execute("PRAGMA table_info(threads)")
    columns = {row[1] async for row in cursor}
    if "project_id" not in columns:
        await db.execute("ALTER TABLE threads ADD COLUMN project_id TEXT REFERENCES projects(id)")


@asynccontextmanager
async def _connect(db_path: Path | str) -> AsyncIterator[aiosqlite.Connection]:
    async with aiosqlite.connect(str(db_path)) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute(_CREATE_PROJECTS_SQL)
        await db.execute(_CREATE_THREADS_SQL)
        await db.execute(_CREATE_POINTER_SQL)
        await _migrate_add_project_id_column(db)
        await db.commit()
        db.row_factory = aiosqlite.Row
        yield db


async def _set_pointer(db: aiosqlite.Connection, thread_id: str) -> None:
    await db.execute(
        """
        INSERT INTO active_pointer (id, thread_id) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET thread_id = excluded.thread_id
        """,
        (thread_id,),
    )


async def get_active_thread_id(db_path: Path | str | None = None) -> str:
    """The thread_id a client should continue when it hasn't asked for a
    specific one — /chat and /resume's fallback, main.py's/voice_daemon.py's
    default. See the module docstring's Bootstrap section for first-run
    behavior."""
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        row = await db.execute_fetchall("SELECT thread_id FROM active_pointer WHERE id = 1")
        if row:
            return row[0]["thread_id"]

        now = _now()
        await db.execute(
            "INSERT OR IGNORE INTO threads (id, title, created_at, last_active_at) VALUES (?, ?, ?, ?)",
            (LEGACY_DEFAULT_THREAD_ID, None, now, now),
        )
        await db.execute(
            "INSERT INTO active_pointer (id, thread_id) VALUES (1, ?) ON CONFLICT(id) DO NOTHING",
            (LEGACY_DEFAULT_THREAD_ID,),
        )
        await db.commit()
        # Re-read rather than assume our own insert won the race — a
        # concurrent process bootstrapping at the same moment converges on
        # the same answer either way (INSERT OR IGNORE / DO NOTHING both
        # make that safe), so the authoritative value is whatever the
        # pointer row says now, not what this call tried to write.
        row = await db.execute_fetchall("SELECT thread_id FROM active_pointer WHERE id = 1")
        return row[0]["thread_id"]


async def get_thread(thread_id: str, db_path: Path | str | None = None) -> Thread | None:
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        rows = await db.execute_fetchall(
            "SELECT id, title, created_at, last_active_at, project_id FROM threads WHERE id = ?",
            (thread_id,),
        )
        return Thread(**dict(rows[0])) if rows else None


async def list_threads(db_path: Path | str | None = None) -> list[Thread]:
    """Most-recently-active first — matches how a GUI picker or CLI
    `/threads` listing wants to present them."""
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        rows = await db.execute_fetchall(
            "SELECT id, title, created_at, last_active_at, project_id FROM threads ORDER BY last_active_at DESC"
        )
        return [Thread(**dict(row)) for row in rows]


async def create_thread(title: str | None = None, db_path: Path | str | None = None) -> Thread:
    """Create a new thread and make it the active pointer immediately —
    the whole point of starting a new conversation is that whoever just
    started it continues talking to it by default next."""
    db_path = _resolve(db_path)
    thread_id = str(uuid.uuid4())
    now = _now()
    async with _connect(db_path) as db:
        await db.execute(
            "INSERT INTO threads (id, title, created_at, last_active_at) VALUES (?, ?, ?, ?)",
            (thread_id, title, now, now),
        )
        await _set_pointer(db, thread_id)
        await db.commit()
    return Thread(id=thread_id, title=title, created_at=now, last_active_at=now)


async def set_active_thread(thread_id: str, db_path: Path | str | None = None) -> Thread:
    """Switch the shared pointer to an already-existing thread.

    Raises KeyError if thread_id isn't a real thread — callers (server.py)
    turn that into a 404 rather than silently pointing the whole system at
    a thread_id nothing actually created.
    """
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        rows = await db.execute_fetchall(
            "SELECT id, title, created_at, last_active_at, project_id FROM threads WHERE id = ?",
            (thread_id,),
        )
        if not rows:
            raise KeyError(thread_id)
        await _set_pointer(db, thread_id)
        await db.commit()
        return Thread(**dict(rows[0]))


async def rename_thread(thread_id: str, title: str, db_path: Path | str | None = None) -> Thread:
    """Raises KeyError if thread_id isn't a real thread."""
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        cursor = await db.execute("UPDATE threads SET title = ? WHERE id = ?", (title, thread_id))
        await db.commit()
        if cursor.rowcount == 0:
            raise KeyError(thread_id)
        rows = await db.execute_fetchall(
            "SELECT id, title, created_at, last_active_at, project_id FROM threads WHERE id = ?",
            (thread_id,),
        )
        return Thread(**dict(rows[0]))


async def delete_thread(thread_id: str, db_path: Path | str | None = None) -> str:
    """Delete a thread from the registry. Raises KeyError if thread_id
    isn't a real thread.

    Returns the active thread_id AFTER the deletion — unchanged if a
    different thread was deleted; reassigned to the next most-recently-
    active remaining thread if the deleted thread WAS the active pointer;
    or a freshly created thread if none remain. Every other function in
    this module assumes there is always exactly one active thread, so
    deleting the last one can't just leave the pointer dangling — the
    caller (server.py) uses this return value to know what became active,
    the same way create_thread's return value tells it what to switch to.

    Deliberately does NOT touch `conversation_memory.sqlite`'s own
    checkpoint rows for this thread_id — that's a separate concern owned by
    `AsyncSqliteSaver`, and this module has no reference to a live
    checkpointer instance to purge it with. The checkpoint history becomes
    unreachable through the registry/pointer (nothing in this app will
    list, switch to, or read it again) but isn't otherwise a new exposure —
    same data that already existed, just no longer surfaced. Revisit if
    storage growth or a stricter "really gone" requirement ever makes that
    matter.
    """
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        pointer_rows = await db.execute_fetchall("SELECT thread_id FROM active_pointer WHERE id = 1")
        was_active = bool(pointer_rows) and pointer_rows[0]["thread_id"] == thread_id

        cursor = await db.execute("DELETE FROM threads WHERE id = ?", (thread_id,))
        if cursor.rowcount == 0:
            await db.commit()
            raise KeyError(thread_id)

        if not was_active:
            await db.commit()
            return pointer_rows[0]["thread_id"]

        remaining = await db.execute_fetchall(
            "SELECT id FROM threads ORDER BY last_active_at DESC LIMIT 1"
        )
        if remaining:
            new_active = remaining[0]["id"]
            await _set_pointer(db, new_active)
            await db.commit()
            return new_active

        new_id = str(uuid.uuid4())
        now = _now()
        await db.execute(
            "INSERT INTO threads (id, title, created_at, last_active_at) VALUES (?, ?, ?, ?)",
            (new_id, None, now, now),
        )
        await _set_pointer(db, new_id)
        await db.commit()
        return new_id


async def touch_thread(thread_id: str, db_path: Path | str | None = None) -> None:
    """Bump last_active_at to now — called after a turn actually runs on a
    thread, so list_threads' recency ordering reflects real use, not just
    creation time. Silently a no-op for an unknown thread_id (defensive;
    every caller has already resolved/validated the thread_id before a turn
    runs)."""
    db_path = _resolve(db_path)
    now = _now()
    async with _connect(db_path) as db:
        await db.execute("UPDATE threads SET last_active_at = ? WHERE id = ?", (now, thread_id))
        await db.commit()


# ---- Projects (Phase 28) ----


async def create_project(name: str, db_path: Path | str | None = None) -> Project:
    """Color is assigned round-robin by creation order (PLAN.md Phase 28
    Decision 5) and stored on the row — never recomputed at render time,
    so a project's color doesn't drift as other projects are added or
    removed around it."""
    db_path = _resolve(db_path)
    project_id = str(uuid.uuid4())
    now = _now()
    async with _connect(db_path) as db:
        count_rows = await db.execute_fetchall("SELECT COUNT(*) AS n FROM projects")
        color = PROJECT_COLORS[count_rows[0]["n"] % len(PROJECT_COLORS)]
        await db.execute(
            "INSERT INTO projects (id, name, color, created_at) VALUES (?, ?, ?, ?)",
            (project_id, name, color, now),
        )
        await db.commit()
    return Project(id=project_id, name=name, color=color, created_at=now)


async def list_projects(db_path: Path | str | None = None) -> list[Project]:
    """Creation order — matches the round-robin color assignment's own
    ordering and gives the sidebar a stable project order."""
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        rows = await db.execute_fetchall(
            "SELECT id, name, color, created_at FROM projects ORDER BY created_at ASC"
        )
        return [Project(**dict(row)) for row in rows]


async def rename_project(project_id: str, name: str, db_path: Path | str | None = None) -> Project:
    """Raises KeyError if project_id isn't a real project."""
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        cursor = await db.execute("UPDATE projects SET name = ? WHERE id = ?", (name, project_id))
        await db.commit()
        if cursor.rowcount == 0:
            raise KeyError(project_id)
        rows = await db.execute_fetchall(
            "SELECT id, name, color, created_at FROM projects WHERE id = ?", (project_id,)
        )
        return Project(**dict(rows[0]))


async def delete_project(project_id: str, db_path: Path | str | None = None) -> None:
    """Unassigns every Thread in this Project rather than deleting them
    (PLAN.md Phase 28 Decision 4 — deliberately non-destructive, informed
    directly by the real accidental-delete incident in STEPS.md 127).
    Raises KeyError if project_id isn't a real project."""
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        cursor = await db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        if cursor.rowcount == 0:
            await db.commit()
            raise KeyError(project_id)
        await db.execute("UPDATE threads SET project_id = NULL WHERE project_id = ?", (project_id,))
        await db.commit()


async def assign_thread_project(
    thread_id: str, project_id: str | None, db_path: Path | str | None = None
) -> Thread:
    """Sets (project_id given) or clears (project_id=None) a Thread's
    Project — the one mechanism behind both of Phase 28's UI paths (the
    "Move to project" menu action and tree drag-and-drop both end up
    calling this). Raises KeyError if thread_id isn't real; raises
    ValueError if a given project_id isn't a real project (a different
    exception type than KeyError so a caller — server.py — can tell which
    id was bad and return the right 404 detail)."""
    db_path = _resolve(db_path)
    async with _connect(db_path) as db:
        if project_id is not None:
            project_rows = await db.execute_fetchall("SELECT id FROM projects WHERE id = ?", (project_id,))
            if not project_rows:
                raise ValueError(project_id)
        cursor = await db.execute("UPDATE threads SET project_id = ? WHERE id = ?", (project_id, thread_id))
        await db.commit()
        if cursor.rowcount == 0:
            raise KeyError(thread_id)
        rows = await db.execute_fetchall(
            "SELECT id, title, created_at, last_active_at, project_id FROM threads WHERE id = ?",
            (thread_id,),
        )
        return Thread(**dict(rows[0]))
