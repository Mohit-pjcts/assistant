"""PLAN.md Phase 31 (D7) — turns that keep running when the client goes away.

A dashboard turn is tied to its HTTP request: `_stream_turn` is an async
generator driven by a `StreamingResponse`, and when the client disconnects
uvicorn cancels the whole request task, which cancels the turn (verified live
against the installed Starlette/uvicorn with a fake graph before this was
written, STEPS.md 173 — even while the graph is silent inside a long tool
call, and the turn is recorded as `cancelled`). That is right for a browser tab
you are watching and wrong for a phone: iOS suspends the app within seconds of
a screen lock and the connection dies with it, so a turn that takes a minute
would be thrown away halfway, along with the API spend.

A DETACHED turn (app-started turns only; the dashboard path is untouched) runs
as its own task. The HTTP response is only an observer: it reads frames from a
per-request queue the runner fills, and when the client goes away only that
observer is cancelled. The runner finishes whether or not anyone is watching.
`/chat/stop` keeps working unchanged — `_stream_turn` registers the RUNNER's
task in `app.state.active_tasks`, so cancelling it stops the turn.

Nothing is buffered for a late observer. A client that reconnects reads the
turn's state instead (`GET /threads/{id}/turn`: running / waiting for approval
/ idle, plus how the last detached turn ended) and the finished answer from
`/history`; it does not replay missed tokens. Both the registry and the
"last outcome" record are in memory: a backend restart (including a dev
`--reload`) ends any running detached turn, which is no worse than it is for
a dashboard turn.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from typing import Any

# A finished detached turn's outcome is kept so a client that reopens later can
# still see that it errored or was stopped (nothing about a background turn may
# be invisible). Bounded: one record per thread, oldest evicted.
_LAST_LIMIT = 50


class DetachedTurns:
    """The set of in-flight detached turns plus each thread's last outcome."""

    def __init__(self) -> None:
        self._running: dict[str, asyncio.Task[None]] = {}
        self._last: dict[str, dict[str, Any]] = {}

    def is_running(self, thread_id: str) -> bool:
        task = self._running.get(thread_id)
        return task is not None and not task.done()

    def last(self, thread_id: str) -> dict[str, Any] | None:
        return self._last.get(thread_id)

    def start(self, thread_id: str, frames: AsyncIterator[bytes]) -> asyncio.Queue[bytes | None]:
        """Run `frames` (an SSE frame generator) as an independent task and
        return the queue its first observer reads. The observer is registered
        before the task can produce anything, so no frame is missed."""
        queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        task = asyncio.create_task(self._drive(thread_id, frames, queue))
        # The registry holds the only strong reference: an unreferenced task
        # can be garbage-collected mid-run.
        self._running[thread_id] = task
        return queue

    async def _drive(
        self, thread_id: str, frames: AsyncIterator[bytes], queue: asyncio.Queue[bytes | None]
    ) -> None:
        outcome = "completed"
        detail: str | None = None
        try:
            async for frame in frames:
                kind, error = _sniff(frame)
                if kind == "error":
                    outcome, detail = "error", error
                queue.put_nowait(frame)
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        except Exception as exc:  # _stream_turn reports its own; this is a backstop
            outcome, detail = "error", f"{type(exc).__name__}: {exc}"
        finally:
            queue.put_nowait(None)
            self._running.pop(thread_id, None)
            self._last[thread_id] = {"outcome": outcome, "detail": detail, "finished_at": time.time()}
            while len(self._last) > _LAST_LIMIT:
                self._last.pop(next(iter(self._last)))


async def observe(queue: asyncio.Queue[bytes | None]) -> AsyncIterator[bytes]:
    """The HTTP response body for a detached turn: relays frames until the turn
    ends. Cancelling this (the client hanging up) never touches the turn."""
    while True:
        frame = await queue.get()
        if frame is None:
            return
        yield frame


def _sniff(frame: bytes) -> tuple[str | None, str | None]:
    """The frame's `type` and, for an error frame, its detail. Token frames
    dominate, so skip parsing them."""
    if frame.startswith(b'data: {"type": "token"'):
        return "token", None
    try:
        payload = json.loads(frame[len(b"data: ") :])
    except ValueError:
        return None, None
    if not isinstance(payload, dict):
        return None, None
    detail = payload.get("detail")
    return payload.get("type"), detail if isinstance(detail, str) else None


registry = DetachedTurns()
