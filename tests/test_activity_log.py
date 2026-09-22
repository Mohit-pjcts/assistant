"""Tests for assistant.activity_log — the durable cross-channel activity
log scoped from the reliability/orchestration backlog audit (STEPS.md 151),
the real feature behind the "event bus" wishlist item. Same real-file,
temp-path pattern as test_thread_store.py/test_workflow_store.py."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from assistant import activity_log


@pytest.fixture()
def db_path():
    with tempfile.TemporaryDirectory() as tmp:
        yield Path(tmp) / "activity_log.sqlite"


async def test_list_recent_is_empty_for_a_fresh_db(db_path):
    events = await activity_log.list_recent(db_path=db_path)
    assert events == []


async def test_record_and_list_round_trips(db_path):
    await activity_log.record_event(
        "thread-1", "life_admin_agent", activity_log.OUTCOME_SUCCESS, db_path=db_path
    )
    events = await activity_log.list_recent(db_path=db_path)
    assert len(events) == 1
    assert events[0].thread_id == "thread-1"
    assert events[0].agent == "life_admin_agent"
    assert events[0].outcome == activity_log.OUTCOME_SUCCESS


async def test_list_recent_orders_most_recent_first(db_path):
    await activity_log.record_event("t1", "agent_a", activity_log.OUTCOME_SUCCESS, db_path=db_path)
    await activity_log.record_event("t2", "agent_b", activity_log.OUTCOME_ERROR, db_path=db_path)
    events = await activity_log.list_recent(db_path=db_path)
    assert [e.thread_id for e in events] == ["t2", "t1"]


async def test_list_recent_respects_limit(db_path):
    for i in range(5):
        await activity_log.record_event(f"t{i}", "agent", activity_log.OUTCOME_SUCCESS, db_path=db_path)
    events = await activity_log.list_recent(limit=2, db_path=db_path)
    assert len(events) == 2


async def test_prune_older_than_removes_only_old_rows(db_path):
    await activity_log.record_event(
        "old",
        "agent",
        activity_log.OUTCOME_SUCCESS,
        started_at="2020-01-01T00:00:00+00:00",
        db_path=db_path,
    )
    # record_event's own finished_at is always "now" — patch it directly
    # via a raw insert so this test controls BOTH timestamps precisely,
    # rather than depending on real wall-clock time to age an entry.
    import aiosqlite

    async with aiosqlite.connect(str(db_path)) as db:
        await db.execute(
            "UPDATE activity_events SET finished_at = ? WHERE thread_id = ?",
            ("2020-01-01T00:00:00+00:00", "old"),
        )
        await db.commit()

    await activity_log.record_event("recent", "agent", activity_log.OUTCOME_SUCCESS, db_path=db_path)

    deleted = await activity_log.prune_older_than(days=30, db_path=db_path)
    assert deleted == 1
    events = await activity_log.list_recent(db_path=db_path)
    assert [e.thread_id for e in events] == ["recent"]
