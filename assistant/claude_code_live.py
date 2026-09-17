"""In-memory registry of currently-running `run_claude_code` sessions
(assistant/claude_code_tool.py), built at the user's own direct request:
"I always want to know if there's a process going on in the background" —
the same standing rule that produced `active_turns.py` (STEPS.md 122).

**Deliberately a separate registry, not folded into `active_turns.py`** —
`active_turns.py` is keyed by `thread_id`, read from
`langgraph.config.get_config()` at the SUPERVISOR's own top level; a
nested specialist's own inner tool call (which is exactly what
`run_claude_code` is — a tool called by `coding_agent`'s own isolated,
checkpointer-less `ainvoke()`) has no `configurable.thread_id` available
to it either, per that module's own documented scope limit. A
`run_claude_code` session has no natural `thread_id` to key on, but it
does have something `active_turns.py` entries don't: a real OS process
that can be asked how it's doing, and actually terminated — a
fundamentally different shape of "in-flight thing," not a variant of the
same one.

**Deliberately in-memory, not durable** — same reasoning as
`active_turns.py`: nothing here should survive a server restart, since a
restarted server has no live subprocesses left to track by definition.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field


@dataclass
class LiveSession:
    session_id: str
    prompt_preview: str
    process: asyncio.subprocess.Process
    started_at: float = field(default_factory=time.monotonic)

    def to_dict(self) -> dict[str, object]:
        return {
            "session_id": self.session_id,
            "prompt_preview": self.prompt_preview,
            "elapsed_seconds": round(time.monotonic() - self.started_at, 1),
        }


_live: dict[str, LiveSession] = {}


def register(session_id: str, process: asyncio.subprocess.Process, prompt: str) -> None:
    """Registers a just-started session. `prompt` is truncated the same way
    `claude_code_sessions.list_sessions()` truncates a session's own first
    user message, so the two views read consistently."""
    _live[session_id] = LiveSession(session_id=session_id, prompt_preview=prompt[:200], process=process)


def unregister(session_id: str) -> None:
    """Removes a session once it's finished (success, failure, or killed).
    Always call from a `finally` block — see `run_claude_code`'s own
    docstring — so an unexpected exception never leaves a stale entry
    claiming a session is still running when it isn't."""
    _live.pop(session_id, None)


def list_live() -> list[dict[str, object]]:
    """Every currently-running session, oldest first."""
    return [s.to_dict() for s in sorted(_live.values(), key=lambda s: s.started_at)]


def is_live(session_id: str) -> bool:
    return session_id in _live


async def stop(session_id: str) -> bool:
    """Terminates a live session's real OS process. Returns False if no
    such live session exists (already finished, or never existed) rather
    than raising — the caller (server.py's stop endpoint) turns that into
    a plain 404, not a crash. Sends SIGTERM first (`Process.terminate()`)
    and gives it a moment to exit cleanly before escalating to SIGKILL —
    `claude`'s own CLI may want to flush its transcript file on a clean
    terminate, which a raw SIGKILL wouldn't allow.

    Unregisters here directly, rather than only relying on the matching
    `run_claude_code` call's own `finally` block to notice the process
    died and unregister itself — a user who just clicked "stop" should see
    the session disappear from the live list immediately, not race an
    unrelated coroutine's own cleanup timing."""
    session = _live.get(session_id)
    if session is None:
        return False
    session.process.terminate()
    try:
        await asyncio.wait_for(session.process.wait(), timeout=5.0)
    except TimeoutError:
        session.process.kill()
    unregister(session_id)
    return True
