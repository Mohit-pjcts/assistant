"""A-Z flow tests: the supervisor's OWN vault tools and the research_agent
specialist, exercised through the same real supervisor wiring they use in
production (build_obsidian_tools / _make_specialist_tool inside a LangGraph
ToolNode with a checkpointer), offline — a tempdir stands in for the real
~/Documents/OniVault, semantic search is stubbed (no ML, no network), and
research_agent's model call is a stub. Live runs are recorded in STEPS.md.
"""

import asyncio
import tempfile
import uuid
from pathlib import Path
from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode

from assistant import activity_log
from assistant import obsidian_tools
from assistant import supervisor as sup
from assistant import vault_search
from assistant.memory import get_checkpointer


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "OniVault"
    monkeypatch.setattr(obsidian_tools, "VAULT_DIR", root)
    monkeypatch.setattr(vault_search, "VAULT_DIR", root)
    monkeypatch.setattr(vault_search, "semantic_search", lambda *a, **k: [])
    monkeypatch.setattr(activity_log, "DEFAULT_DB_PATH", tmp_path / "activity.sqlite")
    return root


def _graph(checkpointer, extra_tools=()):
    builder = StateGraph(sup.GraphState)
    builder.add_node("tools", ToolNode([*obsidian_tools.build_obsidian_tools(), *extra_tools]))
    builder.add_edge(START, "tools")
    builder.add_edge("tools", END)
    return builder.compile(checkpointer=checkpointer)


async def _call(tool_name: str, args: dict[str, Any], *, extra_tools=()) -> Any:
    thread_id = str(uuid.uuid4())
    turn = {
        "messages": [
            HumanMessage(content="please do it"),
            AIMessage(
                content="",
                tool_calls=[{"name": tool_name, "args": args, "id": "call-1", "type": "tool_call"}],
            ),
        ]
    }
    with tempfile.TemporaryDirectory() as tmp:
        async with get_checkpointer(Path(tmp) / "scratch.sqlite") as checkpointer:
            config = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}
            result = await _graph(checkpointer, extra_tools).ainvoke(turn, config=config)
            assert "__interrupt__" not in result, "vault and research calls never ask for confirmation"
            return result["messages"][-1].content


def test_a_note_written_through_the_supervisor_path_lands_on_disk(vault):
    out = asyncio.run(_call("write_vault_note", {
        "title": "Backstage A-Z findings",
        "content": "The fast lane was silently off in 53 of 92 sampled runs.",
    }))
    assert "Backstage A-Z findings" in out and "Error" not in out
    notes = list(vault.rglob("*.md"))
    assert len(notes) == 1
    text = notes[0].read_text()
    assert "53 of 92" in text and "created:" in text  # frontmatter added automatically


def test_search_finds_a_passage_anywhere_in_a_note(vault):
    asyncio.run(_call("write_vault_note", {
        "title": "Speed plan",
        "content": "Verify is 21.5% of wall time and stays: it is the false-done guard.",
    }))
    out = asyncio.run(_call("search_vault", {"query": "false-done"}))
    assert "21.5%" in out and "Error" not in out


def test_a_duplicate_title_is_refused_not_clobbered(vault):
    args = {"title": "Speed plan", "content": "first"}
    asyncio.run(_call("write_vault_note", args))
    out = asyncio.run(_call("write_vault_note", {"title": "Speed plan", "content": "second"}))
    assert "already exists" in out and "update_vault_note" in out
    assert "first" in next(vault.rglob("*.md")).read_text()


def test_research_agent_runs_ungated_and_its_answer_is_relayed(vault, tmp_path, monkeypatch):
    async def answered(messages, pre_approved_actions):
        return sup.SpecialistResult("Cua 0.38 is current", [], [], [])

    research = sup._make_specialist_tool("research_agent", "test", answered)
    out = asyncio.run(_call("research_agent", {"request": "is Cua 0.38 out?"}, extra_tools=[research]))
    assert out == "Cua 0.38 is current"
    events = asyncio.run(activity_log.list_recent(db_path=tmp_path / "activity.sqlite"))
    assert [(e.agent, e.outcome) for e in events] == [("research_agent", activity_log.OUTCOME_SUCCESS)]


def test_research_agent_owns_no_gated_actions():
    assert not any("research" in key for key in sup.GATED_ACTIONS)
