"""Tests for assistant.write_tools — the Phase 12 gated email/calendar/filter
write tools (STEPS.md 63/64).

Same real-graph-plus-real-checkpointer pattern as test_interrupts.py: these
tools call interrupt() themselves, which only behaves correctly inside an
actual compiled LangGraph graph with a checkpointer, so a bare .ainvoke()
outside a graph isn't a faithful test. Raw MCP tools are replaced with
in-memory fakes (name + ainvoke, matching the only interface write_tools.py
actually uses) — no live network/MCP server involved.
"""

import asyncio
import json
import tempfile
import uuid
from pathlib import Path
from typing import Annotated, Any, TypedDict

from langchain_core.messages import AnyMessage, HumanMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import Command

from assistant.memory import get_checkpointer
from assistant.write_tools import MAX_WRITES_PER_TURN, build_write_tools


class _State(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]


class FakeTool:
    """Stand-in for a raw MCP BaseTool — write_tools.py only ever calls
    .name and .ainvoke() on these, so a full BaseTool isn't needed."""

    def __init__(self, name: str, result: Any = "ok"):
        self.name = name
        self.result = result
        self.calls: list[dict] = []

    async def ainvoke(self, args: dict) -> Any:
        self.calls.append(args)
        return self.result


def _event_json(**overrides: Any) -> str:
    event = {
        "summary": "Dentist",
        "description": "",
        "location": "",
        "start": {"dateTime": "2026-07-20T15:00:00-07:00", "timeZone": "America/Los_Angeles"},
        "end": {"dateTime": "2026-07-20T15:30:00-07:00", "timeZone": "America/Los_Angeles"},
        "attendees": [],
    }
    event.update(overrides)
    return json.dumps({"event": event})


async def _run_turn(
    tool_name: str,
    tools: list,
    kwargs: dict,
    prior_messages: list[AnyMessage] | None = None,
    resume: bool | None = None,
) -> tuple[dict, dict | None]:
    """Build a minimal one-node graph invoking `tool_name` from `tools` with
    `kwargs` (state injected automatically), seeded with `prior_messages`.
    Returns (first_result, resumed_result) — resumed_result is None unless
    `resume` is given. Everything happens inside one checkpointer lifetime
    (matching test_interrupts.py's pattern) since a resumed .ainvoke() needs
    the same checkpoint the first call wrote."""
    target = next(t for t in tools if t.name == tool_name)

    async def _act(state: _State) -> dict:
        result = await target.ainvoke({**kwargs, "state": state})
        return {"messages": [ToolMessage(content=result, name=tool_name, tool_call_id="x")]}

    builder = StateGraph(_State)
    builder.add_node("act", _act)
    builder.add_edge(START, "act")
    builder.add_edge("act", END)

    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "scratch.sqlite"
        async with get_checkpointer(db_path) as checkpointer:
            graph = builder.compile(checkpointer=checkpointer)
            config = {"configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}}
            result = await graph.ainvoke({"messages": prior_messages or []}, config=config)
            resumed = None
            if resume is not None:
                resumed = await graph.ainvoke(Command(resume=resume), config=config)
            return result, resumed


# --- send_email --------------------------------------------------------


async def test_send_email_interrupt_payload_is_verbatim() -> None:
    send_email_raw = FakeTool("send_email")
    tools = build_write_tools([send_email_raw])
    result, _ = await _run_turn(
        "send_email",
        tools,
        {"to": ["a@example.com"], "subject": "Hi", "body": "Hello there", "bcc": ["b@evil.com"]},
    )
    payload = result["__interrupt__"][0].value
    assert payload["action"] == "send_email"
    assert payload["to"] == ["a@example.com"]
    assert payload["bcc"] == ["b@evil.com"], "bcc must be shown verbatim, never dropped"
    assert payload["cc"] == []  # always present, even empty
    assert payload["subject"] == "Hi"
    assert payload["body"] == "Hello there"
    assert payload["voice_approvable"] is False
    assert "spoken_prompt" not in payload, "no spoken phrasing for content-bearing actions"
    assert send_email_raw.calls == [], "must not call the raw tool before approval"


async def test_send_email_approve_sends_exact_approved_content() -> None:
    send_email_raw = FakeTool("send_email")
    tools = build_write_tools([send_email_raw])
    _, resumed = await _run_turn(
        "send_email",
        tools,
        {"to": ["a@example.com"], "subject": "Hi", "body": "Hello"},
        resume=True,
    )
    assert send_email_raw.calls == [
        {"to": ["a@example.com"], "subject": "Hi", "body": "Hello", "cc": [], "bcc": []}
    ]


async def test_send_email_decline_never_calls_raw_tool() -> None:
    send_email_raw = FakeTool("send_email")
    tools = build_write_tools([send_email_raw])
    _, resumed = await _run_turn(
        "send_email",
        tools,
        {"to": ["a@example.com"], "subject": "Hi", "body": "Hello"},
        resume=False,
    )
    assert send_email_raw.calls == []
    assert resumed["messages"][-1].content == "Cancelled — user did not confirm."


# --- modify_gmail_labels -------------------------------------------------


async def test_modify_labels_reads_back_real_message_before_gating() -> None:
    modify_email_raw = FakeTool("modify_email")
    read_email_raw = FakeTool("read_email", result=json.dumps({"from": "boss@work.com", "subject": "Re: Q3"}))
    tools = build_write_tools([modify_email_raw, read_email_raw])
    result, _ = await _run_turn(
        "modify_gmail_labels",
        tools,
        {"message_id": "m1", "remove_label_ids": ["INBOX"]},
    )
    payload = result["__interrupt__"][0].value
    assert payload["message"]["from"] == "boss@work.com"
    assert payload["message"]["subject"] == "Re: Q3"
    assert payload["remove_label_ids"] == ["INBOX"]
    assert payload["voice_approvable"] is False


async def test_modify_labels_read_back_failure_refuses_to_proceed() -> None:
    modify_email_raw = FakeTool("modify_email")
    read_email_raw = FakeTool("read_email", result="")
    tools = build_write_tools([modify_email_raw, read_email_raw])
    result, _ = await _run_turn("modify_gmail_labels", tools, {"message_id": "m1"})
    assert "__interrupt__" not in result, "must refuse before ever reaching the gate"
    assert "could not read back" in result["messages"][-1].content
    assert modify_email_raw.calls == []


# --- create_calendar_event ----------------------------------------------


async def test_create_event_payload_shows_attendees_prominently() -> None:
    create_event_raw = FakeTool("create-event")
    tools = build_write_tools([create_event_raw])
    result, _ = await _run_turn(
        "create_calendar_event",
        tools,
        {
            "title": "Team sync",
            "start": "2026-07-20T15:00:00",
            "end": "2026-07-20T15:30:00",
            "timezone": "America/Los_Angeles",
            "attendees": [{"email": "x@example.com"}],
        },
        resume=True,
    )
    payload = result["__interrupt__"][0].value
    assert payload["attendees"] == [{"email": "x@example.com"}]
    assert payload["timezone"] == "America/Los_Angeles"
    assert payload["voice_approvable"] is False
    assert create_event_raw.calls[0]["attendees"] == [{"email": "x@example.com"}]
    assert create_event_raw.calls[0]["summary"] == "Team sync"


# --- update_calendar_event -----------------------------------------------


async def test_update_event_shows_current_and_changes() -> None:
    update_event_raw = FakeTool("update-event")
    get_event_raw = FakeTool("get-event", result=_event_json())
    tools = build_write_tools([update_event_raw, get_event_raw])
    result, _ = await _run_turn(
        "update_calendar_event",
        tools,
        {"event_id": "e1", "start": "2026-07-20T16:00:00"},
        resume=True,
    )
    payload = result["__interrupt__"][0].value
    assert payload["current"]["title"] == "Dentist"
    assert payload["changes"] == {"start": "2026-07-20T16:00:00"}
    assert update_event_raw.calls[0] == {
        "calendarId": "primary",
        "eventId": "e1",
        "start": "2026-07-20T16:00:00",
    }


async def test_update_event_read_back_failure_refuses_to_proceed() -> None:
    update_event_raw = FakeTool("update-event")
    get_event_raw = FakeTool("get-event", result="not json")
    tools = build_write_tools([update_event_raw, get_event_raw])
    result, _ = await _run_turn(
        "update_calendar_event", tools, {"event_id": "e1", "title": "New title"}
    )
    assert "__interrupt__" not in result
    assert "could not read back" in result["messages"][-1].content
    assert update_event_raw.calls == []


# --- delete_calendar_event ------------------------------------------------


async def test_delete_event_is_voice_approvable_with_real_spoken_prompt() -> None:
    delete_event_raw = FakeTool("delete-event")
    get_event_raw = FakeTool("get-event", result=_event_json(summary="Dentist"))
    tools = build_write_tools([delete_event_raw, get_event_raw])
    result, _ = await _run_turn(
        "delete_calendar_event", tools, {"event_id": "e1"}, resume=True
    )
    payload = result["__interrupt__"][0].value
    assert payload["voice_approvable"] is True, "delete is the one voice-approvable write action"
    assert "Dentist" in payload["spoken_prompt"]
    assert payload["event"]["title"] == "Dentist"
    assert delete_event_raw.calls == [{"calendarId": "primary", "eventId": "e1"}]


# --- create_gmail_filter ---------------------------------------------------


async def test_create_filter_forward_target_is_a_distinct_loud_field() -> None:
    create_filter_raw = FakeTool("create_filter")
    tools = build_write_tools([create_filter_raw])
    result, _ = await _run_turn(
        "create_gmail_filter",
        tools,
        {"criteria": {"from": "bank@example.com"}, "forward_to": "attacker@evil.com"},
        resume=True,
    )
    payload = result["__interrupt__"][0].value
    assert payload["resulting_action"]["forward_to"] == "attacker@evil.com"
    assert payload["voice_approvable"] is False
    assert create_filter_raw.calls == [
        {"criteria": {"from": "bank@example.com"}, "action": {"forward": "attacker@evil.com"}}
    ]


# --- delete_gmail_filter ---------------------------------------------------


async def test_delete_filter_reads_back_real_content_not_voice_approvable() -> None:
    delete_filter_raw = FakeTool("delete_filter")
    get_filter_raw = FakeTool(
        "get_filter",
        result="Filter details:\nID: f1\nCriteria: from: bank@example.com\nActions: forward: attacker@evil.com",
    )
    tools = build_write_tools([delete_filter_raw, get_filter_raw])
    result, _ = await _run_turn(
        "delete_gmail_filter", tools, {"filter_id": "f1"}, resume=True
    )
    payload = result["__interrupt__"][0].value
    assert "attacker@evil.com" in payload["filter"]
    assert payload["voice_approvable"] is False, (
        "unlike calendar delete — identifying the filter requires reading its "
        "forward-target/criteria aloud"
    )
    assert delete_filter_raw.calls == [{"filterId": "f1"}]


# --- per-turn write cap ----------------------------------------------------


async def test_write_cap_blocks_before_interrupting() -> None:
    send_email_raw = FakeTool("send_email")
    tools = build_write_tools([send_email_raw])
    prior_messages: list[AnyMessage] = [HumanMessage(content="do a bunch of things")]
    for i in range(MAX_WRITES_PER_TURN):
        prior_messages.append(
            ToolMessage(content="ok", name="send_email", tool_call_id=f"prior-{i}")
        )
    result, _ = await _run_turn(
        "send_email",
        tools,
        {"to": ["a@example.com"], "subject": "one more", "body": "x"},
        prior_messages=prior_messages,
    )
    assert "__interrupt__" not in result, "must refuse before ever asking for confirmation"
    assert "limit" in result["messages"][-1].content
    assert send_email_raw.calls == []


async def test_write_cap_resets_after_a_new_genuine_turn() -> None:
    send_email_raw = FakeTool("send_email")
    tools = build_write_tools([send_email_raw])
    prior_messages: list[AnyMessage] = [HumanMessage(content="first turn")]
    for i in range(MAX_WRITES_PER_TURN):
        prior_messages.append(
            ToolMessage(content="ok", name="send_email", tool_call_id=f"prior-{i}")
        )
    prior_messages.append(HumanMessage(content="second, unrelated turn"))
    result, _ = await _run_turn(
        "send_email",
        tools,
        {"to": ["a@example.com"], "subject": "fresh turn", "body": "x"},
        prior_messages=prior_messages,
    )
    assert "__interrupt__" in result, "a new genuine turn must not inherit the old turn's cap count"


# --- build_write_tools graceful degradation --------------------------------


def test_build_write_tools_skips_tools_missing_raw_dependencies() -> None:
    tools = build_write_tools([FakeTool("send_email")])
    names = {t.name for t in tools}
    assert names == {"send_email"}, "only tools whose raw dependencies are present should be built"


def test_build_write_tools_empty_input_returns_empty() -> None:
    assert build_write_tools([]) == []


ASYNC_TESTS = [
    test_send_email_interrupt_payload_is_verbatim,
    test_send_email_approve_sends_exact_approved_content,
    test_send_email_decline_never_calls_raw_tool,
    test_modify_labels_reads_back_real_message_before_gating,
    test_modify_labels_read_back_failure_refuses_to_proceed,
    test_create_event_payload_shows_attendees_prominently,
    test_update_event_shows_current_and_changes,
    test_update_event_read_back_failure_refuses_to_proceed,
    test_delete_event_is_voice_approvable_with_real_spoken_prompt,
    test_create_filter_forward_target_is_a_distinct_loud_field,
    test_delete_filter_reads_back_real_content_not_voice_approvable,
    test_write_cap_blocks_before_interrupting,
    test_write_cap_resets_after_a_new_genuine_turn,
]

SYNC_TESTS = [
    test_build_write_tools_skips_tools_missing_raw_dependencies,
    test_build_write_tools_empty_input_returns_empty,
]

if __name__ == "__main__":
    for t in ASYNC_TESTS:
        asyncio.run(t())
        print(f"OK: {t.__name__}")
    for t in SYNC_TESTS:
        t()
        print(f"OK: {t.__name__}")
    print(f"\n{len(ASYNC_TESTS) + len(SYNC_TESTS)} tests passed")
