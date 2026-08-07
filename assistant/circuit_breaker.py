"""Stops an agent from retrying the same failing tool call forever.

**The incident this fixes, live-diagnosed via Langfuse (STEPS.md 121-122),
not theoretical:** a real user turn asked for a step-by-step guide "with a
picture for the trickiest part." The supervisor tried to build that surface
itself via `render_ui` — despite having no way to produce real image bytes
(`render_local_media`/`render_web_media` only exist on `research_agent`/
`mac_control_agent`/`coding_agent`, not the supervisor; see supervisor.py's
system prompt fix in the same commit) — ran its 4096-token output budget dry
mid-generation, and got back `Error invoking tool 'render_ui' with kwargs {}
with error: surface: Field required. Please fix the error and try again.`
Nothing told it to stop. It retried the IDENTICAL failing call 43 times in a
row, burning ~28 minutes of real model latency and real API spend on a
request that could never succeed that way. The supervisor prompt fix
addresses the ROOT CAUSE (stop attempting media itself); this middleware is
the independent safety net for the whole CLASS of bug — any tool, any
reason it keeps failing identically, not just this one trigger.

**Mechanism:** `RepeatedToolFailureCircuitBreaker.awrap_model_call` runs
before every model call and scans the trailing message history for a streak
of (AIMessage with exactly one tool_call, ToolMessage with `status="error"`
for that same tool) pairs. Once the streak reaches `max_consecutive_failures`
for the SAME tool name, it returns a synthetic `AIMessage` explaining what
happened INSTEAD of calling the model again — no further API call is made
for that doomed attempt, so this also caps runaway cost, not just runaway
time. A streak broken by a different tool, a successful call, or plain text
resets the count back to zero — this only fires on genuine, unbroken
repetition.

**Why `status="error"`, not string-matching the error text:**
`langchain_core`'s own tool-execution path
(`langchain_core/tools/base.py`'s `_run`) sets `ToolMessage.status="error"`
whenever a tool call fails validation or raises a handled `ToolException` —
a structural signal already provided by the framework, not something this
project invented. Matching on `status` instead of grepping the content
string (which varies per tool/error type) is both more robust and immune to
a future error-message wording change silently breaking detection.

**Also updates `active_turns.py`'s live registry** (best-effort — see that
module's docstring for exactly which scope this covers and why) so the
dashboard's active-turn indicator can show "retrying X (attempt N)" WHILE
it's still happening, not just after the fact. This is the same standing
ask behind that module: the user should never again be surprised by a
process that had been silently running — retrying or otherwise — without
any visible signal.

**Scope:** added to all 6 `create_agent(...)` middleware lists (supervisor +
5 sub-agents), same standing as `ThinkingBlockRepairMiddleware`/
`AnthropicPromptCachingMiddleware` above it in CLAUDE.md's load-bearing
decisions — any new agent construction should include this too, since a
retry-storm is a generic failure mode of the ReAct tool-calling loop itself,
not specific to any one agent's tools.
"""

from __future__ import annotations

from langchain.agents.middleware.types import AgentMiddleware, ModelCallResult, ModelRequest
from langchain_core.messages import AIMessage, AnyMessage, ToolMessage
from langgraph.config import get_config

from assistant import active_turns

DEFAULT_MAX_CONSECUTIVE_FAILURES = 3


def _trailing_failure_streak(messages: list[AnyMessage]) -> tuple[str | None, int]:
    """Scans backward from the end of `messages` for a run of
    (single-tool-call AIMessage, error ToolMessage) pairs all naming the SAME
    tool. Returns (tool_name, streak_length) — (None, 0) if the trailing
    messages don't form such a streak at all (including: streak broken by a
    different tool, a successful result, or a non-tool-call/non-tool message
    at the boundary)."""
    streak_tool: str | None = None
    streak = 0
    i = len(messages) - 1
    while i >= 1:
        result_msg = messages[i]
        call_msg = messages[i - 1]
        if not (isinstance(result_msg, ToolMessage) and isinstance(call_msg, AIMessage)):
            break
        tool_calls = call_msg.tool_calls or []
        if len(tool_calls) != 1:
            # Parallel or zero tool calls at this step — not the single-tool
            # retry-loop shape this breaker targets; stop scanning rather
            # than guess which call the result belongs to.
            break
        name = tool_calls[0].get("name")
        if result_msg.status != "error":
            break
        if streak_tool is not None and name != streak_tool:
            break
        streak_tool = name
        streak += 1
        i -= 2
    return streak_tool, streak


def _touch_active_turn(tool: str | None, streak: int) -> None:
    """Best-effort registry update — see active_turns.py's module docstring
    for why this silently no-ops when thread_id isn't in scope (a nested
    specialist's own isolated ainvoke() has none) rather than raising."""
    try:
        config = get_config()
        thread_id = config["configurable"]["thread_id"]
    except (RuntimeError, LookupError, KeyError, TypeError):
        # RuntimeError: no runnable context at all (e.g. this unit test, or
        # a specialist's own isolated ainvoke() — see module docstring).
        # The rest: configurable/thread_id missing from an otherwise-real
        # config. Either way, this is a best-effort monitoring update, never
        # something the actual agent loop should fail over.
        return
    active_turns.touch(thread_id, tool=tool, consecutive_failures=streak)


class RepeatedToolFailureCircuitBreaker(AgentMiddleware):
    """Stops a tool-calling loop that's retrying the identical failing call
    (see module docstring). NOT a general error handler — a normal single
    failure, or a failure followed by a genuinely different next attempt,
    passes through untouched; this only intervenes once the SAME tool has
    failed `max_consecutive_failures` times in an unbroken row."""

    def __init__(self, max_consecutive_failures: int = DEFAULT_MAX_CONSECUTIVE_FAILURES) -> None:
        self._max = max_consecutive_failures

    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:  # noqa: ANN001
        tool_name, streak = _trailing_failure_streak(request.messages)
        _touch_active_turn(tool_name, streak)

        if tool_name is not None and streak >= self._max:
            return AIMessage(
                content=(
                    f"I tried calling '{tool_name}' {streak} times in a row and it kept "
                    "failing the same way, so I'm stopping instead of continuing to retry. "
                    "Let me know if you'd like me to try a different approach, or tell me "
                    "more about what you're looking for."
                )
            )

        return await handler(request)
