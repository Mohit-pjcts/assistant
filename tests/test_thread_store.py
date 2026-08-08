"""Tests for assistant.thread_store — Phase 15's active-thread pointer +
thread registry. Runnable directly, matching tests/test_memory_store.py's
convention (real SQLite I/O against a temp file, no mocking)."""

import asyncio
import tempfile
from pathlib import Path

import aiosqlite

from assistant.thread_store import (
    LEGACY_DEFAULT_THREAD_ID,
    PROJECT_COLORS,
    assign_thread_project,
    create_project,
    create_thread,
    delete_project,
    delete_thread,
    get_active_thread_id,
    get_thread,
    list_projects,
    list_threads,
    rename_project,
    rename_thread,
    set_active_thread,
    touch_thread,
)


async def test_fresh_store_bootstraps_the_legacy_default_thread() -> None:
    """The done-when criterion that actually matters: a user who never
    touches the new thread commands must keep talking to the exact
    pre-Phase-15 conversation, not a freshly generated uuid thread."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        thread_id = await get_active_thread_id(db_path=db_path)
        assert thread_id == LEGACY_DEFAULT_THREAD_ID

        registered = await get_thread(LEGACY_DEFAULT_THREAD_ID, db_path=db_path)
        assert registered is not None
        assert registered.id == LEGACY_DEFAULT_THREAD_ID

        # Idempotent: a second read must not re-bootstrap or change anything.
        again = await get_active_thread_id(db_path=db_path)
        assert again == LEGACY_DEFAULT_THREAD_ID


async def test_create_thread_becomes_the_active_pointer() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        # Bootstrap the legacy thread first, same as real startup order.
        await get_active_thread_id(db_path=db_path)

        new_thread = await create_thread(title="Trip planning", db_path=db_path)
        assert new_thread.id != LEGACY_DEFAULT_THREAD_ID
        assert new_thread.title == "Trip planning"

        active = await get_active_thread_id(db_path=db_path)
        assert active == new_thread.id


async def test_set_active_thread_switches_the_pointer() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        legacy = await get_active_thread_id(db_path=db_path)
        new_thread = await create_thread(db_path=db_path)
        assert await get_active_thread_id(db_path=db_path) == new_thread.id

        switched = await set_active_thread(legacy, db_path=db_path)
        assert switched.id == legacy
        assert await get_active_thread_id(db_path=db_path) == legacy


async def test_set_active_thread_unknown_id_raises_key_error() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        try:
            await set_active_thread("does-not-exist", db_path=db_path)
            assert False, "expected KeyError"
        except KeyError:
            pass


async def test_rename_thread_updates_title() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        thread = await create_thread(db_path=db_path)
        renamed = await rename_thread(thread.id, "New title", db_path=db_path)
        assert renamed.title == "New title"

        fetched = await get_thread(thread.id, db_path=db_path)
        assert fetched.title == "New title"


async def test_rename_thread_unknown_id_raises_key_error() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        try:
            await rename_thread("does-not-exist", "x", db_path=db_path)
            assert False, "expected KeyError"
        except KeyError:
            pass


async def test_list_threads_orders_by_last_active_desc() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        first = await create_thread(title="first", db_path=db_path)
        second = await create_thread(title="second", db_path=db_path)

        # Touching the older thread should move it back to the front.
        await touch_thread(first.id, db_path=db_path)

        threads = await list_threads(db_path=db_path)
        ids_in_order = [t.id for t in threads]
        assert ids_in_order.index(first.id) < ids_in_order.index(second.id)


async def test_touch_thread_unknown_id_is_a_noop() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        await touch_thread("does-not-exist", db_path=db_path)  # must not raise


async def test_delete_non_active_thread_leaves_pointer_unchanged() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        active = await create_thread(title="active", db_path=db_path)
        other = await create_thread(title="other", db_path=db_path)
        # "other" is active now (create_thread always activates); switch
        # back so "active" is the one we keep active for this test.
        await set_active_thread(active.id, db_path=db_path)

        returned_active_id = await delete_thread(other.id, db_path=db_path)
        assert returned_active_id == active.id
        assert await get_active_thread_id(db_path=db_path) == active.id
        assert await get_thread(other.id, db_path=db_path) is None


async def test_delete_active_thread_reassigns_pointer_to_next_most_recent() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        older = await create_thread(title="older", db_path=db_path)
        newer = await create_thread(title="newer", db_path=db_path)
        await touch_thread(older.id, db_path=db_path)  # older is now most-recently-active
        await set_active_thread(newer.id, db_path=db_path)

        returned_active_id = await delete_thread(newer.id, db_path=db_path)
        assert returned_active_id == older.id
        assert await get_active_thread_id(db_path=db_path) == older.id
        assert await get_thread(newer.id, db_path=db_path) is None


async def test_delete_last_remaining_thread_creates_a_replacement() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        only = await get_active_thread_id(db_path=db_path)  # bootstraps the legacy thread

        replacement_id = await delete_thread(only, db_path=db_path)
        assert replacement_id != only
        assert await get_active_thread_id(db_path=db_path) == replacement_id
        assert await get_thread(replacement_id, db_path=db_path) is not None
        assert await get_thread(only, db_path=db_path) is None


async def test_delete_unknown_thread_raises_key_error() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        try:
            await delete_thread("does-not-exist", db_path=db_path)
            assert False, "expected KeyError"
        except KeyError:
            pass


async def test_create_project_assigns_colors_round_robin() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        projects = [await create_project(f"p{i}", db_path=db_path) for i in range(len(PROJECT_COLORS) + 2)]
        colors = [p.color for p in projects]
        assert colors == (PROJECT_COLORS + PROJECT_COLORS[:2])


async def test_list_projects_orders_by_creation() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        first = await create_project("Coding", db_path=db_path)
        second = await create_project("Research", db_path=db_path)
        projects = await list_projects(db_path=db_path)
        assert [p.id for p in projects] == [first.id, second.id]


async def test_rename_project_updates_name() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        project = await create_project("Coding", db_path=db_path)
        renamed = await rename_project(project.id, "Engineering", db_path=db_path)
        assert renamed.name == "Engineering"
        assert [p.name for p in await list_projects(db_path=db_path)] == ["Engineering"]


async def test_rename_project_unknown_id_raises_key_error() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        try:
            await rename_project("does-not-exist", "x", db_path=db_path)
            assert False, "expected KeyError"
        except KeyError:
            pass


async def test_assign_thread_project_sets_and_clears_project_id() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        project = await create_project("Coding", db_path=db_path)
        thread = await create_thread(title="Fix the bug", db_path=db_path)
        assert thread.project_id is None

        assigned = await assign_thread_project(thread.id, project.id, db_path=db_path)
        assert assigned.project_id == project.id
        assert (await get_thread(thread.id, db_path=db_path)).project_id == project.id

        cleared = await assign_thread_project(thread.id, None, db_path=db_path)
        assert cleared.project_id is None


async def test_assign_thread_project_unknown_thread_raises_key_error() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        project = await create_project("Coding", db_path=db_path)
        try:
            await assign_thread_project("does-not-exist", project.id, db_path=db_path)
            assert False, "expected KeyError"
        except KeyError:
            pass


async def test_assign_thread_project_unknown_project_raises_value_error() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        thread = await create_thread(db_path=db_path)
        try:
            await assign_thread_project(thread.id, "does-not-exist", db_path=db_path)
            assert False, "expected ValueError"
        except ValueError:
            pass


async def test_delete_project_unassigns_rather_than_deletes_its_threads() -> None:
    """PLAN.md Phase 28 Decision 4 — the whole point of this decision:
    deleting a Project must never delete a Thread."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        project = await create_project("Coding", db_path=db_path)
        thread = await create_thread(title="Fix the bug", db_path=db_path)
        await assign_thread_project(thread.id, project.id, db_path=db_path)

        await delete_project(project.id, db_path=db_path)

        survivor = await get_thread(thread.id, db_path=db_path)
        assert survivor is not None
        assert survivor.project_id is None
        assert await list_projects(db_path=db_path) == []


async def test_delete_project_unknown_id_raises_key_error() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        try:
            await delete_project("does-not-exist", db_path=db_path)
            assert False, "expected KeyError"
        except KeyError:
            pass


async def test_migration_adds_project_id_column_to_a_pre_phase_28_database() -> None:
    """Simulates a real user's already-existing threads.sqlite, created
    before Phase 28 (no `projects` table, no `project_id` column) —
    _migrate_add_project_id_column must add the column via ALTER TABLE
    without losing the existing row, and every function must keep working
    against it afterward."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "threads.sqlite"
        async with aiosqlite.connect(str(db_path)) as db:
            await db.execute(
                """
                CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    created_at TEXT NOT NULL,
                    last_active_at TEXT NOT NULL
                )
                """
            )
            await db.execute(
                "INSERT INTO threads (id, title, created_at, last_active_at) VALUES (?, ?, ?, ?)",
                ("pre-existing-thread", "Old conversation", "2026-01-01", "2026-01-01"),
            )
            await db.commit()

        pre_existing = await get_thread("pre-existing-thread", db_path=db_path)
        assert pre_existing is not None
        assert pre_existing.title == "Old conversation"
        assert pre_existing.project_id is None

        project = await create_project("Coding", db_path=db_path)
        assigned = await assign_thread_project("pre-existing-thread", project.id, db_path=db_path)
        assert assigned.project_id == project.id


if __name__ == "__main__":
    asyncio.run(test_fresh_store_bootstraps_the_legacy_default_thread())
    print("OK: test_fresh_store_bootstraps_the_legacy_default_thread")
    asyncio.run(test_create_thread_becomes_the_active_pointer())
    print("OK: test_create_thread_becomes_the_active_pointer")
    asyncio.run(test_set_active_thread_switches_the_pointer())
    print("OK: test_set_active_thread_switches_the_pointer")
    asyncio.run(test_set_active_thread_unknown_id_raises_key_error())
    print("OK: test_set_active_thread_unknown_id_raises_key_error")
    asyncio.run(test_rename_thread_updates_title())
    print("OK: test_rename_thread_updates_title")
    asyncio.run(test_rename_thread_unknown_id_raises_key_error())
    print("OK: test_rename_thread_unknown_id_raises_key_error")
    asyncio.run(test_list_threads_orders_by_last_active_desc())
    print("OK: test_list_threads_orders_by_last_active_desc")
    asyncio.run(test_touch_thread_unknown_id_is_a_noop())
    print("OK: test_touch_thread_unknown_id_is_a_noop")
    asyncio.run(test_delete_non_active_thread_leaves_pointer_unchanged())
    print("OK: test_delete_non_active_thread_leaves_pointer_unchanged")
    asyncio.run(test_delete_active_thread_reassigns_pointer_to_next_most_recent())
    print("OK: test_delete_active_thread_reassigns_pointer_to_next_most_recent")
    asyncio.run(test_delete_last_remaining_thread_creates_a_replacement())
    print("OK: test_delete_last_remaining_thread_creates_a_replacement")
    asyncio.run(test_delete_unknown_thread_raises_key_error())
    print("OK: test_delete_unknown_thread_raises_key_error")
    asyncio.run(test_create_project_assigns_colors_round_robin())
    print("OK: test_create_project_assigns_colors_round_robin")
    asyncio.run(test_list_projects_orders_by_creation())
    print("OK: test_list_projects_orders_by_creation")
    asyncio.run(test_rename_project_updates_name())
    print("OK: test_rename_project_updates_name")
    asyncio.run(test_rename_project_unknown_id_raises_key_error())
    print("OK: test_rename_project_unknown_id_raises_key_error")
    asyncio.run(test_assign_thread_project_sets_and_clears_project_id())
    print("OK: test_assign_thread_project_sets_and_clears_project_id")
    asyncio.run(test_assign_thread_project_unknown_thread_raises_key_error())
    print("OK: test_assign_thread_project_unknown_thread_raises_key_error")
    asyncio.run(test_assign_thread_project_unknown_project_raises_value_error())
    print("OK: test_assign_thread_project_unknown_project_raises_value_error")
    asyncio.run(test_delete_project_unassigns_rather_than_deletes_its_threads())
    print("OK: test_delete_project_unassigns_rather_than_deletes_its_threads")
    asyncio.run(test_delete_project_unknown_id_raises_key_error())
    print("OK: test_delete_project_unknown_id_raises_key_error")
    asyncio.run(test_migration_adds_project_id_column_to_a_pre_phase_28_database())
    print("OK: test_migration_adds_project_id_column_to_a_pre_phase_28_database")
    print("\n22 tests passed")
