"""GuardedParallelReads (assistant/parallel_guard.py): parallel pure reads, everything else serial.

The property that matters: a gated or side-effecting call is never executed alongside another call,
because server.py's /resume relays only the first pending interrupt of a turn. A dropped call must also
disappear from the stored AIMessage (both `tool_calls` and the `tool_use` content block), and must be
re-issuable on the next turn."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from assistant.parallel_guard import (
    PARALLEL_SAFE_TOOLS,
    GuardedParallelReads,
    calls_to_keep,
    trim_message,
)
from assistant.supervisor import GATED_ACTIONS


def _ai(*names: str) -> AIMessage:
    calls = [{"name": n, "args": {"x": i}, "id": f"id{i}", "type": "tool_call"} for i, n in enumerate(names)]
    content = [{"type": "thinking", "thinking": "t", "signature": "s"}, {"type": "text", "text": "ok"}]
    content += [{"type": "tool_use", "id": c["id"], "name": c["name"], "input": c["args"]} for c in calls]
    return AIMessage(content=content, tool_calls=calls)


def _names(m: AIMessage) -> list[str]:
    return [c["name"] for c in m.tool_calls]


def _use_blocks(m: AIMessage) -> list[str]:
    return [b["id"] for b in m.content if isinstance(b, dict) and b.get("type") == "tool_use"]


def test_reads_run_together():
    m = _ai("search_vault", "read_vault_note", "read_vault_note")
    assert trim_message(m) is m  # nothing cut, same object


@pytest.mark.parametrize("first", ["life_admin_agent", "mac_control_agent", "request_gated_action_confirmation",
                                   "propose_workflow", "write_vault_note", "backstage", "research_agent"])
def test_a_non_read_first_call_runs_alone(first):
    out = trim_message(_ai(first, "read_vault_note", "search_vault"))
    assert _names(out) == [first]
    assert _use_blocks(out) == ["id0"]


def test_leading_reads_are_kept_and_the_first_non_read_is_dropped_with_everything_after():
    out = trim_message(_ai("search_vault", "read_vault_note", "life_admin_agent", "read_vault_note"))
    assert _names(out) == ["search_vault", "read_vault_note"]
    assert _use_blocks(out) == ["id0", "id1"]


def test_dropped_calls_leave_no_orphan_tool_use_block_and_other_content_survives():
    out = trim_message(_ai("mac_control_agent", "life_admin_agent"))
    types = [b["type"] for b in out.content]
    assert types == ["thinking", "text", "tool_use"]  # thinking signature and text untouched
    assert out.content[0]["signature"] == "s"


def test_every_gated_action_owner_and_every_delegation_is_serial():
    assert not (PARALLEL_SAFE_TOOLS & set(GATED_ACTIONS))
    for delegation in ("coding_agent", "research_agent", "life_admin_agent", "mac_control_agent", "phone_agent",
                       "backstage", "onstage", "write_vault_note", "update_vault_note", "delete_vault_note",
                       "request_gated_action_confirmation", "propose_workflow", "form_press", "stop_backstage"):
        assert calls_to_keep([delegation, "search_vault"]) == 1, delegation


def test_calls_to_keep_edge_cases():
    assert calls_to_keep([]) == 0
    assert calls_to_keep(["search_vault"]) == 1
    assert calls_to_keep(["life_admin_agent"]) == 1


def _run(middleware, response):
    request = SimpleNamespace(model_settings={"other": 1})

    async def handler(req):
        handler.seen = dict(req.model_settings)
        return response

    return asyncio.run(middleware.awrap_model_call(request, handler)), handler.seen


def test_middleware_allows_parallel_and_trims_a_model_response_object():
    resp = SimpleNamespace(result=[_ai("life_admin_agent", "mac_control_agent")], structured_response=None)
    out, seen = _run(GuardedParallelReads(), resp)
    assert seen == {"other": 1, "parallel_tool_calls": True}  # merged, not clobbered
    assert _names(out.result[0]) == ["life_admin_agent"]


def test_middleware_trims_a_bare_ai_message_and_ignores_plain_text_replies():
    out, _ = _run(GuardedParallelReads(), _ai("mac_control_agent", "life_admin_agent"))
    assert _names(out) == ["mac_control_agent"]
    plain = AIMessage(content="hello")
    out, _ = _run(GuardedParallelReads(), plain)
    assert out is plain


def test_a_dropped_call_can_be_reissued_next_turn():
    """The kept call's result is all the model sees; the history stays a valid tool_use/tool_result pairing."""
    first = trim_message(_ai("life_admin_agent", "mac_control_agent"))
    history = [HumanMessage(content="do both"), first,
               ToolMessage(content="done", tool_call_id="id0")]
    ids_used = set(_use_blocks(first))
    results = {m.tool_call_id for m in history if isinstance(m, ToolMessage)}
    assert ids_used == results == {"id0"}  # no tool_use without a result, no result without a tool_use
    second = trim_message(_ai("mac_control_agent"))
    assert _names(second) == ["mac_control_agent"]


# --- through a real create_agent graph (fake model, real ToolNode) -------------------------------------


def _agent_run(scripted: list[AIMessage]):
    """Run a real langchain agent graph whose model replays `scripted` and whose tools record execution."""
    from langchain.agents import create_agent
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.outputs import ChatGeneration, ChatResult
    from langchain_core.tools import tool

    ran: list[str] = []
    seen_histories: list[list] = []

    class Scripted(BaseChatModel):
        turn: int = 0

        @property
        def _llm_type(self) -> str:
            return "scripted"

        def bind_tools(self, tools, **kw):  # noqa: ANN001
            return self

        def _generate(self, messages, stop=None, run_manager=None, **kw):  # noqa: ANN001
            seen_histories.append(list(messages))
            msg = scripted[min(self.turn, len(scripted) - 1)]
            self.turn += 1
            return ChatResult(generations=[ChatGeneration(message=msg)])

    @tool
    def search_vault(x: int = 0) -> str:
        """search"""
        ran.append("search_vault")
        return "found"

    @tool
    def read_vault_note(x: int = 0) -> str:
        """read"""
        ran.append("read_vault_note")
        return "note"

    @tool
    def life_admin_agent(x: int = 0) -> str:
        """delegate"""
        ran.append("life_admin_agent")
        return "delegated"

    graph = create_agent(Scripted(), [search_vault, read_vault_note, life_admin_agent], middleware=[GuardedParallelReads()])
    out = asyncio.run(graph.ainvoke({"messages": [HumanMessage(content="go")]}))
    return ran, out["messages"], seen_histories


def test_graph_runs_parallel_reads_in_one_round_trip():
    ran, messages, histories = _agent_run([_ai("search_vault", "read_vault_note"), AIMessage(content="all done")])
    assert sorted(ran) == ["read_vault_note", "search_vault"]
    assert len(histories) == 2  # one model call to plan both reads, one to answer
    assert sum(isinstance(m, ToolMessage) for m in messages) == 2


def test_graph_runs_a_delegation_alone_then_the_model_reissues_the_rest():
    ran, messages, histories = _agent_run(
        [_ai("life_admin_agent", "search_vault"), _ai("search_vault"), AIMessage(content="done")]
    )
    assert ran == ["life_admin_agent", "search_vault"]  # serial: the dropped read ran only when re-issued
    first_ai = next(m for m in messages if isinstance(m, AIMessage) and m.tool_calls)
    assert [c["name"] for c in first_ai.tool_calls] == ["life_admin_agent"]
    assert _use_blocks(first_ai) == ["id0"]
