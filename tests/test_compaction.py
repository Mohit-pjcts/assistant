"""Tests for assistant.compaction — Phase 7 Part A (short-term compaction).

Runnable directly, matching tests/test_supervisor.py's convention: the
deterministic boundary-finding logic is unit-tested here without a live API
call; the live-model behavior this module depends on (compaction actually
firing and shrinking a real thread) was verified against the real model in
throwaway spike scripts and is recorded in STEPS.md, not re-proven here on
every run.

The old `SubAgentWindowMiddleware` tests that used to live here moved to
tests/test_supervisor.py as `_context_prefix_messages()` tests — under the
agents-as-tools rewrite (supervisor.py), forwarding context into a specialist
call is that module's job now, not a sub_agents.py middleware (see
sub_agents.py's module docstring for why the middleware was removed rather
than kept as redundant defense). The old Phase 6 routing-bridge marker this
module's `is_genuine_human_turn` used to also exclude no longer exists —
that mechanism was removed along with the Command-handoff loop-back it
supported.
"""

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from assistant.compaction import (
    KEEP_TOKENS,
    TRIGGER_TOKENS,
    _find_keep_boundary,
    compact_history_node,
    is_compaction_summary,
    is_genuine_human_turn,
    is_recalled_facts_message,
    tag_recalled_facts,
)


def test_is_genuine_human_turn_excludes_recalled_facts_message() -> None:
    """Phase 7 Part B's recalled-facts injection is a HumanMessage too —
    compaction (and, post-rewrite, supervisor.py's turn-boundary lookups)
    must not treat it as a real turn boundary."""
    recalled = HumanMessage(content="[Known facts about the user: ...]")
    tag_recalled_facts(recalled)
    assert not is_genuine_human_turn(recalled)
    assert is_genuine_human_turn(HumanMessage(content="a real user message"))


def test_is_recalled_facts_message_detects_tagged_message_only() -> None:
    tagged = HumanMessage(content="[Known facts about the user: ...]")
    tag_recalled_facts(tagged)
    untagged = HumanMessage(content="a normal message")
    assert is_recalled_facts_message(tagged)
    assert not is_recalled_facts_message(untagged)


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


if __name__ == "__main__":
    test_is_genuine_human_turn_excludes_recalled_facts_message()
    print("OK: test_is_genuine_human_turn_excludes_recalled_facts_message")
    test_is_recalled_facts_message_detects_tagged_message_only()
    print("OK: test_is_recalled_facts_message_detects_tagged_message_only")
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
    print("\n7 tests passed")
