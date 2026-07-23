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
from types import SimpleNamespace

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from assistant.compaction import tag_recalled_facts
from assistant.supervisor import (
    SUPERVISOR_SYSTEM_PROMPT,
    NoParallelSpecialistCalls,
    _context_prefix_messages,
    build_graph,
)


def test_no_parallel_specialist_calls_forces_parallel_tool_calls_false() -> None:
    """Mirrors the old NoParallelHandoffs test — the same underlying
    reason survives the rewrite unchanged: server.py's SSE/`/resume`
    handling only relays the FIRST pending interrupt in a turn, so two
    gated specialist calls in one AIMessage could strand the second one's
    confirmation with no way to approve/decline it."""
    middleware = NoParallelSpecialistCalls()
    request = SimpleNamespace(model_settings={})

    async def fake_handler(req):
        return req  # echo back so the test can inspect what was set

    result = asyncio.run(middleware.awrap_model_call(request, fake_handler))
    assert result.model_settings == {"parallel_tool_calls": False}


def test_no_parallel_specialist_calls_preserves_other_model_settings() -> None:
    """Must merge into existing settings, not clobber them — a future
    middleware/setting added alongside this one shouldn't be silently
    dropped."""
    middleware = NoParallelSpecialistCalls()
    request = SimpleNamespace(model_settings={"some_other_setting": "value"})

    async def fake_handler(req):
        return req

    result = asyncio.run(middleware.awrap_model_call(request, fake_handler))
    assert result.model_settings == {
        "some_other_setting": "value",
        "parallel_tool_calls": False,
    }


def test_context_prefix_forwards_recalled_facts_from_current_turn() -> None:
    """Since a specialist call is now an isolated ainvoke() rather than a
    view onto shared graph state, this is what replaces the old
    SubAgentWindowMiddleware's implicit sharing — deliberately forwarding
    the current turn's recalled-facts message (Phase 7 Part B) so a
    specialist still gets the same background context it used to see for
    free."""
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


def test_context_prefix_ignores_recalled_facts_from_an_earlier_turn() -> None:
    """A recalled-facts message from a PAST turn must not be re-forwarded
    into a specialist call made during a later, unrelated turn — scoped to
    the current turn boundary the same way memory_extraction.py's own
    `_current_turn_user_text` is."""
    stale_recalled = HumanMessage(content="[Known facts about the user: stale]")
    tag_recalled_facts(stale_recalled)
    state = {
        "messages": [
            HumanMessage(content="an earlier request"),
            stale_recalled,
            AIMessage(content="handled"),
            HumanMessage(content="a brand new request"),
        ]
    }
    assert _context_prefix_messages(state) == []


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
    supervisor -> extract_memory -> END."""
    graph = build_graph(checkpointer=None, coding_extra_tools=None, mcp_tools=[])
    nodes = set(graph.get_graph().nodes.keys())
    assert nodes == {
        "__start__",
        "compact_history",
        "recall_memory",
        "supervisor",
        "extract_memory",
        "__end__",
    }
    edges = graph.get_graph().edges
    edge_pairs = {(e.source, e.target) for e in edges}
    assert edge_pairs == {
        ("__start__", "compact_history"),
        ("compact_history", "recall_memory"),
        ("recall_memory", "supervisor"),
        ("supervisor", "extract_memory"),
        ("extract_memory", "__end__"),
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


if __name__ == "__main__":
    test_no_parallel_specialist_calls_forces_parallel_tool_calls_false()
    print("OK: test_no_parallel_specialist_calls_forces_parallel_tool_calls_false")
    test_no_parallel_specialist_calls_preserves_other_model_settings()
    print("OK: test_no_parallel_specialist_calls_preserves_other_model_settings")
    test_context_prefix_forwards_recalled_facts_from_current_turn()
    print("OK: test_context_prefix_forwards_recalled_facts_from_current_turn")
    test_context_prefix_ignores_recalled_facts_from_an_earlier_turn()
    print("OK: test_context_prefix_ignores_recalled_facts_from_an_earlier_turn")
    test_context_prefix_forwards_compaction_summary_when_present()
    print("OK: test_context_prefix_forwards_compaction_summary_when_present")
    test_context_prefix_empty_when_nothing_to_forward()
    print("OK: test_context_prefix_empty_when_nothing_to_forward")
    test_build_graph_is_a_plain_unconditional_pipeline()
    print("OK: test_build_graph_is_a_plain_unconditional_pipeline")
    test_supervisor_prompt_disambiguates_apple_and_google_calendar()
    print("OK: test_supervisor_prompt_disambiguates_apple_and_google_calendar")
    print("\n8 tests passed")
