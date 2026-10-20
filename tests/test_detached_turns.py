"""Tests for PLAN.md Phase 31's detached turns (`assistant/detached_turns.py` and
the `detached` flag on /chat, /resume and /a2ui/action).

No Anthropic calls: the graph is a fake. The integration tests run the REAL route
handlers on a real uvicorn socket (`lifespan="off"`, so no real graph, MCP or
Langfuse is started) because the property under test — what a client hanging up
does to a turn — only exists on a real connection; the repo's own notes
(test_server.py's stop test) record that TestClient can't model it. Every
database is a temp file, set before `assistant.server` is imported, same
ordering rule as test_server.py.
"""

import asyncio
import atexit
import contextlib
import json
import os
import shutil
import socket
import tempfile
import threading
import time
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
import uvicorn
from langchain_core.messages import AIMessage

_tmpdir = tempfile.mkdtemp(prefix="assistant_test_detached_")
atexit.register(shutil.rmtree, _tmpdir, ignore_errors=True)
for _name in (
    "CONVERSATION", "MEMORY", "THREADS", "BOARD", "PHONE", "AUTOMATIONS", "WORKFLOWS", "ACTIVITY_LOG",
):
    os.environ.setdefault(f"ASSISTANT_{_name}_DB_PATH", os.path.join(_tmpdir, f"{_name.lower()}.sqlite"))

from assistant import (  # noqa: E402
    active_turns,
    detached_turns,
    observability,
    server,
    thread_store,
)

THREAD = thread_store.LEGACY_DEFAULT_THREAD_ID


# --- the registry on its own ------------------------------------------------


async def _frames(*items: bytes, then_wait: asyncio.Event | None = None):
    for item in items:
        yield item
    if then_wait is not None:
        await then_wait.wait()


def _frame(payload: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(payload)}\n\n".encode()


async def _drain(queue: asyncio.Queue) -> list[bytes]:
    out = []
    while (item := await asyncio.wait_for(queue.get(), 2)) is not None:
        out.append(item)
    return out


async def test_the_observer_gets_every_frame_in_order_and_the_stream_ends() -> None:
    registry = detached_turns.DetachedTurns()
    a, b = _frame({"type": "token", "text": "x"}), _frame({"type": "message", "content": "done"})
    queue = registry.start("t", _frames(a, b))
    assert await _drain(queue) == [a, b]
    assert registry.last("t")["outcome"] == "completed"
    assert not registry.is_running("t")


async def test_the_turn_finishes_when_nobody_is_observing() -> None:
    registry = detached_turns.DetachedTurns()
    release = asyncio.Event()
    queue = registry.start("t", _frames(_frame({"type": "token", "text": "x"}), then_wait=release))
    observer = detached_turns.observe(queue)
    await observer.__anext__()
    await observer.aclose()  # the client hangs up
    await asyncio.sleep(0.05)
    assert registry.is_running("t"), "the turn must outlive its observer"
    release.set()
    for _ in range(100):
        if not registry.is_running("t"):
            break
        await asyncio.sleep(0.01)
    assert registry.last("t")["outcome"] == "completed"


async def test_cancelling_the_turn_records_cancelled_and_ends_the_observer() -> None:
    registry = detached_turns.DetachedTurns()
    queue = registry.start("t", _frames(_frame({"type": "token", "text": "x"}), then_wait=asyncio.Event()))
    # /chat/stop finds the task through `active_tasks`, which `_stream_turn` fills
    # from inside the running task — so a stop never lands before the first step.
    await asyncio.sleep(0)
    registry._running["t"].cancel()
    assert await asyncio.wait_for(_drain(queue), 2) is not None
    assert registry.last("t")["outcome"] == "cancelled"


async def test_an_error_frame_is_recorded_with_its_detail() -> None:
    registry = detached_turns.DetachedTurns()
    queue = registry.start("t", _frames(_frame({"type": "error", "detail": "RateLimitError: slow down"})))
    await _drain(queue)
    assert registry.last("t")["outcome"] == "error"
    assert registry.last("t")["detail"] == "RateLimitError: slow down"


async def test_a_generator_that_raises_is_recorded_as_an_error_not_lost() -> None:
    async def boom():
        yield _frame({"type": "token", "text": "x"})
        raise ValueError("kaput")

    registry = detached_turns.DetachedTurns()
    await _drain(registry.start("t", boom()))
    assert registry.last("t")["outcome"] == "error"
    assert "ValueError: kaput" in registry.last("t")["detail"]


async def test_the_last_outcome_record_is_bounded() -> None:
    registry = detached_turns.DetachedTurns()
    for i in range(detached_turns._LAST_LIMIT + 5):
        await _drain(registry.start(f"t{i}", _frames()))
    assert len(registry._last) == detached_turns._LAST_LIMIT
    assert registry.last("t0") is None and registry.last(f"t{detached_turns._LAST_LIMIT + 4}") is not None


# --- the real routes over a real socket -------------------------------------


class _Graph:
    """Stands in for the compiled supervisor graph. A turn emits one token, then
    waits for `release`, then emits another and ends — so a test decides exactly
    when the turn is finished."""

    def __init__(self) -> None:
        self.release = threading.Event()
        self.events: list[str] = []
        self.pending: Any = None  # a payload dict → aget_state reports a pending interrupt

    async def astream_events(self, _input: Any, config: Any = None, version: str | None = None):
        self.events.append("start")
        try:
            yield {"event": "on_chat_model_stream", "data": {"chunk": SimpleNamespace(content="hi")}}
            while not self.release.is_set():
                await asyncio.sleep(0.02)
            yield {"event": "on_chat_model_stream", "data": {"chunk": SimpleNamespace(content=" there")}}
            self.events.append("finished")
        except asyncio.CancelledError:
            self.events.append("cancelled")
            raise

    async def aget_state(self, _config: Any) -> Any:
        interrupts = [SimpleNamespace(value=self.pending)] if self.pending is not None else []
        return SimpleNamespace(
            tasks=[SimpleNamespace(interrupts=interrupts)] if interrupts else [],
            values={"messages": [AIMessage("hi there")]},
        )


@contextlib.contextmanager
def _null_tracing(*_a: Any, **_k: Any):
    yield None


@pytest.fixture
def live():
    """The real app on a real socket with a fake graph; yields (base_url, graph)."""
    asyncio.run(thread_store.get_active_thread_id(db_path=thread_store.DEFAULT_DB_PATH))  # bootstrap
    graph = _Graph()
    state = server.app.state
    saved = {k: getattr(state, k, None) for k in ("graph", "active_tasks", "pending_trace_headers")}
    state.graph, state.active_tasks, state.pending_trace_headers = graph, {}, {}
    original_tracing = observability.tracing_context
    observability.tracing_context = _null_tracing
    detached_turns.registry._running.clear()
    detached_turns.registry._last.clear()

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(server.app, host="127.0.0.1", port=port, lifespan="off", log_level="error"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    for _ in range(200):
        if srv.started:
            break
        time.sleep(0.02)
    try:
        yield f"http://127.0.0.1:{port}", graph
    finally:
        graph.release.set()
        srv.should_exit = True
        thread.join(5)
        observability.tracing_context = original_tracing
        for k, v in saved.items():
            setattr(state, k, v)
        active_turns._active.clear()


def _wait_for(predicate, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def _hang_up_after_first_frame(url: str, body: dict[str, Any], path: str = "/chat") -> None:
    with httpx.Client(timeout=10) as client, client.stream("POST", url + path, json=body) as response:
        assert response.status_code == 200, response.read()
        for _ in response.iter_raw():
            break


def _turn_state(url: str) -> dict[str, Any]:
    return httpx.get(f"{url}/threads/{THREAD}/turn", timeout=5).json()


def test_a_detached_turn_survives_the_client_hanging_up(live) -> None:
    url, graph = live
    _hang_up_after_first_frame(url, {"message": "go", "thread_id": THREAD, "detached": True})
    time.sleep(0.2)
    assert "cancelled" not in graph.events
    assert _turn_state(url)["status"] == "running"

    graph.release.set()
    assert _wait_for(lambda: _turn_state(url)["status"] == "idle")
    assert graph.events == ["start", "finished"]
    assert _turn_state(url)["last"]["outcome"] == "completed"


def test_an_ordinary_turn_is_still_cancelled_when_the_client_hangs_up(live) -> None:
    """The dashboard's behavior must not change."""
    url, graph = live
    _hang_up_after_first_frame(url, {"message": "go", "thread_id": THREAD})
    assert _wait_for(lambda: "cancelled" in graph.events)
    assert _turn_state(url)["last"] is None  # only detached turns leave an outcome record


def test_a_second_detached_turn_on_a_running_thread_is_refused(live) -> None:
    url, _graph = live
    _hang_up_after_first_frame(url, {"message": "one", "thread_id": THREAD, "detached": True})
    again = httpx.post(f"{url}/chat", json={"message": "two", "thread_id": THREAD, "detached": True}, timeout=5)
    assert again.status_code == 409
    assert "already running" in again.json()["detail"]


def test_a_dashboard_turn_blocks_a_detached_one_too(live) -> None:
    url, _graph = live
    with httpx.Client(timeout=10) as client, client.stream(
        "POST", f"{url}/chat", json={"message": "one", "thread_id": THREAD}
    ) as response:
        # Hold the iterator: abandoning a `for … break` closes the connection,
        # which would cancel this very turn before the second request arrives.
        chunks = response.iter_raw()
        next(chunks)
        refused = httpx.post(f"{url}/chat", json={"message": "two", "thread_id": THREAD, "detached": True}, timeout=5)
        assert refused.status_code == 409


def test_stop_cancels_a_detached_turn(live) -> None:
    url, graph = live
    _hang_up_after_first_frame(url, {"message": "go", "thread_id": THREAD, "detached": True})
    stopped = httpx.post(f"{url}/chat/stop", json={"thread_id": THREAD}, timeout=5)
    assert stopped.json() == {"stopped": True}
    assert _wait_for(lambda: "cancelled" in graph.events)
    assert _wait_for(lambda: (_turn_state(url)["last"] or {}).get("outcome") == "cancelled")
    assert _turn_state(url)["status"] == "idle"


def test_the_turn_is_registered_as_the_app_channel(live) -> None:
    url, _graph = live
    _hang_up_after_first_frame(url, {"message": "go", "thread_id": THREAD, "detached": True})
    activity = _turn_state(url)["activity"]
    assert activity is not None and activity["channel"] == "app"


def test_a_pending_gate_is_reported_verbatim_after_the_client_left(live) -> None:
    url, graph = live
    gate = {"action": "send_email", "to": "a@b.c", "body": "Hello — exactly this text", "voice_approvable": False}
    graph.pending = gate
    graph.release.set()
    _hang_up_after_first_frame(url, {"message": "email them", "thread_id": THREAD, "detached": True})
    assert _wait_for(lambda: _turn_state(url)["status"] == "waiting_for_approval")
    assert _turn_state(url)["gate"] == gate


def test_resume_can_be_detached_too(live) -> None:
    url, graph = live
    graph.pending = {"action": "send_email"}
    graph.release.set()
    _hang_up_after_first_frame(url, {"message": "x", "thread_id": THREAD, "detached": True})
    assert _wait_for(lambda: _turn_state(url)["status"] == "waiting_for_approval")

    graph.pending = None
    graph.release.clear()
    _hang_up_after_first_frame(url, {"approved": True, "thread_id": THREAD, "detached": True}, "/resume")
    assert _wait_for(lambda: _turn_state(url)["status"] == "running")
    graph.release.set()
    assert _wait_for(lambda: _turn_state(url)["status"] == "idle")
    assert _turn_state(url)["last"]["outcome"] == "completed"


def test_an_a2ui_action_can_be_detached_too(live) -> None:
    url, graph = live
    body = {"surface_id": "s1", "name": "submit", "context": {}, "thread_id": THREAD, "detached": True}
    _hang_up_after_first_frame(url, body, "/a2ui/action")
    time.sleep(0.2)
    assert "cancelled" not in graph.events and _turn_state(url)["status"] == "running"


def test_the_state_of_an_unknown_thread_is_a_404(live) -> None:
    url, _graph = live
    assert httpx.get(f"{url}/threads/no-such-thread/turn", timeout=5).status_code == 404


def test_an_idle_thread_reports_idle(live) -> None:
    url, _graph = live
    body = _turn_state(url)
    assert body == {"status": "idle", "gate": None, "activity": None, "last": None}


def test_history_reads_an_explicit_thread_without_moving_the_active_pointer(live) -> None:
    url, _graph = live
    before = asyncio.run(thread_store.get_active_thread_id(db_path=thread_store.DEFAULT_DB_PATH))
    body = httpx.get(f"{url}/history", params={"thread_id": THREAD}, timeout=5).json()
    assert body["thread_id"] == THREAD
    assert [m["content"] for m in body["messages"]] == ["hi there"]
    after = asyncio.run(thread_store.get_active_thread_id(db_path=thread_store.DEFAULT_DB_PATH))
    assert after == before


def test_history_for_an_unknown_thread_is_a_404(live) -> None:
    url, _graph = live
    assert httpx.get(f"{url}/history", params={"thread_id": "no-such-thread"}, timeout=5).status_code == 404
