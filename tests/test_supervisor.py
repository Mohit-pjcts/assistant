"""Tests for assistant.supervisor — the NoParallelHandoffs guardrail and the
Phase 6 loop-back routing (STEPS.md 47/48).

Runnable directly (no test framework required yet). Tests each mechanism
deterministically (no live API call needed) rather than the live model
behavior it prevents/enables — that live behavior (the supervisor never
emitting two transfer_to_* calls in one turn; a genuine two-sub-agent chain
like "get alfredo ingredients and save them to Notes" completing end-to-end,
including through the interrupt confirmation gate, with no orphaned tool
calls) was verified by hand against the real model/graph and is recorded in
STEPS.md 47/48, not re-proven here on every run.
"""

import asyncio
from types import SimpleNamespace

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.graph import END
from langgraph.types import Command

from assistant.supervisor import (
    MAX_HANDOFFS_PER_TURN,
    SUPERVISOR_SYSTEM_PROMPT,
    NoParallelHandoffs,
    _count_handoffs,
    _make_routing_bridge,
    _route_after_specialist,
    build_graph,
)


def test_no_parallel_handoffs_forces_parallel_tool_calls_false() -> None:
    """This is the actual fix for STEPS.md 36: a compound request spanning
    multiple domains could make the supervisor call two transfer_to_* tools
    in the same turn, corrupting the persisted message history permanently
    (an orphaned tool_use with no matching tool_result, rejected by
    Anthropic's API on every subsequent call). Forcing
    parallel_tool_calls=False on every model call is what prevents that
    ambiguous state from ever being created."""
    middleware = NoParallelHandoffs()
    request = SimpleNamespace(model_settings={})

    async def fake_handler(req):
        return req  # echo back so the test can inspect what was set

    result = asyncio.run(middleware.awrap_model_call(request, fake_handler))
    assert result.model_settings == {"parallel_tool_calls": False}


def test_no_parallel_handoffs_preserves_other_model_settings() -> None:
    """Must merge into existing settings, not clobber them — a future
    middleware/setting added alongside this one shouldn't be silently
    dropped."""
    middleware = NoParallelHandoffs()
    request = SimpleNamespace(model_settings={"some_other_setting": "value"})

    async def fake_handler(req):
        return req

    result = asyncio.run(middleware.awrap_model_call(request, fake_handler))
    assert result.model_settings == {
        "some_other_setting": "value",
        "parallel_tool_calls": False,
    }


def _transfer_tool_message(agent_name: str) -> ToolMessage:
    return ToolMessage(
        content=f"Transferred to {agent_name}.",
        name=f"transfer_to_{agent_name}",
        tool_call_id=f"call_{agent_name}",
    )


def test_count_handoffs_counts_only_transfer_tool_messages() -> None:
    """Must count completed handoffs specifically — not any ToolMessage
    (e.g. a specialist's own tavily_search/notes_create results), or the cap
    would trip on ordinary tool use inside a sub-agent, not on handoffs."""
    messages = [
        HumanMessage(content="do things"),
        AIMessage(content="", tool_calls=[]),
        _transfer_tool_message("research_agent"),
        ToolMessage(content="search results", name="tavily_search", tool_call_id="x1"),
        _transfer_tool_message("mac_control_agent"),
        ToolMessage(content="Created note", name="notes_create", tool_call_id="x2"),
    ]
    assert _count_handoffs(messages) == 2


def test_count_handoffs_empty_history() -> None:
    assert _count_handoffs([]) == 0


def test_count_handoffs_ignores_earlier_turns() -> None:
    """Regression test for the actual bug found verifying against the real,
    persistent conversation_memory.sqlite thread (STEPS.md 48): an earlier
    version summed transfer_to_* messages across the WHOLE thread history,
    not just the current turn. Since this project's fixed THREAD_ID means
    one thread persists across every past CLI invocation forever, a thread
    with enough handoffs accumulated from PAST turns would already be at or
    over the cap before the CURRENT turn's first specialist even ran —
    silently defeating the loop-back fix on any thread beyond its first few
    turns. Scoping to messages since the most recent genuine HumanMessage
    fixes this."""
    old_turn = [
        HumanMessage(content="an earlier, unrelated request"),
        *[_transfer_tool_message(f"agent_{i}") for i in range(MAX_HANDOFFS_PER_TURN)],
        AIMessage(content="done with the old request"),
    ]
    new_turn = [
        HumanMessage(content="a brand new request"),
        _transfer_tool_message("research_agent"),
    ]
    messages = old_turn + new_turn
    assert _count_handoffs(messages) == 1


def test_count_handoffs_ignores_routing_bridge_but_not_prior_handoffs_in_turn() -> None:
    """The routing bridge is itself a HumanMessage (required — see
    _route_after_specialist's docstring) — counting from the last
    HumanMessage of ANY kind would anchor on the bridge inserted by the
    PREVIOUS loop iteration instead of the real turn boundary, undercounting
    just as badly as the lifetime-total bug this replaced."""
    messages = [
        HumanMessage(content="a brand new request"),
        _transfer_tool_message("research_agent"),
        AIMessage(content="research done"),
        _make_routing_bridge(),
        _transfer_tool_message("mac_control_agent"),
    ]
    assert _count_handoffs(messages) == 2


def test_route_after_specialist_loops_back_under_cap() -> None:
    """Below the cap: bridge back to the supervisor with a synthetic
    HumanMessage — required because re-invoking the model on history ending
    in an AIMessage (a sub-agent's own final answer) is shaped like an
    assistant-message prefill, which Anthropic's API rejects on Sonnet 5
    (hit and fixed live while building this — see STEPS.md 47/48)."""
    messages = [
        HumanMessage(content="do things"),
        _transfer_tool_message("research_agent"),
        AIMessage(content="ingredients: ..."),
    ]
    result = _route_after_specialist({"messages": messages})
    assert isinstance(result, Command)
    assert result.goto == "supervisor"
    update_messages = result.update["messages"]
    assert len(update_messages) == 1
    assert isinstance(update_messages[0], HumanMessage)


def test_route_after_specialist_ends_at_cap() -> None:
    """At/over MAX_HANDOFFS_PER_TURN: route to extract_memory (Phase 7 Part
    B) instead of looping — every path that ends a turn passes through
    memory extraction once, and this is the actual runaway-loop guard the
    plan required, enforced in code rather than left to the supervisor's
    own judgment."""
    messages = [HumanMessage(content="do things")] + [
        _transfer_tool_message(f"agent_{i}") for i in range(MAX_HANDOFFS_PER_TURN)
    ]
    result = _route_after_specialist({"messages": messages})
    assert isinstance(result, Command)
    assert result.goto == "extract_memory"
    assert result.update is None


def test_build_graph_wires_specialists_through_route_after_specialist() -> None:
    """Structural regression guard for the actual bug this phase fixed
    (STEPS.md 47): every sub-agent must route to route_after_specialist,
    which must be able to reach both "supervisor" (the loop) and
    "extract_memory" (the cap, and every other turn-ending path — Phase 7
    Part B) — not straight to END, which is what silently stalled multi-hop
    requests after the first specialist."""
    graph = build_graph(checkpointer=None, coding_extra_tools=None, mcp_tools=[])
    edges = graph.get_graph().edges
    edge_pairs = {(e.source, e.target) for e in edges}

    for agent_name in (
        "coding_agent",
        "research_agent",
        "life_admin_agent",
        "mac_control_agent",
    ):
        assert (agent_name, "route_after_specialist") in edge_pairs, (
            f"{agent_name} must route to route_after_specialist, not straight to END"
        )

    router_targets = {t for s, t in edge_pairs if s == "route_after_specialist"}
    assert router_targets == {"supervisor", "extract_memory"}, router_targets
    assert ("extract_memory", "__end__") in edge_pairs, (
        "every turn-ending path must pass through extract_memory before END"
    )


def test_supervisor_prompt_disambiguates_apple_and_google_calendar() -> None:
    """Phase 13: mac_control_agent's Apple Calendar and life_admin_agent's
    Google Calendar are two different calendar systems that both now show
    up as "calendar" requests — the supervisor's routing prompt must
    distinguish them explicitly, or routing silently breaks (STEPS.md's
    standing Phase 3 lesson)."""
    assert "APPLE" in SUPERVISOR_SYSTEM_PROMPT
    assert "GOOGLE" in SUPERVISOR_SYSTEM_PROMPT
    assert "Brave" in SUPERVISOR_SYSTEM_PROMPT


if __name__ == "__main__":
    test_no_parallel_handoffs_forces_parallel_tool_calls_false()
    print("OK: test_no_parallel_handoffs_forces_parallel_tool_calls_false")
    test_no_parallel_handoffs_preserves_other_model_settings()
    print("OK: test_no_parallel_handoffs_preserves_other_model_settings")
    test_count_handoffs_counts_only_transfer_tool_messages()
    print("OK: test_count_handoffs_counts_only_transfer_tool_messages")
    test_count_handoffs_empty_history()
    print("OK: test_count_handoffs_empty_history")
    test_count_handoffs_ignores_earlier_turns()
    print("OK: test_count_handoffs_ignores_earlier_turns")
    test_count_handoffs_ignores_routing_bridge_but_not_prior_handoffs_in_turn()
    print("OK: test_count_handoffs_ignores_routing_bridge_but_not_prior_handoffs_in_turn")
    test_route_after_specialist_loops_back_under_cap()
    print("OK: test_route_after_specialist_loops_back_under_cap")
    test_route_after_specialist_ends_at_cap()
    print("OK: test_route_after_specialist_ends_at_cap")
    test_build_graph_wires_specialists_through_route_after_specialist()
    print("OK: test_build_graph_wires_specialists_through_route_after_specialist")
    test_supervisor_prompt_disambiguates_apple_and_google_calendar()
    print("OK: test_supervisor_prompt_disambiguates_apple_and_google_calendar")
    print("\n10 tests passed")
