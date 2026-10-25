"""write_cap_store: the durable per-turn gated-write counter."""

from __future__ import annotations

from assistant import write_cap_store


def test_record_and_count(tmp_path) -> None:
    db = tmp_path / "caps.sqlite"
    write_cap_store.record_write("t1", "turn-a", "call-1", "send_email", db)
    write_cap_store.record_write("t1", "turn-a", "call-2", "create_calendar_event", db)
    assert write_cap_store.count_writes("t1", "turn-a", db) == 2


def test_replay_of_the_same_call_never_double_counts(tmp_path) -> None:
    """A /resume replay, concurrent duplicate resume, or retry re-runs the
    same logical call with the SAME tool_call_id — it must record once."""
    db = tmp_path / "caps.sqlite"
    for _ in range(3):
        write_cap_store.record_write("t1", "turn-a", "call-1", "send_email", db)
    assert write_cap_store.count_writes("t1", "turn-a", db) == 1


def test_turns_and_threads_are_separate_buckets(tmp_path) -> None:
    db = tmp_path / "caps.sqlite"
    write_cap_store.record_write("t1", "turn-a", "call-1", "send_email", db)
    write_cap_store.record_write("t1", "turn-b", "call-2", "send_email", db)
    write_cap_store.record_write("t2", "turn-a", "call-3", "send_email", db)
    assert write_cap_store.count_writes("t1", "turn-a", db) == 1
    assert write_cap_store.count_writes("t1", "turn-b", db) == 1
    assert write_cap_store.count_writes("t2", "turn-a", db) == 1
    assert write_cap_store.count_writes("t1", "turn-c", db) == 0


def test_store_records_no_payload_or_secrets(tmp_path) -> None:
    """The counter persists identifiers only — never recipients, bodies,
    event details, or any argument payload."""
    db = tmp_path / "caps.sqlite"
    write_cap_store.record_write("t1", "turn-a", "call-1", "send_email", db)
    import sqlite3

    conn = sqlite3.connect(str(db))
    rows = conn.execute("SELECT * FROM turn_writes").fetchall()
    cols = [d[1] for d in conn.execute("PRAGMA table_info(turn_writes)").fetchall()]
    conn.close()
    assert cols == ["thread_id", "turn_id", "tool_call_id", "tool_name", "executed_at"]
    for row in rows:
        for cell in row:
            assert "a@example.com" not in str(cell) and "subject" not in str(cell).lower()
