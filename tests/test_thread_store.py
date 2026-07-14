"""Tests for assistant.thread_store — Phase 15's active-thread pointer +
thread registry. Runnable directly, matching tests/test_memory_store.py's
convention (real SQLite I/O against a temp file, no mocking)."""

import asyncio
import tempfile
from pathlib import Path

from assistant.thread_store import (
    LEGACY_DEFAULT_THREAD_ID,
    create_thread,
    delete_thread,
    get_active_thread_id,
    get_thread,
    list_threads,
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
    print("\n12 tests passed")
