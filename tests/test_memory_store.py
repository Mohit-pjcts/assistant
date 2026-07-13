"""Tests for assistant.memory_store — Phase 7 Part B's long-term fact
storage and recall. Runnable directly, matching tests/test_memory.py's
convention (real SQLite I/O against a temp file, no mocking — cheap and
deterministic since this is pure storage, no LLM calls involved)."""

import asyncio
import tempfile
from pathlib import Path

from assistant.memory_store import list_facts, recall_facts, save_fact


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


if __name__ == "__main__":
    asyncio.run(test_save_and_list_round_trip())
    print("OK: test_save_and_list_round_trip")
    asyncio.run(test_recall_returns_all_when_store_is_small())
    print("OK: test_recall_returns_all_when_store_is_small")
    asyncio.run(test_recall_filters_by_keyword_overlap_above_threshold())
    print("OK: test_recall_filters_by_keyword_overlap_above_threshold")
    asyncio.run(test_recall_empty_store_returns_nothing())
    print("OK: test_recall_empty_store_returns_nothing")
    print("\n4 tests passed")
