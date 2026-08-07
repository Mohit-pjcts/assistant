"""Tests for assistant.circuit_breaker — RepeatedToolFailureCircuitBreaker,
built after a real, live-diagnosed incident (STEPS.md 121-122): a single
turn retried a failing `render_ui` call 43 times in a row over ~28 minutes.
No live API call needed here (this is pure structural logic over
constructed message histories, same convention as test_thinking_repair.py)
— the real incident is the live reproduction; these confirm the fix's own
detection/short-circuit logic behaves exactly as designed.
"""

import asyncio

from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from assistant.circuit_breaker import RepeatedToolFailureCircuitBreaker, _trailing_failure_streak


def _call(tool: str, call_id: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": tool, "args": {}, "id": call_id}])


def _error(call_id: str) -> ToolMessage:
    return ToolMessage(content="Error: field required", tool_call_id=call_id, status="error")


def _ok(call_id: str) -> ToolMessage:
    return ToolMessage(content="ok", tool_call_id=call_id, status="success")


def test_trailing_failure_streak_counts_consecutive_identical_tool_failures() -> None:
    """The exact shape from the real incident: the same tool failing the
    same way, back to back."""
    messages = [HumanMessage("hi")]
    for i in range(3):
        messages.append(_call("render_ui", f"a{i}"))
        messages.append(_error(f"a{i}"))
    assert _trailing_failure_streak(messages) == ("render_ui", 3)


def test_trailing_failure_streak_resets_on_success() -> None:
    """A successful call breaks the streak — this must not fire on a tool
    that failed twice and then recovered."""
    messages = [HumanMessage("hi")]
    for i in range(2):
        messages.append(_call("render_ui", f"a{i}"))
        messages.append(_error(f"a{i}"))
    messages.append(_call("render_ui", "b0"))
    messages.append(_ok("b0"))
    assert _trailing_failure_streak(messages) == (None, 0)


def test_trailing_failure_streak_resets_on_different_tool() -> None:
    """Failing at two DIFFERENT tools in a row is not the retry-loop shape
    this breaker targets — only counts the streak of the most recent tool."""
    messages = [
        HumanMessage("hi"),
        _call("render_ui", "a0"),
        _error("a0"),
        _call("web_search", "a1"),
        _error("a1"),
    ]
    assert _trailing_failure_streak(messages) == ("web_search", 1)


def test_trailing_failure_streak_is_zero_for_plain_text() -> None:
    messages = [HumanMessage("hi"), AIMessage(content="just text")]
    assert _trailing_failure_streak(messages) == (None, 0)


def test_middleware_short_circuits_without_calling_model_once_threshold_hit() -> None:
    """The actual fix: once the same tool has failed 3 times in a row, the
    middleware must return a synthetic reply and NEVER invoke the model
    again for that doomed attempt — this is what caps both the wasted time
    and the wasted API spend from the real incident."""
    breaker = RepeatedToolFailureCircuitBreaker(max_consecutive_failures=3)
    messages = [HumanMessage("hi")]
    for i in range(3):
        messages.append(_call("render_ui", f"a{i}"))
        messages.append(_error(f"a{i}"))
    request = ModelRequest(model=None, messages=messages, tools=[])

    async def handler_must_not_be_called(_req):
        raise AssertionError("handler was called — circuit breaker failed to short-circuit")

    result = asyncio.run(breaker.awrap_model_call(request, handler_must_not_be_called))

    assert isinstance(result, AIMessage)
    assert "render_ui" in result.content
    assert "3 times" in result.content


def test_middleware_calls_model_normally_below_threshold() -> None:
    """Two failures (below the default threshold of 3) must still reach the
    model — this only intervenes once the streak is genuinely unproductive,
    not on a normal single retry."""
    breaker = RepeatedToolFailureCircuitBreaker(max_consecutive_failures=3)
    messages = [HumanMessage("hi")]
    for i in range(2):
        messages.append(_call("render_ui", f"a{i}"))
        messages.append(_error(f"a{i}"))
    request = ModelRequest(model=None, messages=messages, tools=[])

    async def handler_normal(_req):
        return AIMessage(content="normal response")

    result = asyncio.run(breaker.awrap_model_call(request, handler_normal))
    assert result.content == "normal response"


if __name__ == "__main__":
    test_trailing_failure_streak_counts_consecutive_identical_tool_failures()
    print("OK: test_trailing_failure_streak_counts_consecutive_identical_tool_failures")
    test_trailing_failure_streak_resets_on_success()
    print("OK: test_trailing_failure_streak_resets_on_success")
    test_trailing_failure_streak_resets_on_different_tool()
    print("OK: test_trailing_failure_streak_resets_on_different_tool")
    test_trailing_failure_streak_is_zero_for_plain_text()
    print("OK: test_trailing_failure_streak_is_zero_for_plain_text")
    test_middleware_short_circuits_without_calling_model_once_threshold_hit()
    print("OK: test_middleware_short_circuits_without_calling_model_once_threshold_hit")
    test_middleware_calls_model_normally_below_threshold()
    print("OK: test_middleware_calls_model_normally_below_threshold")
    print("\n6 tests passed")
