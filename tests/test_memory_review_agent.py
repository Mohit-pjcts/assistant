"""Tests for assistant.memory_review_agent — the nightly batch replacement
for the old per-turn, interrupt()-gated extraction node (memory_extraction.
py's now-removed extract_and_propose_memory_node). Runnable directly, same
convention as this project's other test files: propose_facts() is
monkeypatched everywhere (a live model call), real SQLite I/O against temp
files for everything else."""

import asyncio
import tempfile
from pathlib import Path
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, AnyMessage, HumanMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

import assistant.memory_extraction as memory_extraction
import assistant.memory_review_agent as memory_review_agent
import assistant.memory_store as memory_store
import assistant.thread_store as thread_store
from assistant.agent import make_thread_config
from assistant.memory import get_checkpointer
from assistant.memory_extraction import ProposedFact


class _State(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]


async def _noop_node(state: _State) -> dict:
    return {}


async def _seed_thread_history(
    conversation_db_path: Path, thread_id: str, messages: list[AnyMessage]
) -> None:
    """Writes a fake conversation history for `thread_id` directly onto the
    checkpointer, the same channel shape supervisor.py's real GraphState
    uses (`messages`) — mirrors how a real turn would have accumulated
    this, without needing to run the actual multi-agent graph."""
    builder = StateGraph(_State)
    builder.add_node("noop", _noop_node)
    builder.add_edge(START, "noop")
    builder.add_edge("noop", END)
    async with get_checkpointer(conversation_db_path) as checkpointer:
        graph = builder.compile(checkpointer=checkpointer)
        await graph.ainvoke({"messages": messages}, config=make_thread_config(thread_id))


class _FakeMonkeypatch:
    def __init__(self) -> None:
        self._restore: list[tuple[object, str, object]] = []

    def setattr(self, obj: object, name: str, value: object) -> None:
        self._restore.append((obj, name, getattr(obj, name)))
        setattr(obj, name, value)

    def undo(self) -> None:
        for obj, name, original in reversed(self._restore):
            setattr(obj, name, original)


async def test_nightly_review_queues_pending_facts_from_a_new_thread(monkeypatch, tmp_path) -> None:
    conv_db = tmp_path / "conversation.sqlite"
    facts_db = tmp_path / "facts.sqlite"
    threads_db = tmp_path / "threads.sqlite"
    monkeypatch.setattr(memory_store, "DEFAULT_DB_PATH", facts_db)
    monkeypatch.setattr(thread_store, "DEFAULT_DB_PATH", threads_db)

    thread = await thread_store.create_thread(db_path=threads_db)
    await _seed_thread_history(
        conv_db, thread.id, [HumanMessage(content="I'm vegetarian and I prefer terse answers")]
    )

    async def fake_propose_facts(user_text: str) -> list[ProposedFact]:
        assert "vegetarian" in user_text
        return [ProposedFact(content="user is vegetarian")]

    monkeypatch.setattr(memory_extraction, "propose_facts", fake_propose_facts)

    queued = await memory_review_agent.run_nightly_review(conversation_db_path=str(conv_db))
    assert queued == 1

    pending = await memory_store.list_pending_facts(db_path=facts_db)
    assert len(pending) == 1
    assert pending[0].content == "user is vegetarian"
    assert pending[0].provenance == "nightly review"

    saved = await memory_store.list_facts(db_path=facts_db)
    assert saved == [], "nightly review must never write directly into the real facts table"


async def test_nightly_review_never_rescans_already_processed_turns(monkeypatch, tmp_path) -> None:
    """The cursor's whole point: a second run right after the first must
    not re-propose facts from turns already scanned."""
    conv_db = tmp_path / "conversation.sqlite"
    facts_db = tmp_path / "facts.sqlite"
    threads_db = tmp_path / "threads.sqlite"
    monkeypatch.setattr(memory_store, "DEFAULT_DB_PATH", facts_db)
    monkeypatch.setattr(thread_store, "DEFAULT_DB_PATH", threads_db)

    thread = await thread_store.create_thread(db_path=threads_db)
    await _seed_thread_history(conv_db, thread.id, [HumanMessage(content="I'm vegetarian")])

    calls = []

    async def fake_propose_facts(user_text: str) -> list[ProposedFact]:
        calls.append(user_text)
        return [ProposedFact(content="user is vegetarian")]

    monkeypatch.setattr(memory_extraction, "propose_facts", fake_propose_facts)

    first = await memory_review_agent.run_nightly_review(conversation_db_path=str(conv_db))
    assert first == 1

    second = await memory_review_agent.run_nightly_review(conversation_db_path=str(conv_db))
    assert second == 0, "a repeat run over the same unchanged thread must queue nothing new"
    assert len(calls) == 1, "propose_facts must not be called again with no new turns to scan"


async def test_nightly_review_only_scans_new_turns_on_a_later_run(monkeypatch, tmp_path) -> None:
    """A thread that grew between two nightly runs should only have its NEW
    turn's text sent to extraction the second time."""
    conv_db = tmp_path / "conversation.sqlite"
    facts_db = tmp_path / "facts.sqlite"
    threads_db = tmp_path / "threads.sqlite"
    monkeypatch.setattr(memory_store, "DEFAULT_DB_PATH", facts_db)
    monkeypatch.setattr(thread_store, "DEFAULT_DB_PATH", threads_db)

    thread = await thread_store.create_thread(db_path=threads_db)
    await _seed_thread_history(conv_db, thread.id, [HumanMessage(content="first turn: I like tea")])

    calls = []

    async def fake_propose_facts(user_text: str) -> list[ProposedFact]:
        calls.append(user_text)
        return []

    monkeypatch.setattr(memory_extraction, "propose_facts", fake_propose_facts)
    await memory_review_agent.run_nightly_review(conversation_db_path=str(conv_db))
    assert calls == ["first turn: I like tea"]

    # A day later: the same thread grew by one more genuine human turn plus
    # an AI reply in between.
    await _seed_thread_history(
        conv_db,
        thread.id,
        [AIMessage(content="noted"), HumanMessage(content="second turn: I'm left-handed")],
    )
    await memory_review_agent.run_nightly_review(conversation_db_path=str(conv_db))
    assert calls == ["first turn: I like tea", "second turn: I'm left-handed"]


async def test_nightly_review_skips_a_thread_with_nothing_new(monkeypatch, tmp_path) -> None:
    conv_db = tmp_path / "conversation.sqlite"
    facts_db = tmp_path / "facts.sqlite"
    threads_db = tmp_path / "threads.sqlite"
    monkeypatch.setattr(memory_store, "DEFAULT_DB_PATH", facts_db)
    monkeypatch.setattr(thread_store, "DEFAULT_DB_PATH", threads_db)

    # A thread registered but with no checkpointed conversation at all yet.
    await thread_store.create_thread(db_path=threads_db)

    async def fake_propose_facts(user_text: str) -> list[ProposedFact]:
        raise AssertionError("propose_facts must not be called for a thread with no history")

    monkeypatch.setattr(memory_extraction, "propose_facts", fake_propose_facts)
    queued = await memory_review_agent.run_nightly_review(conversation_db_path=str(conv_db))
    assert queued == 0


if __name__ == "__main__":
    for async_test in (
        test_nightly_review_queues_pending_facts_from_a_new_thread,
        test_nightly_review_never_rescans_already_processed_turns,
        test_nightly_review_only_scans_new_turns_on_a_later_run,
        test_nightly_review_skips_a_thread_with_nothing_new,
    ):
        with tempfile.TemporaryDirectory() as tmp:
            mp = _FakeMonkeypatch()
            try:
                asyncio.run(async_test(mp, Path(tmp)))
                print(f"OK: {async_test.__name__}")
            finally:
                mp.undo()

    print("\n4 tests passed")
