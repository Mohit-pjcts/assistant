"""assistant/claude_code_sessions.py — read-only parsing of run_claude_code's
own Claude Code session transcripts, for the dashboard's Claude Code
Sessions panel. Builds fake .jsonl transcripts matching the real shape
observed on-disk (STEPS.md, 2026-08-06) rather than guessing the schema.
"""

from __future__ import annotations

import json
from pathlib import Path

import assistant.claude_code_sessions as ccs


def _write_session(project_dir: Path, session_id: str, *, entrypoint: str = "sdk-cli") -> None:
    project_dir.mkdir(parents=True, exist_ok=True)
    lines = [
        {
            "type": "user",
            "message": {"role": "user", "content": "Run echo hello and report the output."},
            "timestamp": "2026-08-06T11:50:36.000Z",
            "entrypoint": entrypoint,
            "sessionId": session_id,
        },
        {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "name": "Bash",
                        "input": {"command": "echo hello"},
                    }
                ],
            },
            "timestamp": "2026-08-06T11:50:37.000Z",
            "entrypoint": entrypoint,
            "sessionId": session_id,
        },
        {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "content": "hello", "is_error": False}],
            },
            "timestamp": "2026-08-06T11:50:38.000Z",
            "entrypoint": entrypoint,
            "sessionId": session_id,
        },
        {
            "type": "assistant",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "hello"}]},
            "timestamp": "2026-08-06T11:50:39.000Z",
            "entrypoint": entrypoint,
            "sessionId": session_id,
        },
        {"type": "ai-title", "aiTitle": "Echo test", "sessionId": session_id},
    ]
    path = project_dir / f"{session_id}.jsonl"
    with path.open("w") as f:
        for line in lines:
            f.write(json.dumps(line) + "\n")


def test_list_sessions_returns_empty_when_no_project_dir(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "nonexistent-home")
    assert ccs.list_sessions() == []


def test_list_sessions_finds_sdk_cli_sessions(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    project_dir = tmp_path / ".claude" / "projects" / str(tmp_path).replace("/", "-")
    _write_session(project_dir, "session-a")

    sessions = ccs.list_sessions()
    assert len(sessions) == 1
    assert sessions[0]["session_id"] == "session-a"
    assert sessions[0]["title"] == "Echo test"
    assert sessions[0]["event_count"] == 5
    assert sessions[0]["started_at"] == "2026-08-06T11:50:36.000Z"
    assert sessions[0]["ended_at"] == "2026-08-06T11:50:39.000Z"
    assert sessions[0]["is_live"] is False


def test_list_sessions_marks_a_currently_running_session_as_live(monkeypatch, tmp_path) -> None:
    """STEPS.md 149: is_live cross-references claude_code_live's registry —
    a session whose real process is still running looks identical to a
    finished one from the .jsonl file alone."""
    import assistant.claude_code_live as ccl

    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    project_dir = tmp_path / ".claude" / "projects" / str(tmp_path).replace("/", "-")
    _write_session(project_dir, "session-a")

    ccl.register("session-a", process=object(), prompt="still going")
    try:
        sessions = ccs.list_sessions()
        assert sessions[0]["is_live"] is True
    finally:
        ccl.unregister("session-a")


def test_list_sessions_excludes_non_sdk_cli_sessions(monkeypatch, tmp_path) -> None:
    """Sessions launched interactively (not via run_claude_code) must not
    show up here — Claude Code's own browser already covers those, and
    this panel exists specifically for the ones that browser hides."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    project_dir = tmp_path / ".claude" / "projects" / str(tmp_path).replace("/", "-")
    _write_session(project_dir, "interactive-session", entrypoint="cli")

    assert ccs.list_sessions() == []


def test_read_session_parses_turns_and_blocks(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    project_dir = tmp_path / ".claude" / "projects" / str(tmp_path).replace("/", "-")
    _write_session(project_dir, "session-a")

    session = ccs.read_session("session-a")
    assert session is not None
    assert session["title"] == "Echo test"
    assert len(session["turns"]) == 4

    assert session["turns"][0]["role"] == "user"
    assert session["turns"][0]["blocks"] == [
        {"type": "text", "text": "Run echo hello and report the output."}
    ]

    assert session["turns"][1]["blocks"] == [
        {"type": "tool_use", "name": "Bash", "input": {"command": "echo hello"}}
    ]

    assert session["turns"][2]["blocks"] == [
        {"type": "tool_result", "content": "hello", "is_error": False}
    ]

    assert session["turns"][3]["blocks"] == [{"type": "text", "text": "hello"}]


def test_read_session_returns_none_for_missing_session(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert ccs.read_session("does-not-exist") is None


def test_read_session_blocks_path_traversal(monkeypatch, tmp_path) -> None:
    """A session_id containing '..' must not escape _project_dir(), even
    when a real file exists at the path traversal would resolve to."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    project_dir = tmp_path / ".claude" / "projects" / str(tmp_path).replace("/", "-")
    project_dir.mkdir(parents=True)
    outside_target = tmp_path / "secrets.jsonl"
    outside_target.write_text('{"type": "user", "message": {"content": "leaked"}}\n')

    assert ccs.read_session("../../../secrets") is None


def test_list_sessions_skips_malformed_lines(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    project_dir = tmp_path / ".claude" / "projects" / str(tmp_path).replace("/", "-")
    project_dir.mkdir(parents=True)
    path = project_dir / "broken.jsonl"
    path.write_text(
        '{"type": "user", "message": {"role": "user", "content": "hi"}, '
        '"timestamp": "2026-08-06T00:00:00.000Z", "entrypoint": "sdk-cli"}\n'
        "not valid json\n"
        "\n"
    )
    sessions = ccs.list_sessions()
    assert len(sessions) == 1
    assert sessions[0]["session_id"] == "broken"
