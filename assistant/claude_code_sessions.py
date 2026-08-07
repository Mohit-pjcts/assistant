"""Read-only access to run_claude_code's own Claude Code session
transcripts, for the dashboard's Claude Code Sessions panel.

run_claude_code (assistant/claude_code_tool.py) always runs with
cwd=Path.home(), so every session it starts lands in Claude Code's own
per-project transcript store at
~/.claude/projects/<home path with "/" replaced by "-">/*.jsonl — a
directory-naming convention observed empirically on this machine, not
documented by Anthropic, so every read here fails soft (empty list /
None) rather than raising if the directory, a file, or a line is missing
or unreadable.

These sessions are tagged internally by Claude Code as
entrypoint="sdk-cli" (launched via `claude --print`, not a terminal) and
are therefore invisible in Claude Code's own interactive session
browser — this module (and the dashboard panel built on it) is the only
way to see them without reading the raw .jsonl by hand. list_sessions()
filters to exactly those sdk-cli-tagged sessions, so an unrelated
interactive Claude Code session that happens to also use $HOME as its
cwd doesn't show up here.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _project_dir() -> Path:
    home = Path.home()
    return home / ".claude" / "projects" / str(home).replace("/", "-")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    events = []
    try:
        with path.open() as f:
            for raw_line in f:
                raw_line = raw_line.strip()
                if not raw_line:
                    continue
                try:
                    events.append(json.loads(raw_line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return events


def list_sessions(limit: int = 50) -> list[dict[str, Any]]:
    """Return recent run_claude_code sessions, newest first."""
    project_dir = _project_dir()
    if not project_dir.is_dir():
        return []

    sessions = []
    for path in project_dir.glob("*.jsonl"):
        events = _read_jsonl(path)
        if not any(e.get("entrypoint") == "sdk-cli" for e in events):
            continue

        title = next((e["aiTitle"] for e in events if e.get("type") == "ai-title"), None)
        first_user_text = next(
            (
                e["message"]["content"]
                for e in events
                if e.get("type") == "user"
                and isinstance(e.get("message", {}).get("content"), str)
            ),
            "",
        )
        timestamps = [e["timestamp"] for e in events if e.get("timestamp")]

        sessions.append(
            {
                "session_id": path.stem,
                "title": title or first_user_text[:80],
                "prompt_preview": first_user_text[:200],
                "started_at": min(timestamps) if timestamps else None,
                "ended_at": max(timestamps) if timestamps else None,
                "event_count": len(events),
            }
        )

    sessions.sort(key=lambda s: s["started_at"] or "", reverse=True)
    return sessions[:limit]


def read_session(session_id: str) -> dict[str, Any] | None:
    """Return the parsed transcript for one session, or None if not found."""
    path = _project_dir() / f"{session_id}.jsonl"
    if not path.is_file():
        return None
    events = _read_jsonl(path)

    turns = []
    for e in events:
        if e.get("type") not in ("user", "assistant"):
            continue
        message = e.get("message") or {}
        role = message.get("role", e["type"])
        content = message.get("content")
        blocks: list[dict[str, Any]] = []
        if isinstance(content, str):
            blocks.append({"type": "text", "text": content})
        elif isinstance(content, list):
            for block in content:
                block_type = block.get("type")
                if block_type == "text":
                    blocks.append({"type": "text", "text": block.get("text", "")})
                elif block_type == "tool_use":
                    blocks.append(
                        {
                            "type": "tool_use",
                            "name": block.get("name"),
                            "input": block.get("input"),
                        }
                    )
                elif block_type == "tool_result":
                    blocks.append(
                        {
                            "type": "tool_result",
                            "content": block.get("content"),
                            "is_error": block.get("is_error", False),
                        }
                    )
        if blocks:
            turns.append({"role": role, "blocks": blocks, "timestamp": e.get("timestamp")})

    title = next((e["aiTitle"] for e in events if e.get("type") == "ai-title"), None)
    return {"session_id": session_id, "title": title, "turns": turns}
