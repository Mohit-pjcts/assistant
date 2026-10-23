"""Tests for assistant.supervisor — the agents-as-tools rewrite.

Runnable directly (no test framework required yet). Tests each mechanism
deterministically (no live API call needed) rather than the live model
behavior it prevents/enables. The confirmation-gate mechanism this rewrite
depends on (interrupt()/Command(resume=...) still pausing/resuming
correctly when a specialist is invoked as a nested ainvoke() from inside a
tool function, rather than as its own graph node) was verified BEFORE this
rewrite via two live spikes (a minimal bare-StateGraph version and the real
create_agent/ToolNode call path) and again end-to-end against the real CLI
and a real Langfuse trace — not re-proven here on every run; see
supervisor.py's module docstring.
"""

import asyncio
import uuid
from pathlib import Path
from typing import Any, TypedDict

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from assistant import workflow_store
from assistant.compaction import tag_recalled_facts
from assistant.memory import get_checkpointer
from assistant.supervisor import (
    _GATED_ACTION_APPROVED_KEY,
    _GATED_TOOL_CANCELLED_TEXT,
    _WORKFLOW_RUN_ID_KEY,
    GATED_ACTIONS,
    SUPERVISOR_SYSTEM_PROMPT,
    _active_workflow_run_id_this_turn,
    _context_prefix_messages,
    _extract_gated_action_executions,
    _make_propose_workflow_tool,
    _pre_approved_actions_this_turn,
    _prior_specialist_results_this_turn,
    _record_workflow_progress,
    build_graph,
)


def test_context_prefix_forwards_recalled_facts_from_current_turn() -> None:
    """Since a specialist call is now an isolated ainvoke() rather than a
    view onto shared graph state, this is what replaces the old
    SubAgentWindowMiddleware's implicit sharing — deliberately forwarding
    the recalled-facts message (Phase 7 Part B) so a specialist still gets
    the same background context it used to see for free."""
    recalled = HumanMessage(content="[Known facts about the user: ...]")
    tag_recalled_facts(recalled)
    state = {
        "messages": [
            HumanMessage(content="what's the weather"),
            recalled,
        ]
    }
    prefix = _context_prefix_messages(state)
    assert prefix == [recalled]


def test_context_prefix_forwards_recalled_facts_from_an_earlier_turn_too() -> None:
    """A real regression, found live (2026-07-28): once recall_memory_node
    was changed to inject the recalled-facts message ONLY on a thread's
    first genuine turn (not every turn), a specialist call made on any
    LATER turn stopped receiving any memory context at all — a live
    mac_control_agent delegation on turn 3 of a thread had zero visibility
    into facts recalled back on turn 1. There is only ever one recalled-
    facts message per thread now, so it must keep being forwarded no matter
    how many turns have passed since it was added — this is the fix, not
    the old (now-wrong) 'ignore anything outside the current turn'
    behavior."""
    recalled = HumanMessage(content="[Known facts about the user: from turn 1]")
    tag_recalled_facts(recalled)
    state = {
        "messages": [
            HumanMessage(content="an earlier request"),
            recalled,
            AIMessage(content="handled"),
            HumanMessage(content="a brand new, later request"),
        ]
    }
    assert _context_prefix_messages(state) == [recalled]


def test_context_prefix_forwards_compaction_summary_when_present() -> None:
    from assistant.compaction import _SUMMARY_MARKER_KEY

    summary = HumanMessage(
        content="[Summary of earlier conversation: ...]",
        additional_kwargs={_SUMMARY_MARKER_KEY: True},
    )
    state = {"messages": [summary, HumanMessage(content="continue please")]}
    assert _context_prefix_messages(state) == [summary]


def test_context_prefix_empty_when_nothing_to_forward() -> None:
    state = {"messages": [HumanMessage(content="hello")]}
    assert _context_prefix_messages(state) == []


def test_build_graph_is_a_plain_unconditional_pipeline() -> None:
    """Structural regression guard for the actual point of this rewrite:
    no more Command-based routing, no more conditional edges between
    "handed off" and "answered directly" — since specialists are tools
    now, the supervisor node always naturally completes with a final
    answer, so the graph is just compact_history -> recall_memory ->
    supervisor -> END.

    `extract_memory` (the old per-turn, interrupt()-gated extraction node)
    was removed 2026-07-28 in favor of memory_review_agent.py's nightly
    batch pass, run outside this graph entirely — see that module's and
    memory_extraction.py's docstrings."""
    graph = build_graph(checkpointer=None, coding_extra_tools=None, mcp_tools=[])
    nodes = set(graph.get_graph().nodes.keys())
    assert nodes == {
        "__start__",
        "compact_history",
        "recall_memory",
        "supervisor",
        "__end__",
    }
    edges = graph.get_graph().edges
    edge_pairs = {(e.source, e.target) for e in edges}
    assert edge_pairs == {
        ("__start__", "compact_history"),
        ("compact_history", "recall_memory"),
        ("recall_memory", "supervisor"),
        ("supervisor", "__end__"),
    }


def test_supervisor_prompt_disambiguates_apple_and_google_calendar() -> None:
    """Phase 13: mac_control_agent's Apple Calendar and life_admin_agent's
    Google Calendar are two different calendar systems that both now show
    up as "calendar" requests — the supervisor's routing prompt must
    distinguish them explicitly, or routing silently breaks (STEPS.md's
    standing Phase 3 lesson). Unaffected by the agents-as-tools rewrite —
    only the handoff-vs-tool-call framing around this guidance changed."""
    assert "APPLE" in SUPERVISOR_SYSTEM_PROMPT
    assert "GOOGLE" in SUPERVISOR_SYSTEM_PROMPT
    assert "Brave" in SUPERVISOR_SYSTEM_PROMPT


def test_supervisor_prompt_names_propose_workflow_and_the_1_vs_2_rule() -> None:
    """PLAN.md Phase 25: assume the Phase 18/20 'supervisor can't see a
    capability it wasn't told about' routing-blindness bug would recur
    here too, don't just hope propose_workflow's own tool description is
    enough — the system prompt must ALSO name it explicitly, same
    belt-and-suspenders pattern as the existing GATED_ACTIONS paragraph
    this test sits next to."""
    assert "propose_workflow" in SUPERVISOR_SYSTEM_PROMPT
    assert "TWO OR MORE" in SUPERVISOR_SYSTEM_PROMPT
    assert "STOP delegating" in SUPERVISOR_SYSTEM_PROMPT


# --- PLAN.md Phase 25: cross-app workflow chaining --------------------------


def test_pre_approved_actions_accepts_bare_string_marker() -> None:
    """The original request_gated_action_confirmation shape must keep
    working unchanged after propose_workflow adds a second, list-valued
    shape to the same marker key."""
    approved_msg = ToolMessage(
        content="Approved", tool_call_id="tc1", additional_kwargs={_GATED_ACTION_APPROVED_KEY: "send_imessage"}
    )
    state = {"messages": [HumanMessage(content="do it"), approved_msg]}
    assert _pre_approved_actions_this_turn(state) == {"send_imessage"}


def test_pre_approved_actions_accepts_list_marker_from_propose_workflow() -> None:
    approved_msg = ToolMessage(
        content="Approved",
        tool_call_id="tc1",
        additional_kwargs={_GATED_ACTION_APPROVED_KEY: ["calendar_create_event", "send_imessage"]},
    )
    state = {"messages": [HumanMessage(content="do it"), approved_msg]}
    assert _pre_approved_actions_this_turn(state) == {"calendar_create_event", "send_imessage"}


def test_active_workflow_run_id_found_within_current_turn() -> None:
    marker_msg = ToolMessage(
        content="Approved", tool_call_id="tc1", additional_kwargs={_WORKFLOW_RUN_ID_KEY: "run-123"}
    )
    state = {"messages": [HumanMessage(content="do the workflow"), marker_msg]}
    assert _active_workflow_run_id_this_turn(state) == "run-123"


def test_active_workflow_run_id_none_when_absent() -> None:
    state = {"messages": [HumanMessage(content="just a normal request")]}
    assert _active_workflow_run_id_this_turn(state) is None


def test_active_workflow_run_id_not_carried_from_an_earlier_turn() -> None:
    """Opposite scoping from _context_prefix_messages' recalled-facts
    forwarding — an approved workflow from a past, unrelated turn must
    never leak into a later turn's execution."""
    marker_msg = ToolMessage(
        content="Approved", tool_call_id="tc1", additional_kwargs={_WORKFLOW_RUN_ID_KEY: "old-run"}
    )
    state = {
        "messages": [
            HumanMessage(content="an earlier workflow request"),
            marker_msg,
            AIMessage(content="done"),
            HumanMessage(content="a brand new, unrelated request"),
        ]
    }
    assert _active_workflow_run_id_this_turn(state) is None


def test_prior_specialist_results_forwards_verbatim_with_provenance_label() -> None:
    ai_call = AIMessage(
        content="",
        tool_calls=[{"name": "research_agent", "args": {"request": "weather in SF"}, "id": "call-1"}],
    )
    result_msg = ToolMessage(content="It's 68F and sunny in SF.", tool_call_id="call-1")
    state = {"messages": [HumanMessage(content="pack for my trip"), ai_call, result_msg]}

    forwarded = _prior_specialist_results_this_turn(state)
    assert len(forwarded) == 1
    assert isinstance(forwarded[0], HumanMessage)
    assert "research_agent" in forwarded[0].content
    assert "It's 68F and sunny in SF." in forwarded[0].content
    assert "untrusted" in forwarded[0].content


def test_prior_specialist_results_excludes_confirmation_tool_bookkeeping() -> None:
    """request_gated_action_confirmation's/propose_workflow's own
    ToolMessages are supervisor-internal bookkeeping, not specialist
    output — forwarding them as "prior results" would be noise, not
    useful cross-app context."""
    ai_call = AIMessage(
        content="",
        tool_calls=[{"name": "request_gated_action_confirmation", "args": {}, "id": "call-1"}],
    )
    confirm_msg = ToolMessage(content="Approved — proceed", tool_call_id="call-1")
    state = {"messages": [HumanMessage(content="send it"), ai_call, confirm_msg]}
    assert _prior_specialist_results_this_turn(state) == []


def test_prior_specialist_results_scoped_to_current_turn_only() -> None:
    ai_call = AIMessage(
        content="", tool_calls=[{"name": "research_agent", "args": {}, "id": "call-1"}]
    )
    old_result = ToolMessage(content="stale result from a past turn", tool_call_id="call-1")
    state = {
        "messages": [
            HumanMessage(content="earlier request"),
            ai_call,
            old_result,
            AIMessage(content="handled"),
            HumanMessage(content="a brand new request"),
        ]
    }
    assert _prior_specialist_results_this_turn(state) == []


def test_extract_gated_action_executions_classifies_success_decline_and_error() -> None:
    messages: list[Any] = [
        AIMessage(
            content="",
            tool_calls=[
                {"name": "calendar_create_event", "args": {"title": "Flight"}, "id": "call-1"},
                {"name": "send_imessage", "args": {"recipient": "Rishabh"}, "id": "call-2"},
                {"name": "reminders_create", "args": {"title": "x"}, "id": "call-3"},  # not gated, ignored
            ],
        ),
        ToolMessage(content="Created event 'Flight' (id=abc123)", tool_call_id="call-1"),
        ToolMessage(content=_GATED_TOOL_CANCELLED_TEXT, tool_call_id="call-2"),
        ToolMessage(content="(done)", tool_call_id="call-3"),
    ]
    executions = _extract_gated_action_executions(messages)
    by_action = {e["action"]: e for e in executions}

    assert set(by_action) == {"calendar_create_event", "send_imessage"}
    assert by_action["calendar_create_event"]["executed"] is True
    assert by_action["calendar_create_event"]["args"] == {"title": "Flight"}
    assert by_action["send_imessage"]["executed"] is False


def test_extract_gated_action_executions_treats_error_result_as_not_executed() -> None:
    """A genuine execution failure (e.g. a bad Reminders list name) is
    NOT a decline, but it must still count as "did not execute" for the
    workflow audit — PLAN.md Phase 25 decision D6's stop-at-first-failure
    depends on this."""
    messages: list[Any] = [
        AIMessage(
            content="",
            tool_calls=[{"name": "calendar_create_event", "args": {"title": "X"}, "id": "call-1"}],
        ),
        ToolMessage(content="Error: could not parse start/end/timezone: bad value", tool_call_id="call-1"),
    ]
    executions = _extract_gated_action_executions(messages)
    assert executions == [
        {
            "action": "calendar_create_event",
            "args": {"title": "X"},
            "executed": False,
            "result_text": "Error: could not parse start/end/timezone: bad value",
        }
    ]


def test_extract_gated_action_executions_treats_noop_update_as_not_executed() -> None:
    """A real bug this reproduces directly: update_calendar_event/
    calendar_update_event's "nothing to change" no-op result doesn't start
    with "Error" and isn't the cancel string, so it used to be
    misclassified executed=True even though nothing actually happened."""
    messages: list[Any] = [
        AIMessage(
            content="",
            tool_calls=[{"name": "update_calendar_event", "args": {"event_id": "e1"}, "id": "call-1"}],
        ),
        ToolMessage(content="Nothing to update — no fields were provided.", tool_call_id="call-1"),
    ]
    executions = _extract_gated_action_executions(messages)
    assert executions[0]["executed"] is False


async def _record_progress_for_test(tmp_path: Path, executions_sequence: list[list[dict[str, Any]]]) -> str:
    db_path = tmp_path / "workflows.sqlite"
    run = await workflow_store.create_run(
        "thread-1",
        "test goal",
        [
            {"action": "calendar_create_event", "summary": "Create the event"},
            {"action": "send_imessage", "summary": "Send the text"},
        ],
        db_path=db_path,
    )
    for executions in executions_sequence:
        # _record_workflow_progress always resolves against workflow_store's
        # module-level DEFAULT_DB_PATH — monkeypatched by the caller.
        await _record_workflow_progress(run.id, executions)
    return run.id


def test_record_workflow_progress_completes_on_all_successes(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(workflow_store, "DEFAULT_DB_PATH", tmp_path / "workflows.sqlite")
    run_id = asyncio.run(
        _record_progress_for_test(
            tmp_path,
            [
                [{"action": "calendar_create_event", "args": {"title": "Flight"}, "executed": True, "result_text": "Created"}],
                [{"action": "send_imessage", "args": {"recipient": "Rishabh"}, "executed": True, "result_text": "Sent"}],
            ],
        )
    )
    run = asyncio.run(workflow_store.get_run(run_id, db_path=tmp_path / "workflows.sqlite"))
    assert run.status == workflow_store.RUN_STATUS_COMPLETED
    assert all(s.outcome == workflow_store.STEP_OUTCOME_SUCCESS for s in run.steps)
    assert run.steps[0].executed_args == {"title": "Flight"}


def test_record_workflow_progress_stops_and_marks_remaining_never_ran_on_failure(tmp_path, monkeypatch) -> None:
    """PLAN.md Phase 25 decision D6: stop at the first failure, no
    rollback — the second step must be recorded as never_ran, not left
    null forever, once the run is finalized as failed."""
    monkeypatch.setattr(workflow_store, "DEFAULT_DB_PATH", tmp_path / "workflows.sqlite")
    run_id = asyncio.run(
        _record_progress_for_test(
            tmp_path,
            [
                [
                    {
                        "action": "calendar_create_event",
                        "args": {"title": "Flight"},
                        "executed": False,
                        "result_text": "Error: osascript failed",
                    }
                ],
            ],
        )
    )
    run = asyncio.run(workflow_store.get_run(run_id, db_path=tmp_path / "workflows.sqlite"))
    assert run.status == workflow_store.RUN_STATUS_FAILED
    assert run.steps[0].outcome == workflow_store.STEP_OUTCOME_FAILED
    assert run.steps[1].outcome == workflow_store.STEP_OUTCOME_NEVER_RAN
    assert run.steps[1].executed_args is None


# --- propose_workflow's own confirmation gate --------------------------------


class _WorkflowToolState(TypedDict):
    result: Any


def _build_propose_workflow_graph(checkpointer, steps: list[dict[str, str]]):
    tool = _make_propose_workflow_tool()

    async def node(state: _WorkflowToolState) -> dict:
        result = await tool.ainvoke(
            {
                "name": "propose_workflow",
                "args": {"goal": "Flight check-in", "steps": steps},
                "id": "tc-workflow-1",
                "type": "tool_call",
            }
        )
        return {"result": result}

    builder = StateGraph(_WorkflowToolState)
    builder.add_node("act", node)
    builder.add_edge(START, "act")
    builder.add_edge("act", END)
    return builder.compile(checkpointer=checkpointer)


async def _run_propose_workflow_case(
    resume: bool, tmp_path: Path, steps: list[dict[str, str]]
) -> Command:
    async with get_checkpointer(tmp_path / "scratch.sqlite") as checkpointer:
        graph = _build_propose_workflow_graph(checkpointer, steps)
        config = {"configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}}
        result = await graph.ainvoke({"result": None}, config=config)
        assert "__interrupt__" in result, f"expected interrupt, got {result}"
        resumed = await graph.ainvoke(Command(resume=resume), config=config)
        return resumed["result"]


def test_propose_workflow_rejects_fewer_than_two_steps() -> None:
    """Decision D9's mechanical rule enforced structurally, not just by
    prompt: a single action must go through request_gated_action_
    confirmation instead. No interrupt() reached at all for this path."""
    tool = _make_propose_workflow_tool()
    result = asyncio.run(
        tool.ainvoke(
            {
                "name": "propose_workflow",
                "args": {
                    "goal": "one thing",
                    "steps": [{"action": "calendar_create_event", "summary": "x"}],
                },
                "id": "tc1",
                "type": "tool_call",
            }
        )
    )
    content = result.update["messages"][0].content
    assert "at least 2 steps" in content
    assert "request_gated_action_confirmation" in content


def test_propose_workflow_rejects_an_action_outside_gated_actions() -> None:
    tool = _make_propose_workflow_tool()
    result = asyncio.run(
        tool.ainvoke(
            {
                "name": "propose_workflow",
                "args": {
                    "goal": "g",
                    "steps": [
                        {"action": "calendar_create_event", "summary": "x"},
                        {"action": "totally_made_up_action", "summary": "y"},
                    ],
                },
                "id": "tc1",
                "type": "tool_call",
            }
        )
    )
    content = result.update["messages"][0].content
    assert "not a recognized gated action" in content
    assert "totally_made_up_action" in content


def test_propose_workflow_declined_creates_no_workflow_run(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(workflow_store, "DEFAULT_DB_PATH", tmp_path / "workflows.sqlite")
    steps = [
        {"action": "calendar_create_event", "summary": "Create the event"},
        {"action": "send_imessage", "summary": "Send the text"},
    ]
    command = asyncio.run(_run_propose_workflow_case(resume=False, tmp_path=tmp_path, steps=steps))
    message = command.update["messages"][0]
    assert "Declined" in message.content
    assert message.additional_kwargs == {}
    runs = asyncio.run(workflow_store.list_runs(db_path=tmp_path / "workflows.sqlite"))
    assert runs == []


def test_propose_workflow_approved_persists_the_run_and_stamps_both_markers(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(workflow_store, "DEFAULT_DB_PATH", tmp_path / "workflows.sqlite")
    steps = [
        {"action": "calendar_create_event", "summary": "Create the event"},
        {"action": "send_imessage", "summary": "Send the text"},
    ]
    command = asyncio.run(_run_propose_workflow_case(resume=True, tmp_path=tmp_path, steps=steps))
    message = command.update["messages"][0]

    assert "Approved" in message.content
    assert message.additional_kwargs[_GATED_ACTION_APPROVED_KEY] == [
        "calendar_create_event",
        "send_imessage",
    ]
    run_id = message.additional_kwargs[_WORKFLOW_RUN_ID_KEY]
    run = asyncio.run(workflow_store.get_run(run_id, db_path=tmp_path / "workflows.sqlite"))
    assert run is not None
    assert run.goal == "Flight check-in"
    assert [s.action for s in run.steps] == ["calendar_create_event", "send_imessage"]
    assert all(s.outcome is None for s in run.steps)  # nothing executed yet, only approved


def test_all_gated_actions_have_an_owning_specialist_entry() -> None:
    """propose_workflow's own returned instruction interpolates
    GATED_ACTIONS[action] for every step — a KeyError there would surface
    as a live 500, not a graceful tool error, so this is worth a direct
    regression guard."""
    assert all(isinstance(v, str) and v for v in GATED_ACTIONS.values())


if __name__ == "__main__":
    test_context_prefix_forwards_recalled_facts_from_current_turn()
    print("OK: test_context_prefix_forwards_recalled_facts_from_current_turn")
    test_context_prefix_forwards_recalled_facts_from_an_earlier_turn_too()
    print("OK: test_context_prefix_forwards_recalled_facts_from_an_earlier_turn_too")
    test_context_prefix_forwards_compaction_summary_when_present()
    print("OK: test_context_prefix_forwards_compaction_summary_when_present")
    test_context_prefix_empty_when_nothing_to_forward()
    print("OK: test_context_prefix_empty_when_nothing_to_forward")
    test_build_graph_is_a_plain_unconditional_pipeline()
    print("OK: test_build_graph_is_a_plain_unconditional_pipeline")
    test_supervisor_prompt_disambiguates_apple_and_google_calendar()
    print("OK: test_supervisor_prompt_disambiguates_apple_and_google_calendar")
    print("\n8 tests passed")
