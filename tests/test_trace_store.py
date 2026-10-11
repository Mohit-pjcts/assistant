"""Tests for assistant.trace_store — the durable record of every tool call
and specialist model turn behind the History panel (STEPS.md 158). Same
real-file, temp-path pattern as
test_activity_log.py/test_thread_store.py: a real SQLite file in a temp dir,
no mocks."""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import aiosqlite
import pytest

from assistant import trace_store


@pytest.fixture()
def db_path():
    with tempfile.TemporaryDirectory() as tmp:
        yield Path(tmp) / "traces.sqlite"


async def test_calls_for_thread_is_empty_for_a_fresh_db(db_path):
    assert await trace_store.calls_for_thread("t1", db_path=db_path) == []


async def test_record_and_read_back_round_trips_every_field(db_path):
    row_id = await trace_store.record_call(
        "thread-1",
        "toolu_1",
        "coding_agent",
        "run_claude_code",
        parent_tool_call_id="toolu_0",
        kind=trace_store.KIND_TOOL,
        input='{"task": "list files"}',
        output="a.txt\nb.txt",
        thinking="should list them",
        extras='{"phone_action": [{"type": "open_url"}]}',
        status=trace_store.STATUS_OK,
        error=None,
        started_at="2026-10-06T10:00:00+00:00",
        ended_at="2026-10-06T10:00:02+00:00",
        duration_ms=2000,
        db_path=db_path,
    )
    [call] = await trace_store.calls_for_thread("thread-1", db_path=db_path)
    assert call.id == row_id
    assert call.seq == 1
    assert call.thread_id == "thread-1"
    assert call.tool_call_id == "toolu_1"
    assert call.parent_tool_call_id == "toolu_0"
    assert call.agent == "coding_agent"
    assert call.name == "run_claude_code"
    assert call.kind == "tool"
    assert call.input == '{"task": "list files"}'
    assert call.output == "a.txt\nb.txt"
    assert call.thinking == "should list them"
    assert call.extras == '{"phone_action": [{"type": "open_url"}]}'
    assert call.status == "ok"
    assert call.error is None
    assert call.started_at == "2026-10-06T10:00:00+00:00"
    assert call.ended_at == "2026-10-06T10:00:02+00:00"
    assert call.duration_ms == 2000


async def test_optional_fields_default_to_empty_and_timestamps_to_now(db_path):
    await trace_store.record_call("t1", "c1", "supervisor", "render_ui", db_path=db_path)
    [call] = await trace_store.calls_for_thread("t1", db_path=db_path)
    assert isinstance(call, trace_store.TraceRow)
    assert call.parent_tool_call_id is None
    assert call.kind == trace_store.KIND_TOOL
    assert call.input == ""
    assert call.output is None
    assert call.thinking is None
    assert call.extras is None
    assert call.error is None
    assert call.duration_ms is None
    assert call.status == trace_store.STATUS_OK
    assert call.started_at  # a real ISO timestamp, filled in
    assert call.started_at == call.ended_at


async def test_row_ids_are_unique_uuids(db_path):
    a = await trace_store.record_call("t1", "c1", "supervisor", "x", db_path=db_path)
    b = await trace_store.record_call("t1", "c2", "supervisor", "x", db_path=db_path)
    assert a != b and len(a) == 36


async def test_seq_follows_insert_order_not_timestamps(db_path):
    """A later insert with an EARLIER timestamp still sorts after: seq is the
    order things were recorded, which is what a finishing order means."""
    await trace_store.record_call(
        "t1", "c1", "supervisor", "first", ended_at="2026-10-06T12:00:00+00:00", db_path=db_path
    )
    await trace_store.record_call(
        "t1", "c2", "supervisor", "second", ended_at="2026-10-06T08:00:00+00:00", db_path=db_path
    )
    calls = await trace_store.calls_for_thread("t1", db_path=db_path)
    assert [c.name for c in calls] == ["first", "second"]
    assert [c.seq for c in calls] == [1, 2]


async def test_concurrent_inserts_never_draw_the_same_seq(db_path):
    """Parallel tool calls finish at the same moment; seq is taken inside the
    INSERT, so none of them can collide."""
    await asyncio.gather(
        *(
            trace_store.record_call("t1", f"c{i}", "supervisor", f"tool{i}", db_path=db_path)
            for i in range(25)
        )
    )
    calls = await trace_store.calls_for_thread("t1", db_path=db_path)
    assert [c.seq for c in calls] == list(range(1, 26))


async def test_calls_for_thread_isolates_threads_and_seq_is_global(db_path):
    await trace_store.record_call("t1", "c1", "supervisor", "a", db_path=db_path)
    await trace_store.record_call("t2", "c2", "supervisor", "b", db_path=db_path)
    await trace_store.record_call("t1", "c3", "supervisor", "c", db_path=db_path)
    t1 = await trace_store.calls_for_thread("t1", db_path=db_path)
    t2 = await trace_store.calls_for_thread("t2", db_path=db_path)
    assert [c.name for c in t1] == ["a", "c"]
    assert [c.name for c in t2] == ["b"]
    assert [c.seq for c in t1] == [1, 3]


async def test_a_field_at_the_cap_is_kept_whole(db_path):
    text = "x" * trace_store.MAX_FIELD_CHARS
    await trace_store.record_call("t1", "c1", "supervisor", "n", input=text, db_path=db_path)
    [call] = await trace_store.calls_for_thread("t1", db_path=db_path)
    assert call.input == text


async def test_a_field_over_the_cap_is_clipped_with_an_explicit_tail(db_path):
    cap = trace_store.MAX_FIELD_CHARS
    await trace_store.record_call(
        "t1",
        "c1",
        "supervisor",
        "n",
        input="i" * (cap + 7),
        output="o" * (cap + 1234),
        thinking="t" * (cap + 2),
        extras="x" * (cap + 30),
        error="e" * (cap + 1),
        db_path=db_path,
    )
    [call] = await trace_store.calls_for_thread("t1", db_path=db_path)
    assert call.input == "i" * cap + "\n[… 7 more characters not stored]"
    assert call.output == "o" * cap + "\n[… 1234 more characters not stored]"
    assert call.thinking == "t" * cap + "\n[… 2 more characters not stored]"
    assert call.extras == "x" * cap + "\n[… 30 more characters not stored]"
    assert call.error == "e" * cap + "\n[… 1 more characters not stored]"


async def test_the_cap_is_200_000_characters():
    assert trace_store.MAX_FIELD_CHARS == 200_000


async def test_db_uses_wal_and_has_the_lookup_indexes(db_path):
    await trace_store.record_call("t1", "c1", "supervisor", "n", db_path=db_path)
    async with aiosqlite.connect(str(db_path)) as db:
        mode = await (await db.execute("PRAGMA journal_mode")).fetchone()
        indexes = await (await db.execute("PRAGMA index_list('trace_rows')")).fetchall()
        columns = await (await db.execute("PRAGMA table_info('trace_rows')")).fetchall()
    assert mode[0] == "wal"
    index_names = {row[1] for row in indexes}
    assert {
        "idx_trace_rows_thread_seq",
        "idx_trace_rows_tool_call_id",
        "idx_trace_rows_seq",
    } <= index_names
    assert [c[1] for c in columns] == [
        "id",
        "seq",
        "thread_id",
        "tool_call_id",
        "parent_tool_call_id",
        "agent",
        "name",
        "kind",
        "input",
        "output",
        "thinking",
        "extras",
        "status",
        "error",
        "started_at",
        "ended_at",
        "duration_ms",
    ]
    # `kind` is NOT NULL and defaults to 'tool'.
    kind_column = next(c for c in columns if c[1] == "kind")
    assert kind_column[3] == 1 and kind_column[4] == "'tool'"


async def test_default_path_is_resolved_at_call_time(monkeypatch, db_path):
    """server.py's env redirect and tests override DEFAULT_DB_PATH after
    import; a path bound as a parameter default would miss that."""
    monkeypatch.setattr(trace_store, "DEFAULT_DB_PATH", db_path)
    await trace_store.record_call("t1", "c1", "supervisor", "n")
    assert db_path.exists()
    assert len(await trace_store.calls_for_thread("t1")) == 1


async def test_the_table_holds_both_kinds_of_row_in_one_seq_order(db_path):
    """A specialist's model turns and its tool calls read back as one list."""
    await trace_store.record_call(
        "t1",
        "msg_1",
        "research_agent",
        "claude-sonnet-5",
        parent_tool_call_id="p1",
        kind=trace_store.KIND_ASSISTANT,
        output="Let me search.",
        thinking="I need current data.",
        extras='{"usage": {"input_tokens": 10, "output_tokens": 5}, "stop_reason": "tool_use"}',
        db_path=db_path,
    )
    await trace_store.record_call(
        "t1", "s1", "research_agent", "web_search", parent_tool_call_id="p1", db_path=db_path
    )
    rows = await trace_store.calls_for_thread("t1", db_path=db_path)
    assert [(r.kind, r.name) for r in rows] == [
        ("assistant", "claude-sonnet-5"),
        ("tool", "web_search"),
    ]
    assert rows[0].thinking == "I need current data."
    assert rows[0].output == "Let me search."
    assert rows[1].thinking is None


async def test_kind_names_are_tool_and_assistant():
    assert (trace_store.KIND_TOOL, trace_store.KIND_ASSISTANT) == ("tool", "assistant")


async def test_a_file_deleted_under_a_running_process_is_set_up_again(db_path):
    """The user clearing traces.sqlite while the server runs must not leave
    every later record failing on a missing table."""
    await trace_store.record_call("t1", "c1", "supervisor", "before", db_path=db_path)
    for suffix in ("", "-wal", "-shm"):
        Path(f"{db_path}{suffix}").unlink(missing_ok=True)
    await trace_store.record_call("t1", "c2", "supervisor", "after", db_path=db_path)
    calls = await trace_store.calls_for_thread("t1", db_path=db_path)
    assert [c.name for c in calls] == ["after"]


async def test_prune_older_than_removes_only_old_rows(db_path):
    await trace_store.record_call(
        "t1", "old", "supervisor", "old", ended_at="2020-01-01T00:00:00+00:00", db_path=db_path
    )
    await trace_store.record_call("t1", "new", "supervisor", "new", db_path=db_path)
    assert await trace_store.prune_older_than(30, db_path=db_path) == 1
    calls = await trace_store.calls_for_thread("t1", db_path=db_path)
    assert [c.name for c in calls] == ["new"]


async def test_nothing_prunes_on_its_own(db_path):
    """The user wants the full history: old rows stay until someone calls
    prune_older_than on purpose."""
    await trace_store.record_call(
        "t1", "old", "supervisor", "old", ended_at="2020-01-01T00:00:00+00:00", db_path=db_path
    )
    await trace_store.record_call("t1", "new", "supervisor", "new", db_path=db_path)
    assert len(await trace_store.calls_for_thread("t1", db_path=db_path)) == 2
