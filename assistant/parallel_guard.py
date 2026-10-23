"""Lets the supervisor run read-only tool calls in parallel, and nothing else (docs/SPEED_PLAN.md R2).

**Why parallel at all.** A chain like `search_vault`, then `read_vault_note` x N, paid one full model
round trip per read (about 2.6 s of first-token wait plus decode, each re-reading a 15 to 60k-token
context). Anthropic can return several `tool_use` blocks in one response and LangGraph's ToolNode
runs them concurrently, so independent reads can share one round trip.

**Why it was off.** `NoParallelSpecialistCalls` (the class this replaces) set
`parallel_tool_calls=False` because server.py's SSE and `/resume` handling relay only the FIRST pending
`interrupt()` of a turn: two gated specialist calls in one response could strand the second one's
confirmation with no way to approve or decline it. That reason is unchanged, so the guard keeps the
structural cap instead of trusting the prompt.

**How it stays safe.** The model may now emit several calls; this middleware then cuts the response down
before anything executes. The leading run of calls to allowlisted pure reads is kept (all of them run
concurrently); if the first call is anything else (every delegation, every confirmation gate, every vault
write, anything that can `interrupt()` or has a side effect), only that one call is kept. Dropped calls
have their `tool_use` content blocks removed too, so the stored AIMessage is consistent with what
actually ran and the model simply issues the rest on its next turn, seeing the results it got. An
allowlist, not a blacklist: a new tool is serial until someone decides it is a pure read.

`research_agent` is deliberately not on the allowlist: it is a delegation, and the supervisor's prompt
chains it with other steps.
"""

from __future__ import annotations

import copy
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import AIMessage

# Pure local reads: no side effect, no confirmation gate, nothing that can interrupt.
PARALLEL_SAFE_TOOLS = frozenset({"search_vault", "read_vault_note", "stage_status", "backstage_look"})


def _call_id(call: Any) -> str | None:
    return call.get("id") if isinstance(call, dict) else getattr(call, "id", None)


def _call_name(call: Any) -> str | None:
    return call.get("name") if isinstance(call, dict) else getattr(call, "name", None)


def calls_to_keep(names: list[str | None]) -> int:
    """How many of the leading calls may run: the whole leading run of allowlisted reads, else just one."""
    if not names:
        return 0
    if names[0] not in PARALLEL_SAFE_TOOLS:
        return 1
    n = 0
    for name in names:
        if name not in PARALLEL_SAFE_TOOLS:
            break
        n += 1
    return n


def trim_message(message: AIMessage) -> AIMessage:
    """`message` with its tool calls cut to what `calls_to_keep` allows; unchanged if nothing is cut."""
    calls = list(message.tool_calls or [])
    keep = calls_to_keep([_call_name(c) for c in calls])
    if keep >= len(calls):
        return message
    kept_ids = {_call_id(c) for c in calls[:keep]}
    trimmed = copy.copy(message)
    trimmed.tool_calls = calls[:keep]
    if isinstance(message.content, list):
        trimmed.content = [
            block
            for block in message.content
            if not (isinstance(block, dict) and block.get("type") == "tool_use" and block.get("id") not in kept_ids)
        ]
    return trimmed


class GuardedParallelReads(AgentMiddleware):
    """Allow parallel tool calls from the model, then keep only the safe ones (see module docstring)."""

    async def awrap_model_call(self, request, handler):  # noqa: ANN001, ANN201
        request.model_settings["parallel_tool_calls"] = True
        response = await handler(request)
        if isinstance(response, AIMessage):
            return trim_message(response)
        result = getattr(response, "result", None)
        if result:
            response.result = [trim_message(m) if isinstance(m, AIMessage) else m for m in result]
        return response
