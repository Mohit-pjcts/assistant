"""Tests for assistant.memory_extraction — Phase 7 Part B, re-architected
2026-07-28: recall (gated to a thread's first genuine turn only) plus the
shared extraction primitives memory_review_agent.py's nightly batch pass
builds on. The old interrupt()-gated, citation-verifying
extract_and_propose_memory_node is gone — see tests/test_memory_review_agent.py
for its replacement's own tests.

Runnable directly, matching tests/test_interrupts.py's convention for the
interrupt/resume mechanic (used here only for recall_memory_node, which
still runs inside the live graph) and tests/test_supervisor.py's convention
for deterministic mechanism testing without a live API call. propose_facts()
itself makes a live model call — monkeypatched here, same rationale as the
other test files in this project."""

import asyncio
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, AnyMessage, HumanMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

import assistant.memory_extraction as memory_extraction
import assistant.memory_store as memory_store
from assistant.memory_extraction import (
    ProposedFact,
    _cap_proposed_facts,
    _is_first_genuine_turn,
    recall_memory_node,
    text_only_content,
)


def test_text_only_content_strips_multimodal_blocks() -> None:
    """A file-upload turn can put an image data block on a genuine
    HumanMessage — extraction must only ever see the text parts, never the
    base64 blob (server.py's _render_content has the same requirement)."""
    content = [
        {"type": "text", "text": "remember I'm allergic to shellfish"},
        {"type": "image", "source": {"type": "base64", "data": "verylongbase64blob..."}},
    ]
    assert text_only_content(content) == "remember I'm allergic to shellfish"


def test_cap_proposed_facts_enforces_structural_limit() -> None:
    """Rate cap (red-team addition): never more than
    MAX_PROPOSED_FACTS_PER_CALL, regardless of what the extraction model
    proposes — a structural guard, not left to the model's own judgment."""
    facts = [ProposedFact(content=f"fact {i}") for i in range(10)]
    capped = _cap_proposed_facts(facts)
    assert len(capped) == memory_extraction.MAX_PROPOSED_FACTS_PER_CALL


def test_is_first_genuine_turn_true_only_for_the_opening_message() -> None:
    """Recall now fires once per thread (its own first genuine turn), not
    on every turn — the user's explicit direction that repeating the known-
    facts block on every message was wasted tokens/noise."""
    assert _is_first_genuine_turn([HumanMessage(content="hello")]) is True
    assert (
        _is_first_genuine_turn(
            [
                HumanMessage(content="hello"),
                AIMessage(content="hi there"),
                HumanMessage(content="second message"),
            ]
        )
        is False
    )


def _build_recall_graph(checkpointer):
    class State(TypedDict):
        messages: Annotated[list[AnyMessage], add_messages]

    builder = StateGraph(State)
    builder.add_node("recall", recall_memory_node)
    builder.add_edge(START, "recall")
    builder.add_edge("recall", END)
    return builder.compile(checkpointer=checkpointer)


async def test_recall_fires_on_a_threads_first_turn(monkeypatch, tmp_path) -> None:
    db_path = tmp_path / "facts.sqlite"
    monkeypatch.setattr(memory_store, "DEFAULT_DB_PATH", db_path)
    await memory_store.save_fact("user is vegetarian", db_path=db_path)

    graph = _build_recall_graph(checkpointer=None)
    result = await graph.ainvoke({"messages": [HumanMessage(content="what should I eat?")]})
    messages = result["messages"]
    assert len(messages) == 2
    assert "vegetarian" in messages[-1].content


async def test_recall_returns_the_full_profile_even_when_the_opener_shares_no_keywords(
    monkeypatch, tmp_path
) -> None:
    """A real bug found live (2026-07-28): a thread's first message is very
    often a low-content greeting ("hi") that shares no keyword with
    anything in the store — memory_store.recall_facts' keyword scoring
    would silently return nothing once the store grows past its own
    small-store threshold, even with directly relevant facts sitting right
    there (a real live reproduction: asking to text a saved contact, right
    after "hi" opened the thread, got zero memory context). Fixed by
    loading the full profile (memory_store.list_facts) on the one-time
    first-turn injection instead of keyword-matching the opener."""
    db_path = tmp_path / "facts.sqlite"
    monkeypatch.setattr(memory_store, "DEFAULT_DB_PATH", db_path)
    # More than recall_facts' _SMALL_STORE_THRESHOLD (5) so its keyword
    # filtering would actually kick in, unlike the small-store test above.
    for i in range(6):
        await memory_store.save_fact(f"filler fact {i} about nothing relevant", db_path=db_path)
    await memory_store.save_fact(
        "Rishabh's WhatsApp number is +919999999999", db_path=db_path
    )

    graph = _build_recall_graph(checkpointer=None)
    result = await graph.ainvoke({"messages": [HumanMessage(content="hi")]})
    recalled_content = result["messages"][-1].content
    assert "Rishabh" in recalled_content, (
        "the opening greeting shares no keyword with the Rishabh fact, but the "
        "one-time first-turn injection must still include it"
    )


async def test_recall_is_a_noop_on_a_threads_second_turn(monkeypatch, tmp_path) -> None:
    """The actual point of this rewrite: a later turn in the same thread
    must NOT get the known-facts block re-injected — it's a clean no-op."""
    db_path = tmp_path / "facts.sqlite"
    monkeypatch.setattr(memory_store, "DEFAULT_DB_PATH", db_path)
    await memory_store.save_fact("user is vegetarian", db_path=db_path)

    graph = _build_recall_graph(checkpointer=None)
    state = {
        "messages": [
            HumanMessage(content="first turn"),
            AIMessage(content="ok"),
            HumanMessage(content="second turn, what should I eat?"),
        ]
    }
    result = await graph.ainvoke(state)
    assert len(result["messages"]) == 3, "a no-op must not append the recalled-facts message"


async def test_recall_is_a_noop_when_nothing_is_stored(monkeypatch, tmp_path) -> None:
    db_path = tmp_path / "empty_facts.sqlite"
    monkeypatch.setattr(memory_store, "DEFAULT_DB_PATH", db_path)

    graph = _build_recall_graph(checkpointer=None)
    result = await graph.ainvoke({"messages": [HumanMessage(content="anything")]})
    assert len(result["messages"]) == 1, "a no-op must not append the recalled-facts message"


if __name__ == "__main__":
    import tempfile
    from pathlib import Path

    test_text_only_content_strips_multimodal_blocks()
    print("OK: test_text_only_content_strips_multimodal_blocks")
    test_cap_proposed_facts_enforces_structural_limit()
    print("OK: test_cap_proposed_facts_enforces_structural_limit")
    test_is_first_genuine_turn_true_only_for_the_opening_message()
    print("OK: test_is_first_genuine_turn_true_only_for_the_opening_message")

    class _FakeMonkeypatch:
        def __init__(self) -> None:
            self._restore: list[tuple[object, str, object]] = []

        def setattr(self, obj: object, name: str, value: object) -> None:
            self._restore.append((obj, name, getattr(obj, name)))
            setattr(obj, name, value)

        def undo(self) -> None:
            for obj, name, original in reversed(self._restore):
                setattr(obj, name, original)

    for async_test in (
        test_recall_fires_on_a_threads_first_turn,
        test_recall_returns_the_full_profile_even_when_the_opener_shares_no_keywords,
        test_recall_is_a_noop_on_a_threads_second_turn,
        test_recall_is_a_noop_when_nothing_is_stored,
    ):
        with tempfile.TemporaryDirectory() as tmp:
            mp = _FakeMonkeypatch()
            try:
                asyncio.run(async_test(mp, Path(tmp)))
                print(f"OK: {async_test.__name__}")
            finally:
                mp.undo()

    print("\n7 tests passed")
