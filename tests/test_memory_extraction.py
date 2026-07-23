"""Tests for assistant.memory_extraction — Phase 7 Part B's security-gated
extraction, citation, and confirmation flow (STEPS.md 50.2's locked design).

Runnable directly, matching tests/test_interrupts.py's convention for the
interrupt/resume mechanic (a minimal graph wrapping the node under test) and
tests/test_supervisor.py's convention for deterministic mechanism testing
without a live API call. propose_facts() itself makes a live model call —
monkeypatched here everywhere except the dedicated live verification
(recorded in STEPS.md, not re-proven on every run, same rationale as the
other test files in this project)."""

import asyncio
import tempfile
import uuid
from pathlib import Path
from typing import TypedDict

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

import assistant.memory_extraction as memory_extraction
import assistant.memory_store as memory_store
from assistant.memory import get_checkpointer
from assistant.memory_extraction import (
    ProposedFact,
    _cap_proposed_facts,
    _current_turn_user_text,
    _most_recent_tool_result_this_turn,
    extract_and_propose_memory_node,
)


def test_current_turn_user_text_is_source_restricted() -> None:
    """(A): the entire trust boundary. Must include ONLY genuine user
    HumanMessage text from the CURRENT turn — never tool content, AI
    content, a past turn's user text, or the recalled-facts synthetic
    message, which is also technically a HumanMessage."""
    recalled = HumanMessage(content="[Known facts about the user: irrelevant]")
    recalled.additional_kwargs["phase7_recalled_facts"] = True

    messages = [
        HumanMessage(content="an earlier, unrelated turn's message"),
        AIMessage(content="an old answer"),
        HumanMessage(content="I'm vegetarian and I prefer terse answers"),  # current turn
        recalled,
        ToolMessage(content="secret tool content that must never appear", name="tavily_search", tool_call_id="x"),
        AIMessage(content="an AI response that must never appear"),
    ]
    text = _current_turn_user_text(messages)
    assert text == "I'm vegetarian and I prefer terse answers"
    assert "secret tool content" not in text
    assert "AI response" not in text
    assert "unrelated turn" not in text
    assert "Known facts" not in text


def test_most_recent_tool_result_returns_the_latest_this_turn() -> None:
    """(D)'s only source of tool content. Post-rewrite (agents-as-tools,
    supervisor.py), every ToolMessage this turn is real, data-bearing
    content — a specialist call's own final text answer, not a bare
    transfer_to_* handoff marker (that mechanism no longer exists) — so
    this just confirms the MOST RECENT one wins."""
    messages = [
        HumanMessage(content="remember my flight number from that email"),
        ToolMessage(content="Searched, found one match", name="life_admin_agent", tool_call_id="a"),
        ToolMessage(content="Flight AA123, departs 9am", name="life_admin_agent", tool_call_id="b"),
    ]
    result = _most_recent_tool_result_this_turn(messages)
    assert result is not None
    assert "AA123" in result.content


def test_most_recent_tool_result_returns_none_when_nothing_real_exists() -> None:
    messages = [HumanMessage(content="remember X from that email")]
    assert _most_recent_tool_result_this_turn(messages) is None


def test_cap_proposed_facts_enforces_structural_limit() -> None:
    """Rate cap (red-team addition): never more than
    MAX_MEMORY_WRITES_PER_TURN, regardless of what the extraction model
    proposes — a structural guard, not left to the model's own judgment."""
    facts = [ProposedFact(content=f"fact {i}") for i in range(10)]
    capped = _cap_proposed_facts(facts)
    assert len(capped) == memory_extraction.MAX_MEMORY_WRITES_PER_TURN


def _build_extract_graph(checkpointer):
    class State(TypedDict):
        messages: list

    builder = StateGraph(State)
    builder.add_node("extract", extract_and_propose_memory_node)
    builder.add_edge(START, "extract")
    builder.add_edge("extract", END)
    return builder.compile(checkpointer=checkpointer)


async def test_only_approved_facts_are_persisted_verbatim(monkeypatch) -> None:
    """(C) + TOCTOU requirement: each proposed fact gets its own
    confirmation; only approved ones are saved, and saved with EXACTLY the
    string shown at confirmation — no re-extraction in between."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        checkpoint_db = Path(tmp) / "checkpoint.sqlite"
        monkeypatch.setattr(memory_store, "DEFAULT_DB_PATH", db_path)

        async def fake_propose_facts(user_text: str) -> list[ProposedFact]:
            return [
                ProposedFact(content="user prefers terse responses"),
                ProposedFact(content="user is vegetarian"),
            ]

        monkeypatch.setattr(memory_extraction, "propose_facts", fake_propose_facts)

        async with get_checkpointer(checkpoint_db) as checkpointer:
            graph = _build_extract_graph(checkpointer)
            config = {"configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}}

            result = await graph.ainvoke(
                {"messages": [HumanMessage(content="I prefer terse answers, I'm vegetarian")]},
                config=config,
            )
            assert "__interrupt__" in result
            payload_1 = result["__interrupt__"][0].value
            assert payload_1["fact"] == "user prefers terse responses"
            assert payload_1["voice_approvable"] is False

            result = await graph.ainvoke(Command(resume=True), config=config)  # approve fact 1
            assert "__interrupt__" in result
            payload_2 = result["__interrupt__"][0].value
            assert payload_2["fact"] == "user is vegetarian"

            result = await graph.ainvoke(Command(resume=False), config=config)  # decline fact 2
            assert "__interrupt__" not in result

        saved = await memory_store.list_facts(db_path=db_path)
        assert len(saved) == 1
        assert saved[0].content == "user prefers terse responses"


async def test_uncited_claim_is_refused_without_ever_asking_for_confirmation(monkeypatch) -> None:
    """(D) hardening: if the extraction model claims cites_tool_result=True
    but no real tool result exists this turn to back it, the fact must be
    refused outright — not silently saved without its claimed citation, and
    not even surfaced for confirmation."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        checkpoint_db = Path(tmp) / "checkpoint.sqlite"
        monkeypatch.setattr(memory_store, "DEFAULT_DB_PATH", db_path)

        async def fake_propose_facts(user_text: str) -> list[ProposedFact]:
            return [ProposedFact(content="flight number AA123", cites_tool_result=True)]

        monkeypatch.setattr(memory_extraction, "propose_facts", fake_propose_facts)

        async with get_checkpointer(checkpoint_db) as checkpointer:
            graph = _build_extract_graph(checkpointer)
            config = {"configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}}

            result = await graph.ainvoke(
                {"messages": [HumanMessage(content="remember the flight number from that email")]},
                config=config,
            )
            assert "__interrupt__" not in result, (
                "an uncited citation claim must never reach the confirmation gate"
            )

        saved = await memory_store.list_facts(db_path=db_path)
        assert saved == []


async def test_real_citation_is_attached_with_provenance(monkeypatch) -> None:
    """(D): when a real tool result exists this turn, its content — never
    the model's own unverifiable claim about it — becomes the provenance
    shown at the confirmation gate."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "facts.sqlite"
        checkpoint_db = Path(tmp) / "checkpoint.sqlite"
        monkeypatch.setattr(memory_store, "DEFAULT_DB_PATH", db_path)

        async def fake_propose_facts(user_text: str) -> list[ProposedFact]:
            return [ProposedFact(content="user's flight is AA123", cites_tool_result=True)]

        monkeypatch.setattr(memory_extraction, "propose_facts", fake_propose_facts)

        async with get_checkpointer(checkpoint_db) as checkpointer:
            graph = _build_extract_graph(checkpointer)
            config = {"configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}}

            messages = [
                HumanMessage(content="remember the flight number from that email"),
                ToolMessage(content="Flight AA123, departs 9am", name="search_emails", tool_call_id="x"),
            ]
            result = await graph.ainvoke({"messages": messages}, config=config)
            assert "__interrupt__" in result
            payload = result["__interrupt__"][0].value
            assert payload["provenance"] is not None
            assert "search_emails" in payload["provenance"]
            assert "AA123" in payload["provenance"]

            await graph.ainvoke(Command(resume=True), config=config)

        saved = await memory_store.list_facts(db_path=db_path)
        assert len(saved) == 1
        assert saved[0].provenance is not None
        assert "search_emails" in saved[0].provenance


async def test_no_facts_proposed_is_a_clean_noop(monkeypatch) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        checkpoint_db = Path(tmp) / "checkpoint.sqlite"

        async def fake_propose_facts(user_text: str) -> list[ProposedFact]:
            return []

        monkeypatch.setattr(memory_extraction, "propose_facts", fake_propose_facts)

        async with get_checkpointer(checkpoint_db) as checkpointer:
            graph = _build_extract_graph(checkpointer)
            config = {"configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}}
            result = await graph.ainvoke(
                {"messages": [HumanMessage(content="what's 2+2?")]}, config=config
            )
            assert "__interrupt__" not in result


class _FakeMonkeypatch:
    """Minimal monkeypatch substitute — this project's tests run as plain
    scripts, not under pytest, so pytest's `monkeypatch` fixture isn't
    available. Mirrors just the setattr/undo behavior these tests need."""

    def __init__(self) -> None:
        self._restore: list[tuple[object, str, object]] = []

    def setattr(self, obj: object, name: str, value: object) -> None:
        self._restore.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    def undo(self) -> None:
        for obj, name, original in reversed(self._restore):
            setattr(obj, name, original)


if __name__ == "__main__":
    test_current_turn_user_text_is_source_restricted()
    print("OK: test_current_turn_user_text_is_source_restricted")
    test_most_recent_tool_result_returns_the_latest_this_turn()
    print("OK: test_most_recent_tool_result_returns_the_latest_this_turn")
    test_most_recent_tool_result_returns_none_when_nothing_real_exists()
    print("OK: test_most_recent_tool_result_returns_none_when_nothing_real_exists")
    test_cap_proposed_facts_enforces_structural_limit()
    print("OK: test_cap_proposed_facts_enforces_structural_limit")

    for async_test in (
        test_only_approved_facts_are_persisted_verbatim,
        test_uncited_claim_is_refused_without_ever_asking_for_confirmation,
        test_real_citation_is_attached_with_provenance,
        test_no_facts_proposed_is_a_clean_noop,
    ):
        mp = _FakeMonkeypatch()
        try:
            asyncio.run(async_test(mp))
            print(f"OK: {async_test.__name__}")
        finally:
            mp.undo()

    print("\n8 tests passed")
