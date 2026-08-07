"""Tests for assistant.active_turns — the in-memory in-flight-turn registry
built alongside circuit_breaker.py (STEPS.md 121-122) so the dashboard can
show ANY currently-running turn, across every channel, not just the one the
current browser tab happens to be streaming."""

from assistant import active_turns


def setup_function() -> None:
    """The registry is a bare module-level dict — clear it between tests so
    one test's turns can't leak into another's assertions."""
    active_turns._active.clear()
    active_turns._recently_ended.clear()


def test_start_touch_finish_round_trip() -> None:
    active_turns.start_turn("thread-1", channel="dashboard", agent="supervisor")
    active_turns.touch("thread-1", tool="render_ui", consecutive_failures=0)

    [entry] = active_turns.list_active()
    assert entry["thread_id"] == "thread-1"
    assert entry["channel"] == "dashboard"
    assert entry["current_tool"] == "render_ui"
    assert entry["step_count"] == 1
    assert entry["stuck"] is False

    active_turns.finish_turn("thread-1")
    assert active_turns.list_active() == []


def test_stuck_flag_set_once_two_consecutive_failures() -> None:
    """Mirrors circuit_breaker.py's own threshold logic — `stuck` is a
    lower bar than the breaker's own cutoff (3), deliberately: this is a
    display warning meant to surface BEFORE the breaker actually stops the
    loop, not just after."""
    active_turns.start_turn("thread-2", channel="voice", agent="supervisor")
    active_turns.touch("thread-2", tool="render_ui", consecutive_failures=1)
    assert active_turns.list_active()[0]["stuck"] is False

    active_turns.touch("thread-2", tool="render_ui", consecutive_failures=2)
    assert active_turns.list_active()[0]["stuck"] is True


def test_touch_on_unregistered_thread_is_a_silent_no_op() -> None:
    """Best-effort monitoring, never a hard dependency — a touch() for a
    turn that was never (or no longer) registered must not raise or create
    a phantom entry."""
    active_turns.touch("never-started", tool="x", consecutive_failures=0)
    assert active_turns.list_active() == []


def test_multiple_channels_listed_independently() -> None:
    active_turns.start_turn("thread-a", channel="voice", agent="supervisor")
    active_turns.start_turn("automation:auto-1", channel="automation", agent="life_admin_agent")

    channels = {e["channel"] for e in active_turns.list_active()}
    assert channels == {"voice", "automation"}


def test_finish_turn_on_unregistered_thread_is_a_silent_no_op() -> None:
    active_turns.finish_turn("never-started")  # must not raise
    assert active_turns.list_recent() == []


def test_finish_turn_records_outcome_in_recently_ended() -> None:
    active_turns.start_turn("thread-3", channel="phone", agent="phone_agent")
    active_turns.finish_turn("thread-3", outcome="error")

    assert active_turns.list_active() == []
    [entry] = active_turns.list_recent()
    assert entry["thread_id"] == "thread-3"
    assert entry["channel"] == "phone"
    assert entry["agent"] == "phone_agent"
    assert entry["outcome"] == "error"
    assert entry["seconds_since_ended"] >= 0


def test_finish_turn_defaults_to_completed_outcome() -> None:
    active_turns.start_turn("thread-4", channel="dashboard", agent="supervisor")
    active_turns.finish_turn("thread-4")

    [entry] = active_turns.list_recent()
    assert entry["outcome"] == "completed"


def test_list_recent_excludes_entries_outside_the_time_window() -> None:
    active_turns.start_turn("thread-5", channel="voice", agent="supervisor")
    active_turns.finish_turn("thread-5", outcome="cancelled")

    assert active_turns.list_recent(within_seconds=30) != []
    # A negative window is a cheap way to simulate "already aged out"
    # without sleeping in a test.
    assert active_turns.list_recent(within_seconds=-1) == []


def test_recently_ended_list_is_bounded() -> None:
    for i in range(active_turns._RECENTLY_ENDED_LIMIT + 5):
        thread_id = f"thread-bound-{i}"
        active_turns.start_turn(thread_id, channel="automation", agent="life_admin_agent")
        active_turns.finish_turn(thread_id)

    recent = active_turns.list_recent()
    assert len(recent) == active_turns._RECENTLY_ENDED_LIMIT
    # Oldest-first, and only the most recent LIMIT entries survive — the
    # earliest ones (thread-bound-0..4) must have been trimmed off.
    assert recent[0]["thread_id"] == "thread-bound-5"
    assert recent[-1]["thread_id"] == f"thread-bound-{active_turns._RECENTLY_ENDED_LIMIT + 4}"


if __name__ == "__main__":
    tests = [(name, fn) for name, fn in list(globals().items()) if name.startswith("test_")]
    for name, fn in tests:
        setup_function()
        fn()
        print(f"OK: {name}")
    print(f"\n{len(tests)} tests passed")
