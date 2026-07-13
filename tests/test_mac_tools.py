"""Tests for assistant.mac_tools — the security-critical guardrails in
particular.

Runnable directly (no test framework required yet). subprocess.run is
monkeypatched throughout so these tests don't require macOS, an installed
Music/Reminders/Notes/Shortcuts app, or Automation permission grants — the
manual, real-app verification for those lives in STEPS.md (Phase 4 step 4),
not here. What's tested here is the guardrail *shape*: argv-list execution
only, model-supplied values never interpolated into AppleScript source, and
run_shortcut's confirmation gate actually blocking execution before resume.
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
    print("\n7 tests passed")
