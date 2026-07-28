"""Tests for assistant.memory_store — Phase 7 Part B's long-term fact
storage and recall. Runnable directly, matching tests/test_memory.py's
convention (real SQLite I/O against a temp file, no mocking — cheap and
deterministic since this is pure storage, no LLM calls involved)."""

import asyncio
import tempfile
from pathlib import Path

from assistant.memory_store import (
    approve_pending_fact,
    decline_pending_fact,
    delete_fact,
    get_review_cursor,
    list_facts,
    list_pending_facts,
    propose_pending_fact,
    recall_facts,
    save_fact,
    set_review_cursor,
    update_fact,
)


async def test_save_and_list_round_trip() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        await save_fact("user prefers terse responses", db_path=db_path)
        await save_fact("user's timezone is America/New_York", provenance="from calendar", db_path=db_path)

        facts = await list_facts(db_path=db_path)
        assert len(facts) == 2
        contents = {f.content for f in facts}
        assert contents == {"user prefers terse responses", "user's timezone is America/New_York"}
        tz_fact = next(f for f in facts if "timezone" in f.content)
        assert tz_fact.provenance == "from calendar"


async def test_recall_returns_all_when_store_is_small() -> None:
    """Below the small-store threshold, filtering would just add noise —
    return everything regardless of query relevance."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        await save_fact("user likes hiking", db_path=db_path)
        await save_fact("user is vegetarian", db_path=db_path)

        recalled = await recall_facts("completely unrelated query about spreadsheets", db_path=db_path)
        assert len(recalled) == 2


async def test_recall_filters_by_keyword_overlap_above_threshold() -> None:
    """Above the small-store threshold, only facts sharing a keyword with
    the query should come back — this is the actual 'selective recall, not
    dump-everything' behavior the phase requires."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        for i in range(6):
            await save_fact(f"filler fact number {i} about nothing relevant", db_path=db_path)
        await save_fact("user is allergic to peanuts", db_path=db_path)

        recalled = await recall_facts("what should I avoid, any peanuts in this recipe?", db_path=db_path)
        assert any("peanuts" in f.content for f in recalled)
        assert all("peanuts" in f.content or "avoid" in f.content for f in recalled), (
            "irrelevant filler facts must not be recalled when the store is large enough to filter"
        )


async def test_recall_empty_store_returns_nothing() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        recalled = await recall_facts("anything", db_path=db_path)
        assert recalled == []


async def test_update_fact_changes_content_in_place() -> None:
    """User editing an already-saved fact — id and provenance stay put,
    only content changes."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        fact_id = await save_fact("user likes tea", provenance="user", db_path=db_path)

        updated = await update_fact(fact_id, "user likes coffee", db_path=db_path)
        assert updated is True

        facts = await list_facts(db_path=db_path)
        assert len(facts) == 1
        assert facts[0].id == fact_id
        assert facts[0].content == "user likes coffee"
        assert facts[0].provenance == "user"


async def test_update_unknown_fact_returns_false() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        updated = await update_fact(999999, "irrelevant", db_path=db_path)
        assert updated is False


async def test_delete_fact_removes_it() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        fact_id = await save_fact("user is left-handed", db_path=db_path)

        deleted = await delete_fact(fact_id, db_path=db_path)
        assert deleted is True
        assert await list_facts(db_path=db_path) == []


async def test_approve_pending_fact_moves_it_into_facts_verbatim() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        pending_id = await propose_pending_fact(
            "user is vegetarian", provenance="nightly review", db_path=db_path
        )

        saved = await approve_pending_fact(pending_id, db_path=db_path)
        assert saved is not None
        assert saved.content == "user is vegetarian"
        assert saved.provenance == "nightly review"

        assert await list_pending_facts(db_path=db_path) == []
        facts = await list_facts(db_path=db_path)
        assert len(facts) == 1
        assert facts[0].content == "user is vegetarian"


async def test_approve_unknown_pending_fact_returns_none() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        assert await approve_pending_fact(999999, db_path=db_path) is None


async def test_decline_pending_fact_discards_it_without_saving() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        pending_id = await propose_pending_fact("user likes jazz", db_path=db_path)

        declined = await decline_pending_fact(pending_id, db_path=db_path)
        assert declined is True
        assert await list_pending_facts(db_path=db_path) == []
        assert await list_facts(db_path=db_path) == []


async def test_decline_unknown_pending_fact_returns_false() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        assert await decline_pending_fact(999999, db_path=db_path) is False


async def test_review_cursor_defaults_to_zero_and_round_trips() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        assert await get_review_cursor("thread-a", db_path=db_path) == 0

        await set_review_cursor("thread-a", 3, db_path=db_path)
        assert await get_review_cursor("thread-a", db_path=db_path) == 3

        await set_review_cursor("thread-a", 5, db_path=db_path)
        assert await get_review_cursor("thread-a", db_path=db_path) == 5
        # A different thread's cursor is independent.
        assert await get_review_cursor("thread-b", db_path=db_path) == 0


if __name__ == "__main__":
    asyncio.run(test_save_and_list_round_trip())
    print("OK: test_save_and_list_round_trip")
    asyncio.run(test_recall_returns_all_when_store_is_small())
    print("OK: test_recall_returns_all_when_store_is_small")
    asyncio.run(test_recall_filters_by_keyword_overlap_above_threshold())
    print("OK: test_recall_filters_by_keyword_overlap_above_threshold")
    asyncio.run(test_recall_empty_store_returns_nothing())
    print("OK: test_recall_empty_store_returns_nothing")
    asyncio.run(test_update_fact_changes_content_in_place())
    print("OK: test_update_fact_changes_content_in_place")
    asyncio.run(test_update_unknown_fact_returns_false())
    print("OK: test_update_unknown_fact_returns_false")
    asyncio.run(test_delete_fact_removes_it())
    print("OK: test_delete_fact_removes_it")
    asyncio.run(test_approve_pending_fact_moves_it_into_facts_verbatim())
    print("OK: test_approve_pending_fact_moves_it_into_facts_verbatim")
    asyncio.run(test_approve_unknown_pending_fact_returns_none())
    print("OK: test_approve_unknown_pending_fact_returns_none")
    asyncio.run(test_decline_pending_fact_discards_it_without_saving())
    print("OK: test_decline_pending_fact_discards_it_without_saving")
    asyncio.run(test_decline_unknown_pending_fact_returns_false())
    print("OK: test_decline_unknown_pending_fact_returns_false")
    asyncio.run(test_review_cursor_defaults_to_zero_and_round_trips())
    print("OK: test_review_cursor_defaults_to_zero_and_round_trips")
    print("\n12 tests passed")
