"""Tests for assistant.compaction and assistant.sub_agents.SubAgentWindowMiddleware
— Phase 7 Part A (short-term compaction + the bundled Phase 6 context-leakage
fix, STEPS.md 48).

Runnable directly, matching tests/test_supervisor.py's convention: the
deterministic boundary-finding/windowing logic is unit-tested here without a
live API call; the two live-model behaviors this module depends on —
compaction actually firing and shrinking a real thread, and a specialist no
longer imitating a planted transfer_to_* example once windowed — were
verified against the real model in throwaway spike scripts and are recorded
in STEPS.md, not re-proven here on every run (same rationale as
test_supervisor.py's live-verification split).
"""

import asyncio
from types import SimpleNamespace

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from assistant.compaction import (
    KEEP_TOKENS,
    TRIGGER_TOKENS,
    _find_keep_boundary,
    compact_history_node,
    is_compaction_summary,
    is_genuine_human_turn,
)
from assistant.supervisor import _make_routing_bridge
from assistant.sub_agents import SubAgentWindowMiddleware


def _transfer_tool_message(agent_name: str) -> ToolMessage:
    return ToolMessage(
        content=f"Transferred to {agent_name}.",
        name=f"transfer_to_{agent_name}",
        tool_call_id=f"call_{agent_name}",
    )


def test_is_genuine_human_turn_excludes_routing_bridge() -> None:
    """The Phase 6 routing bridge is a HumanMessage too — compaction must
    not treat it as a real turn boundary, or it could split a multi-hop
    turn's own mid-turn re-entry into "kept" vs "summarized" halves,
    orphaning tool_use blocks the same way STEPS.md 36's original bug did."""
    assert not is_genuine_human_turn(_make_routing_bridge())
    assert is_genuine_human_turn(HumanMessage(content="a real user message"))


def test_is_compaction_summary_detects_tagged_message_only() -> None:
    tagged = HumanMessage(
        content="[Summary of earlier conversation: ...]",
        additional_kwargs={"phase7_compaction_summary": True},
    )
    untagged = HumanMessage(content="a normal message")
    assert is_compaction_summary(tagged)
    assert not is_compaction_summary(untagged)


def test_find_keep_boundary_never_splits_mid_turn() -> None:
    """Only genuine HumanMessage indices are valid split points — never
    between an AIMessage and its ToolMessage results, which would leave an
    orphaned tool_use block (STEPS.md 36) on the next Anthropic API call."""
    messages = [
        HumanMessage(content="turn 1"),
        AIMessage(content="", tool_calls=[{"name": "x", "args": {}, "id": "c1"}]),
        ToolMessage(content="result", name="x", tool_call_id="c1"),
        AIMessage(content="turn 1 answer"),
        HumanMessage(content="turn 2"),
        AIMessage(content="turn 2 answer"),
    ]
    boundary = _find_keep_boundary(messages)
    assert boundary in (0, 4), f"boundary {boundary} does not land on a HumanMessage turn start"
    assert isinstance(messages[boundary], HumanMessage)


def test_find_keep_boundary_falls_back_to_most_recent_turn_when_oversized() -> None:
    """Even if the single most recent turn alone exceeds KEEP_TOKENS, the
    boundary must still land there — the turn currently being responded to
    is never summarized away."""
    huge_content = "x" * (KEEP_TOKENS * 10)  # far larger than KEEP_TOKENS alone
    messages = [
        HumanMessage(content="old turn"),
        AIMessage(content="old answer"),
        HumanMessage(content=huge_content),
    ]
    boundary = _find_keep_boundary(messages)
    assert boundary == 2
    assert messages[boundary].content == huge_content


def test_compact_history_node_is_noop_under_trigger() -> None:
    """No live model call should happen at all when history is small — this
    is what keeps compaction cheap on ordinary short conversations."""
    small_history = [HumanMessage(content="hi"), AIMessage(content="hello")]
    result = compact_history_node({"messages": small_history})
    assert result == {}


def test_compact_history_node_noop_when_nothing_safe_to_summarize() -> None:
    """A single oversized turn with no earlier turn to fall back to must be
    let through uncompacted rather than mangled."""
    huge_content = "x" * (TRIGGER_TOKENS * 10)
    messages = [HumanMessage(content=huge_content)]
    result = compact_history_node({"messages": messages})
    assert result == {}


def _fake_model_request(messages: list) -> SimpleNamespace:
    def override(**overrides):
        merged = SimpleNamespace(messages=messages)
        merged.__dict__.update(overrides)
        return merged

    return SimpleNamespace(messages=messages, override=override)


def _handoff_call_pair(agent_name: str) -> list:
    """The realistic AIMessage(tool_use) + ToolMessage(tool_result) pair a
    supervisor handoff actually produces (supervisor.py's _make_handoff_tool)
    — needed so windowing tests exercise the real tool_use/tool_result
    pairing constraint, not a simplified fixture that hides it."""
    call_id = f"call_{agent_name}"
    return [
        AIMessage(
            content="",
            tool_calls=[{"name": f"transfer_to_{agent_name}", "args": {}, "id": call_id}],
        ),
        ToolMessage(
            content=f"Transferred to {agent_name}.",
            name=f"transfer_to_{agent_name}",
            tool_call_id=call_id,
        ),
    ]


def test_sub_agent_window_middleware_excludes_past_turn_but_keeps_current_turn() -> None:
    """Regression test for STEPS.md 48's context-leakage bug: a specialist
    must not see an EARLIER, UNRELATED top-level turn's supervisor using a
    transfer_to_* tool it doesn't have — this is the actual mechanism that
    caused research_agent to hallucinate a transfer_to_coding_agent call
    after seeing one planted example from a prior turn (reproduced 1-in-3
    in isolation).

    Also a regression test for the over-correction a first version of this
    middleware introduced, caught by live end-to-end verification: it
    windowed to "since THIS agent's own handoff" specifically, which cut off
    the original request and an earlier specialist's findings on a genuine
    multi-hop chain within the SAME turn (research_agent -> coding_agent),
    leaving the second specialist with no idea what to do. Turn-boundary
    windowing must exclude the former while preserving the latter."""
    messages = [
        HumanMessage(content="an earlier, unrelated request"),
        *_handoff_call_pair("coding_agent"),  # planted leakage source — PAST turn
        AIMessage(content="coding_agent's answer to the old request"),
        HumanMessage(content="a brand new request"),  # <- current turn starts here
        *_handoff_call_pair("research_agent"),
        AIMessage(content="research_agent's findings, needed by the next specialist"),
        *_handoff_call_pair("coding_agent"),  # second specialist, SAME turn — legitimate
    ]
    middleware = SubAgentWindowMiddleware()
    request = _fake_model_request(messages)

    captured = {}

    async def handler(req):
        captured["messages"] = req.messages
        return None

    asyncio.run(middleware.awrap_model_call(request, handler))

    windowed = captured["messages"]
    assert windowed == messages[4:], (
        "window must start at the current turn's HumanMessage, keeping "
        "everything from the current multi-hop chain"
    )
    assert isinstance(windowed[0], HumanMessage), "must not orphan any tool_result"
    assert "research_agent's findings" in str(windowed[3].content), (
        "the prior specialist's findings within THIS turn must stay visible "
        "to the next specialist in the chain"
    )
    assert not any(
        "old request" in str(m.content) for m in windowed if hasattr(m, "content")
    ), "content from the earlier, unrelated turn must not leak in"


def test_sub_agent_window_middleware_preserves_compaction_summary() -> None:
    """A specialist handed a sub-task deep into an already-compacted thread
    must still see the running summary at index 0 — otherwise it loses all
    awareness of the wider conversation just because it wasn't the one
    running earlier turns."""
    summary = HumanMessage(
        content="[Summary of earlier conversation: user is planning a trip.]",
        additional_kwargs={"phase7_compaction_summary": True},
    )
    messages = [
        summary,
        AIMessage(content="continuing after compaction"),
        HumanMessage(content="book the flight"),
        *_handoff_call_pair("life_admin_agent"),
    ]
    middleware = SubAgentWindowMiddleware()
    request = _fake_model_request(messages)

    captured = {}

    async def handler(req):
        captured["messages"] = req.messages
        return None

    asyncio.run(middleware.awrap_model_call(request, handler))

    windowed = captured["messages"]
    assert windowed[0] is summary
    assert windowed[1:] == messages[2:], "must window to the turn boundary, then re-prepend the summary"
    tool_use_ids = {
        c["id"] if isinstance(c, dict) else c.id
        for m in windowed
        for c in (getattr(m, "tool_calls", None) or [])
    }
    tool_result_ids = {m.tool_call_id for m in windowed if isinstance(m, ToolMessage)}
    assert tool_result_ids <= tool_use_ids, "must not orphan any tool_result"


if __name__ == "__main__":
    test_is_genuine_human_turn_excludes_routing_bridge()
    print("OK: test_is_genuine_human_turn_excludes_routing_bridge")
    test_is_compaction_summary_detects_tagged_message_only()
    print("OK: test_is_compaction_summary_detects_tagged_message_only")
    test_find_keep_boundary_never_splits_mid_turn()
    print("OK: test_find_keep_boundary_never_splits_mid_turn")
    test_find_keep_boundary_falls_back_to_most_recent_turn_when_oversized()
    print("OK: test_find_keep_boundary_falls_back_to_most_recent_turn_when_oversized")
    test_compact_history_node_is_noop_under_trigger()
    print("OK: test_compact_history_node_is_noop_under_trigger")
    test_compact_history_node_noop_when_nothing_safe_to_summarize()
    print("OK: test_compact_history_node_noop_when_nothing_safe_to_summarize")
    test_sub_agent_window_middleware_excludes_past_turn_but_keeps_current_turn()
    print("OK: test_sub_agent_window_middleware_excludes_past_turn_but_keeps_current_turn")
    test_sub_agent_window_middleware_preserves_compaction_summary()
    print("OK: test_sub_agent_window_middleware_preserves_compaction_summary")
    print("\n8 tests passed")
