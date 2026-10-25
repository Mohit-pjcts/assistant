"""MAX_WRITES_PER_TURN applies per TOP-LEVEL turn across specialist
delegations, backed by write_cap_store's durable counter.

Under the agents-as-tools rewrite each delegation runs in a fresh,
isolated message list, so write_tools.py's cap — which counted this turn's
gated-write ToolMessages via InjectedState — had silently narrowed to
per-delegation scope. The first fix (929745b) carried counts on delegation
ToolMessage markers; it still undercounted when compaction deleted the
markers mid-turn or a delegation executed writes and then errored (no
ToolMessage to stamp). This design counts each write in a durable store at
execution time, keyed (thread_id, turn_id, tool_call_id); the cap check
reads it, and bare invocations fall back to the legacy message scan.

Every write remains individually confirmation-gated — the cap is the
runaway-loop / confirmation-fatigue guard on top, never the authorization
boundary.
"""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path
from typing import Annotated, Any, TypedDict

import pytest
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import Command

from assistant import write_cap_store
from assistant.memory import get_checkpointer
from assistant.supervisor import (
    SpecialistResult,
    _make_specialist_tool,
    _write_cap_turn_id,
)
from assistant.write_tools import (
    MAX_WRITES_PER_TURN,
    _writes_so_far_this_turn,
    build_write_tools,
)
from tests.test_write_tools import FakeTool

pytestmark = pytest.mark.anyio

THREAD = "test-thread-cap"


@pytest.fixture()
def cap_db(tmp_path, monkeypatch):
    db = tmp_path / "caps.sqlite"
    monkeypatch.setattr(write_cap_store, "DEFAULT_DB_PATH", db)
    return db


class _State(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]


async def _invoke_write_tool(
    tool,
    kwargs: dict,
    state_extra: dict | None = None,
    resume: bool | None = None,
    thread_id: str = THREAD,
) -> tuple[dict, dict | None]:
    """Run one gated write tool inside a real one-node graph (ambient
    thread_id present, as in production). state_extra carries the keys a
    specialist's state would have (pre_approved_actions, write_cap_turn_id)."""
    call_id = str(uuid.uuid4())

    async def _act(state: _State) -> dict:
        full_state = {**state, **(state_extra or {})}
        call = {
            "args": {**kwargs, "state": full_state},
            "id": call_id,
            "name": tool.name,
            "type": "tool_call",
        }
        msg = await tool.ainvoke(call)
        return {"messages": [msg]}

    builder = StateGraph(_State)
    builder.add_node("act", _act)
    builder.add_edge(START, "act")
    builder.add_edge("act", END)
    with tempfile.TemporaryDirectory() as tmp:
        async with get_checkpointer(Path(tmp) / "scratch.sqlite") as checkpointer:
            graph = builder.compile(checkpointer=checkpointer)
            config = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}
            result = await graph.ainvoke({"messages": [HumanMessage(content="go")]}, config=config)
            resumed = None
            if resume is not None:
                resumed = await graph.ainvoke(Command(resume=resume), config=config)
            return result, resumed


def _send_tool():
    raw = FakeTool("send_email")
    return raw, next(t for t in build_write_tools([raw]) if t.name == "send_email")


_SEND_KWARGS = {"to": ["a@example.com"], "subject": "s", "body": "b"}


async def test_capped_out_by_durable_count_refuses_before_interrupt(cap_db) -> None:
    """Prior delegations of the same turn already executed the cap — no
    writes in THIS call's own message list, still refused up front."""
    raw, tool = _send_tool()
    for i in range(MAX_WRITES_PER_TURN):
        write_cap_store.record_write(THREAD, "turn-1", f"earlier-{i}", "send_email", cap_db)
    result, _ = await _invoke_write_tool(tool, _SEND_KWARGS, {"write_cap_turn_id": "turn-1"})
    assert "__interrupt__" not in result, "must refuse before ever asking for confirmation"
    assert "limit" in result["messages"][-1].content
    assert raw.calls == []


async def test_executed_write_records_itself_and_scopes_later_calls(cap_db) -> None:
    raw, tool = _send_tool()
    state = {"write_cap_turn_id": "turn-1", "pre_approved_actions": {"send_email"}}
    await _invoke_write_tool(tool, _SEND_KWARGS, state)
    assert raw.calls, "pre-approved write should have executed"
    assert write_cap_store.count_writes(THREAD, "turn-1", cap_db) == 1
    # A different turn (new user message) starts a clean bucket.
    assert write_cap_store.count_writes(THREAD, "turn-2", cap_db) == 0


async def test_cumulative_cap_across_sequential_delegations(cap_db) -> None:
    """The regression the store fixes: two delegations in one turn, each
    under the cap on its own isolated history, together exceeding it."""
    raw, tool = _send_tool()
    state = {"write_cap_turn_id": "turn-1", "pre_approved_actions": {"send_email"}}
    for _ in range(MAX_WRITES_PER_TURN):
        await _invoke_write_tool(tool, _SEND_KWARGS, state)
    assert write_cap_store.count_writes(THREAD, "turn-1", cap_db) == MAX_WRITES_PER_TURN
    result, _ = await _invoke_write_tool(tool, _SEND_KWARGS, state)
    assert "limit" in result["messages"][-1].content
    assert len(raw.calls) == MAX_WRITES_PER_TURN


async def test_declined_write_records_nothing(cap_db) -> None:
    raw, tool = _send_tool()
    result, resumed = await _invoke_write_tool(
        tool, _SEND_KWARGS, {"write_cap_turn_id": "turn-1"}, resume=False
    )
    assert "__interrupt__" in result
    assert "Cancelled" in resumed["messages"][-1].content
    assert raw.calls == []
    assert write_cap_store.count_writes(THREAD, "turn-1", cap_db) == 0


async def test_approved_resume_records_exactly_once(cap_db) -> None:
    raw, tool = _send_tool()
    result, resumed = await _invoke_write_tool(
        tool, _SEND_KWARGS, {"write_cap_turn_id": "turn-1"}, resume=True
    )
    assert "__interrupt__" in result
    assert raw.calls, "approved write should have executed on resume"
    assert write_cap_store.count_writes(THREAD, "turn-1", cap_db) == 1


def test_fallback_message_scan_without_durable_context() -> None:
    """Bare invocations (no ambient thread / no turn id) keep the legacy
    behaviour: count this state's own gated-write ToolMessages."""
    state = {
        "messages": [
            HumanMessage(content="turn"),
            ToolMessage(content="ok", name="send_email", tool_call_id="a"),
        ]
    }
    assert _writes_so_far_this_turn(state) == 1


def test_turn_id_prefers_message_id_and_distinguishes_identical_texts() -> None:
    with_id = _write_cap_turn_id({"messages": [HumanMessage(content="hi", id="m-1")]})
    assert with_id == "m-1"
    first = _write_cap_turn_id({"messages": [HumanMessage(content="same")]})
    second = _write_cap_turn_id(
        {"messages": [HumanMessage(content="same"), AIMessage(content="ok"),
                      HumanMessage(content="same")]}
    )
    assert first != second, "identical texts in different turns must not share a bucket"


def test_turn_id_ignores_synthetic_messages() -> None:
    """Only genuine human turns set the boundary — a compaction summary or
    recalled-facts injection must not start a new bucket."""
    from assistant.compaction import _RECALLED_FACTS_MARKER_KEY

    real = HumanMessage(content="real question", id="real-1")
    injected = HumanMessage(
        content="Recalled facts about the user: ...",
        additional_kwargs={_RECALLED_FACTS_MARKER_KEY: True},
    )
    assert _write_cap_turn_id({"messages": [real, injected, AIMessage(content="x")]}) == "real-1"


async def test_supervisor_threads_one_turn_id_through_every_delegation() -> None:
    """Both delegations of a compound turn must receive the SAME turn id —
    that is what puts their writes in one counter bucket."""
    seen: list[str] = []

    async def fake_invoke(messages, pre_approved, write_cap_turn_id):
        seen.append(write_cap_turn_id)
        return SpecialistResult("done", [], [], [])

    tool = _make_specialist_tool("life_admin_agent", "desc", fake_invoke)

    async def _act(state: _State) -> dict:
        for i in range(2):
            call = {
                "args": {"request": f"leg {i}", "state": state, "tool_call_id": f"c-{i}"},
                "id": f"c-{i}",
                "name": "life_admin_agent",
                "type": "tool_call",
            }
            await tool.ainvoke(call)
        return {}

    builder = StateGraph(_State)
    builder.add_node("act", _act)
    builder.add_edge(START, "act")
    builder.add_edge("act", END)
    with tempfile.TemporaryDirectory() as tmp:
        async with get_checkpointer(Path(tmp) / "scratch.sqlite") as checkpointer:
            graph = builder.compile(checkpointer=checkpointer)
            config = {"configurable": {"thread_id": THREAD, "checkpoint_ns": ""}}
            await graph.ainvoke({"messages": [HumanMessage(content="compound", id="u-1")]}, config=config)
    assert len(seen) == 2 and seen[0] == seen[1] == "u-1"


async def test_corrupt_store_fails_open_to_confirmation_not_turn_breakage(cap_db, tmp_path) -> None:
    """A corrupt counter file must never break a real turn or skip a
    confirmation: the cap check falls back to the legacy message scan and
    the gate still interrupts; recording is swallowed."""
    cap_db.write_bytes(b"not a sqlite database at all")
    raw, tool = _send_tool()
    result, _ = await _invoke_write_tool(tool, _SEND_KWARGS, {"write_cap_turn_id": "turn-1"})
    assert "__interrupt__" in result, "gate must still fire with a broken counter"
    assert raw.calls == []


async def test_cap_concurrency_reasoning_holds_sequential_execution(cap_db) -> None:
    """Check-then-record is deliberately NOT atomic. It is safe here because
    within one turn gated writes are structurally sequential (life_admin's
    model has parallel_tool_calls disabled — write_tools.py docstring) and
    GuardedParallelReads trims any multi-call model response to one
    non-read call, so two same-turn writes can never interleave their
    check and record. This test pins the sequential guarantee the design
    relies on: back-to-back calls each see the previous one's record."""
    raw, tool = _send_tool()
    state = {"write_cap_turn_id": "turn-1", "pre_approved_actions": {"send_email"}}
    for i in range(MAX_WRITES_PER_TURN):
        result, _ = await _invoke_write_tool(tool, _SEND_KWARGS, state)
        assert write_cap_store.count_writes(THREAD, "turn-1", cap_db) == i + 1
    result, _ = await _invoke_write_tool(tool, _SEND_KWARGS, state)
    assert "limit" in result["messages"][-1].content
