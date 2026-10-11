"""Records what every agent does into `trace_store` — the write side of the
History panel (STEPS.md 158): every tool call, and, inside a delegation, every
model turn of the specialist.

**Why a middleware:** LangChain 1.x `AgentMiddleware.awrap_tool_call` hands
one hook the tool call (name, args, id) and its result, for EVERY tool the
agent owns, whatever the tool is — including the `Command`-returning ones
(`render_ui`, the confirmation tools) a plain tool wrapper would have to
special-case one by one; `awrap_model_call` does the same for the model's
replies. It is the one place a specialist's work can be seen from:
`supervisor.py`'s `_invoke_agent_graph` throws that specialist's message list
away, so nothing downstream could recover it. Verified against the installed
langchain (an offline spike with a scripted model, nested supervisor ->
specialist graphs and a real `interrupt()`) before this was written.

**Which thread, which parent** — `TRACE_CONTEXT`, a ContextVar:

- The supervisor's own calls: no context is set; the thread comes from
  `get_config()["configurable"]["thread_id"]` and the call has no parent.
- A specialist's inner work: `supervisor._run_delegation` sets
  `(thread_id, <the delegation's tool_call_id>)` around the specialist's whole
  run, so each inner call is recorded as a child of the delegation that
  spawned it. A ContextVar crosses the specialist's nested `ainvoke()` (it
  runs in tasks copied from this one) — the spike confirmed it — and it is
  explicit about the parent, which `get_config()` can never be.

No thread id anywhere (a bare `ainvoke()` with no thread, e.g. the
automation-fire path or the HTTP research service) means nothing is
recorded: a row with no thread can't be shown anywhere.

**Tool calls** are recorded wherever a thread is found: arguments, result
text, status, timing, and `extras` — the result ToolMessage's
`additional_kwargs` (an A2UI surface, a phone action, an approval marker...)
with any image bytes replaced by a size marker. Nothing a call carries is
dropped.

**Model turns** are recorded ONLY inside a delegation (`TRACE_CONTEXT` set).
The supervisor's own turns are already in the checkpoint, with their text and
thinking; recording them here as well would show each one twice. A
specialist's, though, are gone the moment its `ainvoke()` returns — what it
said and thought between its tool calls, how many tokens it used. A turn that
is only a tool call (no text, no thinking) adds nothing its tool row doesn't
already show, so it is skipped.

**Interrupts are not failures.** A confirmation gate raises `GraphBubbleUp`
through the call; the tool row is recorded as 'interrupted' and the exception
is re-raised untouched (a model turn records nothing for one). On `/resume`
LangGraph re-enters the gated call (the specialist resumes from its own
checkpoint, so only the interrupted call — not the specialist's earlier ones
— passes through here again) and a second row, status 'ok', is recorded under
the same `tool_call_id`. `history_trace.py` shows the latest row for a given
call.

**Best-effort, like `activity_log`:** a store failure is logged and ignored.
Recording must never change what a tool call or a model call does or returns.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any, NamedTuple

from langchain.agents.middleware.types import (
    AgentMiddleware,
    ExtendedModelResponse,
    ModelCallResult,
    ModelRequest,
    ModelResponse,
    ToolCallRequest,
)
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.config import get_config
from langgraph.errors import GraphBubbleUp
from langgraph.types import Command

from assistant import trace_store
from assistant.trace_content import ai_text_and_thinking, render_text, strip_blobs

logger = logging.getLogger(__name__)

# (thread_id, parent_tool_call_id) while a delegated specialist is running;
# None everywhere else. Set and reset by supervisor.py's `_run_delegation`.
TRACE_CONTEXT: ContextVar[tuple[str, str] | None] = ContextVar("trace_context", default=None)

# usage_metadata's `input_token_details` keys that hold tokens written to the
# prompt cache: langchain-anthropic reports the generic count, or — when
# Anthropic splits it by cache lifetime — zero there plus these two (never
# both, so summing them can't double count).
_CACHE_CREATION_KEYS = ("cache_creation", "ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens")


def _current_context() -> tuple[str, str | None] | None:
    """(thread_id, parent_tool_call_id) for the call about to run, or None
    when there is no thread to record it under."""
    context = TRACE_CONTEXT.get()
    if context is not None:
        return context
    try:
        thread_id = get_config()["configurable"]["thread_id"]
    except Exception:  # no runnable context, or no thread in it: nothing to record under
        return None
    return (str(thread_id), None) if thread_id else None


def _dump_json(value: object) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)


class _Timer:
    """Starts when created; `stop()` freezes the end. Stopped the moment the
    call returns, so work done afterwards (rendering its output, say) isn't
    counted as part of the call."""

    def __init__(self) -> None:
        self.started_at = trace_store.now_iso()
        self._started = time.monotonic()
        self.ended_at = self.started_at
        self.duration_ms = 0

    def stop(self) -> None:
        self.ended_at = trace_store.now_iso()
        self.duration_ms = round((time.monotonic() - self._started) * 1000)


# --- tool results ---------------------------------------------------------------


def _tool_messages(result: object) -> list[ToolMessage]:
    """The ToolMessage(s) a call's result carries: the result itself, or —
    for a `Command` — the ones inside its `update["messages"]` (a dict, or a
    list of (key, value) pairs, per LangGraph)."""
    if isinstance(result, ToolMessage):
        return [result]
    if isinstance(result, list):
        return [m for item in result for m in _tool_messages(item)]
    if not isinstance(result, Command):
        return []
    update = result.update
    candidates: list[Any] = []
    if isinstance(update, dict):
        candidates.append(update.get("messages"))
    elif isinstance(update, list | tuple):
        candidates.extend(
            pair[1]
            for pair in update
            if isinstance(pair, tuple) and len(pair) == 2 and pair[0] == "messages"
        )
    messages: list[ToolMessage] = []
    for item in candidates:
        for message in item if isinstance(item, list) else [item]:
            if isinstance(message, ToolMessage):
                messages.append(message)
    return messages


def _merged_extras(messages: list[ToolMessage]) -> dict[str, Any]:
    """The `additional_kwargs` of every ToolMessage a result carries, merged.
    Where two messages carry the same key and both values are lists (two A2UI
    surfaces, two phone actions) they are joined rather than the later one
    winning — nothing a call attached is dropped."""
    merged: dict[str, Any] = {}
    for message in messages:
        for key, value in (message.additional_kwargs or {}).items():
            existing = merged.get(key)
            if isinstance(existing, list) and isinstance(value, list):
                merged[key] = [*existing, *value]
            else:
                merged[key] = value
    return merged


class _Outcome(NamedTuple):
    """What a call that returned produced: its output text (None when its
    result carried no ToolMessage), status, and `extras` as JSON text (None
    when there were none)."""

    output: str | None
    status: str
    extras: str | None


def _describe_result(result: object) -> _Outcome:
    """Status is 'error' when the framework marked a ToolMessage so
    (`status="error"`: a validation failure or a handled ToolException) — a
    structural signal, not a guess from the text. Extras have their image
    bytes (base64 fields, long data: URIs) replaced by size markers before
    they are stored: an A2UI surface carries its pictures that way, and one
    picture would otherwise swamp the row."""
    messages = _tool_messages(result)
    if not messages:
        return _Outcome(None, trace_store.STATUS_OK, None)
    output = "\n".join(render_text(m.content) for m in messages)
    failed = any(m.status == "error" for m in messages)
    extras = _merged_extras(messages)
    return _Outcome(
        output,
        trace_store.STATUS_ERROR if failed else trace_store.STATUS_OK,
        _dump_json(strip_blobs(extras)) if extras else None,
    )


# --- model replies --------------------------------------------------------------


def _ai_messages(response: object) -> list[AIMessage]:
    """The AIMessage(s) in what a model call returned. The hook is handed a
    `ModelResponse` (its `.result` list) when it sits innermost, as it does
    here, but the middleware contract also allows a bare `AIMessage` or an
    `ExtendedModelResponse` wrapping a `ModelResponse`, and the hook shouldn't
    break if the list order ever changes."""
    if isinstance(response, ExtendedModelResponse):
        response = response.model_response
    if isinstance(response, AIMessage):
        return [response]
    return [m for m in getattr(response, "result", None) or [] if isinstance(m, AIMessage)]


def _model_name(message: AIMessage) -> str:
    metadata = message.response_metadata or {}
    name = metadata.get("model_name") or metadata.get("model")
    return name if isinstance(name, str) and name else "model"


def _usage(message: AIMessage) -> dict[str, int]:
    """`{input_tokens, output_tokens, cache_read_tokens?,
    cache_creation_tokens?}` from the message's usage_metadata, with anything
    absent left out. `input_tokens` is langchain's own figure: the whole prompt,
    cached tokens included."""
    metadata = message.usage_metadata
    if not metadata:
        return {}
    details = metadata.get("input_token_details") or {}
    creation = [details.get(key) for key in _CACHE_CREATION_KEYS]
    counted = [n for n in creation if isinstance(n, int)]
    usage = {
        "input_tokens": metadata.get("input_tokens"),
        "output_tokens": metadata.get("output_tokens"),
        "cache_read_tokens": details.get("cache_read"),
        "cache_creation_tokens": sum(counted) if counted else None,
    }
    return {key: value for key, value in usage.items() if value is not None}


def _model_extras(message: AIMessage) -> str | None:
    """JSON text of `{usage, stop_reason}` for a model turn (None values
    dropped), or None when the message reported neither."""
    extras: dict[str, Any] = {}
    usage = _usage(message)
    if usage:
        extras["usage"] = usage
    stop_reason = (message.response_metadata or {}).get("stop_reason")
    if stop_reason is not None:
        extras["stop_reason"] = stop_reason
    return _dump_json(extras) if extras else None


class ToolTraceMiddleware(AgentMiddleware):
    """Records the work of ONE agent (see the module docstring).
    `agent_name` is what a row's `agent` column says — "supervisor", or the
    specialist's name — so the History panel can badge each step with who took
    it. **Any new `create_agent(...)` in supervisor.py/sub_agents.py must
    include one**, same standing as the caching and circuit-breaker
    middleware: an agent without it does work the History panel never sees."""

    def __init__(self, agent_name: str) -> None:
        self.agent_name = agent_name

    async def _write(
        self,
        context: tuple[str, str | None],
        tool_call_id: str,
        name: str,
        timer: _Timer,
        *,
        kind: str = trace_store.KIND_TOOL,
        input: str = "",
        output: str | None = None,
        thinking: str | None = None,
        extras: str | None = None,
        status: str = trace_store.STATUS_OK,
        error: str | None = None,
    ) -> None:
        """One row, best-effort: a store failure is logged, never raised."""
        thread_id, parent_tool_call_id = context
        try:
            await trace_store.record_call(
                thread_id,
                tool_call_id,
                self.agent_name,
                name,
                parent_tool_call_id=parent_tool_call_id,
                kind=kind,
                input=input,
                output=output,
                thinking=thinking,
                extras=extras,
                status=status,
                error=error,
                started_at=timer.started_at,
                ended_at=timer.ended_at,
                duration_ms=timer.duration_ms,
            )
        except Exception:
            logger.warning("tool trace: could not record %s", name, exc_info=True)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        context = _current_context()
        if context is None:
            return await handler(request)

        call = request.tool_call
        tool_call_id = call.get("id") or ""
        name = call["name"]
        args = _dump_json(call.get("args"))
        timer = _Timer()

        try:
            result = await handler(request)
        except GraphBubbleUp:
            # An interrupt() — a confirmation gate pausing this call — is
            # control flow, not a failure.
            timer.stop()
            await self._write(
                context,
                tool_call_id,
                name,
                timer,
                input=args,
                status=trace_store.STATUS_INTERRUPTED,
            )
            raise
        except asyncio.CancelledError:
            # The user hit stop mid-call. Not an Exception subclass, so it
            # needs its own clause; without it the call would just vanish.
            timer.stop()
            await self._write(
                context,
                tool_call_id,
                name,
                timer,
                input=args,
                status=trace_store.STATUS_ERROR,
                error="cancelled",
            )
            raise
        except Exception as exc:
            timer.stop()
            await self._write(
                context,
                tool_call_id,
                name,
                timer,
                input=args,
                status=trace_store.STATUS_ERROR,
                error=f"{type(exc).__name__}: {exc}",
            )
            raise

        timer.stop()
        try:
            outcome = _describe_result(result)
        except Exception:  # recording must never change what a call returns
            logger.warning("tool trace: could not read the result of %s", name, exc_info=True)
            outcome = _Outcome(None, trace_store.STATUS_OK, None)
        await self._write(
            context,
            tool_call_id,
            name,
            timer,
            input=args,
            output=outcome.output,
            extras=outcome.extras,
            status=outcome.status,
        )
        return result

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        # Only inside a delegation (see the module docstring): outside one the
        # turn is the supervisor's, already in the checkpoint, or there is no
        # thread to record under at all.
        context = TRACE_CONTEXT.get()
        if context is None:
            return await handler(request)

        timer = _Timer()

        async def write_failure(error: str) -> None:
            timer.stop()
            await self._write(
                context,
                str(uuid.uuid4()),
                "model",
                timer,
                kind=trace_store.KIND_ASSISTANT,
                status=trace_store.STATUS_ERROR,
                error=error,
            )

        try:
            response = await handler(request)
        except GraphBubbleUp:
            raise  # control flow: nothing was said
        except asyncio.CancelledError:
            await write_failure("cancelled")
            raise
        except Exception as exc:
            await write_failure(f"{type(exc).__name__}: {exc}")
            raise

        timer.stop()
        try:
            for message in _ai_messages(response):
                text, thinking = ai_text_and_thinking(message.content)
                if not (text.strip() or thinking):
                    continue  # a bare tool-use turn: its tool rows already say everything
                await self._write(
                    context,
                    message.id or str(uuid.uuid4()),
                    _model_name(message),
                    timer,
                    kind=trace_store.KIND_ASSISTANT,
                    output=text,
                    thinking=thinking,
                    extras=_model_extras(message),
                )
        except Exception:  # recording must never change what a model call returns
            logger.warning("tool trace: could not record a model turn", exc_info=True)
        return response
