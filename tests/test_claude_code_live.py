"""Tests for assistant.claude_code_live — the in-memory registry backing
live visibility + a kill switch for run_claude_code sessions (STEPS.md 149).
Uses a fake process object (not a real subprocess) — no real `claude` CLI
invocation, no API cost, matching this project's usual "fast offline unit
coverage for pure logic" convention.
"""

import asyncio

import pytest

import assistant.claude_code_live as claude_code_live


class _FakeProcess:
    def __init__(self, *, exits_after: float | None = None) -> None:
        self.terminated = False
        self.killed = False
        self._exits_after = exits_after
        self._done = asyncio.Event()
        if exits_after == 0:
            self._done.set()

    def terminate(self) -> None:
        self.terminated = True
        if self._exits_after == 0:
            self._done.set()

    def kill(self) -> None:
        self.killed = True
        self._done.set()

    async def wait(self) -> int:
        if self._exits_after is None:
            # Never exits on its own — only stop()'s kill() escalation sets it.
            await self._done.wait()
        else:
            await asyncio.sleep(self._exits_after)
            self._done.set()
        return 0


@pytest.fixture(autouse=True)
def _clean_registry():
    # The registry is module-level global state — reset around every test
    # so tests can't leak into each other.
    claude_code_live._live.clear()
    yield
    claude_code_live._live.clear()


def test_register_and_list_live() -> None:
    proc = _FakeProcess(exits_after=0)
    claude_code_live.register("s1", proc, "a real long prompt " * 20)
    live = claude_code_live.list_live()
    assert len(live) == 1
    assert live[0]["session_id"] == "s1"
    assert len(live[0]["prompt_preview"]) <= 200
    assert claude_code_live.is_live("s1") is True


def test_unregister_removes_from_registry() -> None:
    proc = _FakeProcess(exits_after=0)
    claude_code_live.register("s1", proc, "prompt")
    claude_code_live.unregister("s1")
    assert claude_code_live.list_live() == []
    assert claude_code_live.is_live("s1") is False


def test_unregister_unknown_session_is_a_safe_no_op() -> None:
    claude_code_live.unregister("does-not-exist")  # must not raise


def test_is_live_false_for_unknown_session() -> None:
    assert claude_code_live.is_live("nope") is False


async def test_stop_terminates_a_process_that_exits_cleanly() -> None:
    proc = _FakeProcess(exits_after=0)
    claude_code_live.register("s1", proc, "prompt")
    stopped = await claude_code_live.stop("s1")
    assert stopped is True
    assert proc.terminated is True
    assert proc.killed is False  # exited cleanly, no need to escalate


async def test_stop_escalates_to_kill_if_terminate_does_not_exit_in_time(monkeypatch) -> None:
    monkeypatch.setattr(claude_code_live.asyncio, "wait_for", _raise_timeout)
    proc = _FakeProcess(exits_after=None)
    claude_code_live.register("s1", proc, "prompt")
    stopped = await claude_code_live.stop("s1")
    assert stopped is True
    assert proc.terminated is True
    assert proc.killed is True


async def _raise_timeout(coro, *_args, **_kwargs):
    coro.close()  # avoid a "coroutine was never awaited" warning from the mock itself
    raise TimeoutError


async def test_stop_returns_false_for_unknown_session() -> None:
    assert await claude_code_live.stop("does-not-exist") is False
