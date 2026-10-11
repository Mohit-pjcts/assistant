"""Builds the History panel's conversation view (STEPS.md 158): a thread's
checkpointed messages plus its `trace_store` rows, turned into turns of
events — what the user said, what the assistant said and thought, every tool
call with its full input and output, and under each delegation everything the
specialist itself did: its tool calls and what it said between them.

A PURE function over its two inputs, on purpose: no graph, no database, no
network, so it is unit-testable with hand-built messages and rows
(`tests/test_history_trace.py`). `server.py`'s `GET /history/trace` is the thin
glue that loads the two inputs and slices a page.

**Two sources, one view.** The checkpoint is the source of truth for the
supervisor's own calls (arguments from the AIMessage, output from the matching
ToolMessage) and for everything the conversation said. The trace rows add what
the checkpoint never had: timing, a call's real outcome, and a specialist's
work (`tool_trace.py` records it; `supervisor._invoke_agent_graph` throws it
away otherwise). A turn from before tracing existed simply has no rows — its
tool events come out with no timing and no children, which is expected, not a
bug.

**Mixed children.** A delegation's `children` is one list, in the order
things finished (`seq`): the specialist's tool calls (`kind: "tool"`, the same
shape as a top-level tool event) interleaved with its model turns
(`kind: "assistant"`: `id, agent, model, text, thinking, status, error,
started_at, ended_at, duration_ms, usage`) — what it said and reasoned between
the calls. Top-level assistant events stay `{kind, text, thinking}`: the
supervisor's turns come from the checkpoint, which has no timing or usage.

**A gated call has two rows.** A confirmation gate pauses a call, records it
'interrupted', and on `/resume` the call runs again and is recorded again under
the same `tool_call_id`. One call shown twice would read as two calls, so tool
rows sharing a (parent, tool_call_id) collapse into one event: the LATEST row's
status, output and timing, in the position the call first appeared. The earlier
'interrupted' row stays in the database; it is the same call. Model turns never
collapse: each one happened once.

**Surfaces and extras.** A tool event's `surfaces` are the A2UI card(s) its
ToolMessage carried (`render_ui`'s own, or a delegation forwarding what its
specialist rendered). They are filled on top-level events only, from the
checkpoint — a specialist's cards are already forwarded onto its delegation's
ToolMessage, so drawing them on its children too would read as two cards — and
a child's `surfaces` is always `[]`. `extras` is every OTHER `additional_kwargs`
key (a phone action, an approval marker): top-level from the checkpoint's
ToolMessage, a child's from the row's recorded extras, which keep every key
including any surface tree, as plain data.

**Turns.** Every genuine human message starts one (`compaction`'s helpers decide
what is genuine, same as everywhere else in the project). Anything before the
first genuine message — in practice a compaction summary at the front of the
history — forms a leading turn with `user: None`. Synthetic human messages (the
recalled-facts message, the compaction summary) become `context` events inside
the turn they sit in rather than being mistaken for something the user typed.

**Strings are never clipped here**, with one exception: a `data:` URI longer
than `trace_content.DATA_URI_MIN_CHARS` (an image embedded in a `render_ui`
call, say) is replaced by `<data URI: <mime>, <N> chars>`, so one picture can't
make the payload megabytes. It is applied to each field as the event is built,
not to the finished turn, because `surfaces` are exempt: the panel draws them as
the real card, and an elided image would render broken. (`trace_store` has its
own, much higher, cap.)
"""

from __future__ import annotations

import json
import re
from collections.abc import Collection, Iterable
from dataclasses import dataclass, field
from typing import Any, TypeGuard

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage

from assistant.a2ui import A2UI_SURFACE_KEY
from assistant.compaction import (
    is_compaction_summary,
    is_genuine_human_turn,
    is_recalled_facts_message,
)
from assistant.trace_content import ai_text_and_thinking, elide_data_uris, render_text
from assistant.trace_store import KIND_ASSISTANT, STATUS_ERROR, STATUS_INTERRUPTED, TraceRow

# Tools whose output names a Stage run ("Backstage run run-jev-... (finished,
# done): ..." — stage.py's `format_run`); the History panel links such a row to
# the run's own log.
STAGE_RUN_TOOLS = frozenset({"backstage", "stage_status"})
_STAGE_RUN_ID = re.compile(r"Backstage run (run-[\w-]+)")

# The token counts a model turn's `usage` may carry; input and output are
# always there, the cache ones only when the API reported them.
_USAGE_FIELDS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens")

# What a model row's `name` says when the reply carried no model name.
_UNKNOWN_MODEL = "model"


# --- turns ----------------------------------------------------------------


@dataclass
class _Turn:
    index: int
    user: HumanMessage | None
    rest: list[BaseMessage] = field(default_factory=list)


def _is_turn_start(message: BaseMessage) -> TypeGuard[HumanMessage]:
    """A genuine human message. The compaction summary is a HumanMessage that
    `is_genuine_human_turn` alone lets through (see `server._is_synthetic`),
    so it is excluded explicitly."""
    return (
        isinstance(message, HumanMessage)
        and is_genuine_human_turn(message)
        and not is_compaction_summary(message)
    )


def _context_label(message: BaseMessage) -> str:
    """What to call a message the graph put in the conversation itself."""
    if is_compaction_summary(message):
        return "conversation summary"
    if is_recalled_facts_message(message):
        return "recalled facts"
    if isinstance(message, SystemMessage):
        return "system"
    return "context"


def _split_turns(messages: list[BaseMessage]) -> list[_Turn]:
    turns: list[_Turn] = []
    current: _Turn | None = None
    for message in messages:
        if _is_turn_start(message):
            current = _Turn(index=len(turns), user=message)
            turns.append(current)
            continue
        if current is None:
            current = _Turn(index=len(turns), user=None)
            turns.append(current)
        current.rest.append(message)
    return turns


# --- trace rows -----------------------------------------------------------


@dataclass
class _Rows:
    """One thread's trace rows, indexed the two ways the builder looks them
    up. Tool rows collapse by tool_call_id (see the module docstring): the dict
    keeps a key's first position and its latest value. Model rows are keyed by
    their own row id, so they never collapse."""

    top: dict[str, TraceRow]  # supervisor-level call: tool_call_id -> row
    children: dict[str, list[TraceRow]]  # delegation's tool_call_id -> its rows, in seq order


def _index_rows(calls: Iterable[TraceRow]) -> _Rows:
    top: dict[str, TraceRow] = {}
    grouped: dict[str, dict[tuple[str, str], TraceRow]] = {}
    for call in sorted(calls, key=lambda c: c.seq):
        if call.parent_tool_call_id is None:
            top[call.tool_call_id] = call
        else:
            key = (call.kind, call.id if call.kind == KIND_ASSISTANT else call.tool_call_id)
            grouped.setdefault(call.parent_tool_call_id, {})[key] = call
    return _Rows(
        top=top, children={parent: list(group.values()) for parent, group in grouped.items()}
    )


# --- events ---------------------------------------------------------------


def _parse_input(text: str) -> Any:
    """A row's stored arguments back into an object. A value the store clipped
    (past its per-field cap) is no longer valid JSON; it comes back as the raw
    text instead of being dropped."""
    try:
        return json.loads(text)
    except ValueError:
        return text


def _parse_extras(text: str | None) -> dict[str, Any]:
    """A row's stored extras back into an object ({} when there are none). Like
    `_parse_input`, clipped JSON is kept as its raw text — under a key, since
    `extras` is always an object."""
    if not text:
        return {}
    try:
        value = json.loads(text)
    except ValueError:
        return {"_clipped": text}
    return value if isinstance(value, dict) else {"_value": value}


def _jsonable(value: Any) -> Any:
    """`value` as plain JSON data — anything JSON can't hold becomes its
    str() — so a message's `additional_kwargs` can never make the response
    unserialisable."""
    try:
        return json.loads(json.dumps(value, default=str))
    except (TypeError, ValueError):
        return {"_unreadable": str(value)}


def _surface_list(value: Any) -> list[Any]:
    """A ToolMessage's A2UI surfaces as a list, whatever shape it carried."""
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return [value]
    return []


def _usage_of(extras: dict[str, Any]) -> dict[str, int] | None:
    """A model row's token usage in the contract's shape, or None when it
    didn't record any. Only whole numbers pass; input and output are required."""
    usage = extras.get("usage")
    if not isinstance(usage, dict):
        return None
    shaped = {
        name: usage[name]
        for name in _USAGE_FIELDS
        if isinstance(usage.get(name), int) and not isinstance(usage[name], bool)
    }
    return shaped if "input_tokens" in shaped and "output_tokens" in shaped else None


def _event_status(row: TraceRow | None, tool_message: ToolMessage | None) -> str:
    """The row's own status when there is one — except 'interrupted' next to a
    ToolMessage, which can only mean the row of the call's later, finished
    attempt was never recorded: a result exists, so the call isn't paused."""
    if row is not None and not (row.status == STATUS_INTERRUPTED and tool_message is not None):
        return row.status
    if tool_message is None:
        return "pending"
    return STATUS_ERROR if tool_message.status == "error" else "ok"


def _stage_run_id(name: str, output: str | None) -> str | None:
    if name not in STAGE_RUN_TOOLS or not output:
        return None
    match = _STAGE_RUN_ID.search(output)
    return match.group(1) if match else None


def _model_event(row: TraceRow) -> dict[str, Any]:
    """A specialist's model turn, as one of a delegation's children."""
    return {
        "kind": "assistant",
        "id": row.tool_call_id,
        "agent": row.agent,
        "model": None if row.name == _UNKNOWN_MODEL else row.name,
        "text": elide_data_uris(row.output or ""),
        "thinking": elide_data_uris(row.thinking),
        "status": row.status,
        "error": elide_data_uris(row.error),
        "started_at": row.started_at,
        "ended_at": row.ended_at,
        "duration_ms": row.duration_ms,
        "usage": _usage_of(_parse_extras(row.extras)),
    }


def _child_event(
    row: TraceRow, rows: _Rows, delegation_names: Collection[str], ancestors: frozenset[str]
) -> dict[str, Any]:
    if row.kind == KIND_ASSISTANT:
        return _model_event(row)
    return _tool_event(
        tool_call_id=row.tool_call_id,
        name=row.name,
        input_value=_parse_input(row.input),
        tool_message=None,
        row=row,
        rows=rows,
        delegation_names=delegation_names,
        ancestors=ancestors,
    )


def _tool_event(
    *,
    tool_call_id: str,
    name: str,
    input_value: Any,
    tool_message: ToolMessage | None,
    row: TraceRow | None,
    rows: _Rows,
    delegation_names: Collection[str],
    ancestors: frozenset[str] = frozenset(),
) -> dict[str, Any]:
    """One tool call. `row` and `tool_message` are each optional: a call from
    before tracing has no row, a specialist's inner call has no ToolMessage
    (its message list was discarded), and a call still running has neither
    result. `ancestors` stops a malformed row that names itself as its own
    parent from recursing forever.

    With a ToolMessage (a top-level call, from the checkpoint): `surfaces` is
    its A2UI card(s), `extras` every other `additional_kwargs` key. Without
    one — a child, or a call whose result isn't checkpointed yet — `surfaces`
    is `[]` and `extras` is whatever the row recorded."""
    output = (
        render_text(tool_message.content)
        if tool_message is not None
        else (row.output if row is not None else None)
    )
    error = row.error if row is not None else None
    if output is None and error:
        # A call that raised has no result; its error IS what it produced.
        output = error
    if tool_message is not None:
        attached = tool_message.additional_kwargs or {}
        surfaces = _surface_list(attached.get(A2UI_SURFACE_KEY))
        extras = _jsonable({k: v for k, v in attached.items() if k != A2UI_SURFACE_KEY})
    else:
        surfaces = []
        extras = _parse_extras(row.extras) if row is not None else {}
    nested = ancestors | {tool_call_id}
    children = [
        _child_event(child, rows, delegation_names, nested)
        for child in ([] if tool_call_id in ancestors else rows.children.get(tool_call_id, []))
    ]
    return {
        "kind": "tool",
        "id": tool_call_id,
        "agent": row.agent if row is not None else "supervisor",
        "name": name,
        "input": elide_data_uris(input_value),
        "output": elide_data_uris(output),
        "status": _event_status(row, tool_message),
        "delegation": name if name in delegation_names else None,
        "started_at": row.started_at if row is not None else None,
        "ended_at": row.ended_at if row is not None else None,
        "duration_ms": row.duration_ms if row is not None else None,
        "stage_run_id": _stage_run_id(name, output),
        "error": elide_data_uris(error),
        # Never elided: the panel draws these as the real card.
        "surfaces": surfaces,
        "extras": elide_data_uris(extras),
        "children": children,
    }


def _ai_events(
    message: AIMessage,
    tool_messages: dict[str, ToolMessage],
    rows: _Rows,
    delegation_names: Collection[str],
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    text, thinking = ai_text_and_thinking(message.content)
    if text.strip() or thinking:
        events.append(
            {
                "kind": "assistant",
                "text": elide_data_uris(text),
                "thinking": elide_data_uris(thinking),
            }
        )
    for call in message.tool_calls or []:
        tool_call_id = call.get("id") or ""
        events.append(
            _tool_event(
                tool_call_id=tool_call_id,
                name=call.get("name") or "",
                input_value=call.get("args"),
                tool_message=tool_messages.get(tool_call_id),
                row=rows.top.get(tool_call_id),
                rows=rows,
                delegation_names=delegation_names,
            )
        )
    for bad in message.invalid_tool_calls or []:
        # The model produced a call whose arguments weren't valid JSON (a
        # reply cut off mid-call, say): nothing ran and no ToolMessage exists,
        # but it happened, and it is exactly the kind of failure worth seeing.
        tool_call_id = bad.get("id") or ""
        event = _tool_event(
            tool_call_id=tool_call_id,
            name=bad.get("name") or "",
            input_value=bad.get("args"),
            tool_message=tool_messages.get(tool_call_id),
            row=rows.top.get(tool_call_id),
            rows=rows,
            delegation_names=delegation_names,
        )
        if tool_call_id not in tool_messages:
            event["status"] = STATUS_ERROR
            event["output"] = event["output"] or elide_data_uris(bad.get("error"))
        events.append(event)
    return events


def _build_turn(turn: _Turn, rows: _Rows, delegation_names: Collection[str]) -> dict[str, Any]:
    tool_messages = {m.tool_call_id: m for m in turn.rest if isinstance(m, ToolMessage)}
    events: list[dict[str, Any]] = []
    last_ai: AIMessage | None = None
    for message in turn.rest:
        if isinstance(message, AIMessage):
            last_ai = message
            events.extend(_ai_events(message, tool_messages, rows, delegation_names))
        elif isinstance(message, HumanMessage | SystemMessage):
            events.append(
                {
                    "kind": "context",
                    "label": _context_label(message),
                    "content": elide_data_uris(render_text(message.content)),
                }
            )
        # ToolMessages are shown on their call's event, not as events of their own.
    reply = (ai_text_and_thinking(last_ai.content)[0] or None) if last_ai is not None else None
    user = (
        {"content": elide_data_uris(render_text(turn.user.content)), "synthetic": False}
        if turn.user is not None
        else None
    )
    return {
        "index": turn.index,
        "user": user,
        "events": events,
        "reply": elide_data_uris(reply),
    }


# --- entry points ---------------------------------------------------------


def _delegation_names(names: Collection[str] | None) -> Collection[str]:
    if names is not None:
        return names
    # Imported only now: supervisor.py pulls in the whole graph, and this
    # module is otherwise import-light and testable without it.
    from assistant.supervisor import _SPECIALIST_TOOL_NAMES

    return _SPECIALIST_TOOL_NAMES


def trace_page(
    messages: list[BaseMessage],
    calls: list[TraceRow],
    *,
    limit: int,
    before: int | None = None,
    delegation_names: Collection[str] | None = None,
) -> tuple[int, list[dict[str, Any]]]:
    """(total number of turns, the page): the `limit` most recent turns before
    turn index `before` (None: the very latest), oldest first. Only the
    requested turns are built, so a long thread costs a page, not the thread."""
    turns = _split_turns(messages)
    end = len(turns) if before is None else max(0, min(before, len(turns)))
    start = max(0, end - max(limit, 0))
    rows = _index_rows(calls)
    names = _delegation_names(delegation_names)
    return len(turns), [_build_turn(t, rows, names) for t in turns[start:end]]


def build_trace(
    messages: list[BaseMessage],
    calls: list[TraceRow],
    *,
    delegation_names: Collection[str] | None = None,
) -> list[dict[str, Any]]:
    """Every turn of a thread, oldest first. Each turn is `{index, user:
    {content, synthetic} | None, events, reply}`; events are `assistant`,
    `context` and `tool` dicts in checkpoint order, a `tool` event carrying the
    specialist's own work in `children` (tool calls and model turns, mixed, in
    the order they finished). `delegation_names` is the set of tool names that
    delegate to a specialist (default: supervisor's `_SPECIALIST_TOOL_NAMES`)."""
    _, turns = trace_page(
        messages, calls, limit=len(messages) + 1, delegation_names=delegation_names
    )
    return turns
