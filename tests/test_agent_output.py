"""Tests for what the agents' models are asked to return and how a specialist's
reply reaches the supervisor (STEPS.md 158, found while reviewing the History
panel against real data):

- every agent model asks for SUMMARIZED thinking. For claude-sonnet-5 the API's
  default is to omit the reasoning text (thinking blocks come back with an empty
  `thinking` string and just a signature), so without `display: "summarized"`
  the History's thinking toggle would be blank forever. The repair middleware
  stays, and the chat stream must keep ignoring thinking.
- a specialist's final reply is handed to the supervisor as its TEXT blocks
  only. It used to be `str()`ed: 150 of the 193 delegation results in the real
  conversation database were a raw Python repr of a block list, 31 of them
  carrying a thinking block's 5-15k-character signature.

Offline: the models are only constructed (never called) and the specialist
graph is a stub.
"""

from __future__ import annotations

import json
from contextlib import contextmanager

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables.config import var_child_runnable_config

from assistant import sub_agents, thinking_repair
from assistant import supervisor as sup
from assistant.thinking_repair import THINKING_CONFIG, ThinkingBlockRepairMiddleware

SIGNATURE = "EqQBCkYIARgCKkD" + "x" * 8000  # what a real thinking block's signature looks like

# --- summarized thinking ---------------------------------------------------------------


def test_the_shared_thinking_config_asks_for_summarized_adaptive_thinking():
    assert THINKING_CONFIG == {"type": "adaptive", "display": "summarized"}
    assert thinking_repair.THINKING_CONFIG is THINKING_CONFIG


def build_every_agent(monkeypatch) -> dict[str, dict]:
    """Every agent's `create_agent(...)` keyword arguments, by agent name."""
    built: dict[str, dict] = {}

    def fake_create_agent(**kwargs):
        built[kwargs["name"]] = kwargs
        return object()

    monkeypatch.setattr(sub_agents, "create_agent", fake_create_agent)
    monkeypatch.setattr(sup, "create_agent", fake_create_agent)
    sub_agents.build_coding_agent()
    sub_agents.build_research_agent()
    sub_agents.build_life_admin_agent([])
    sub_agents.build_mac_control_agent()
    sub_agents.build_phone_agent()
    sup.build_supervisor(*[object()] * 5)
    return built


def test_every_agent_model_carries_display_summarized(monkeypatch):
    built = build_every_agent(monkeypatch)
    assert set(built) == {
        "supervisor",
        "coding_agent",
        "research_agent",
        "life_admin_agent",
        "mac_control_agent",
        "phone_agent",
    }
    for agent, kwargs in built.items():
        assert kwargs["model"].thinking == {"type": "adaptive", "display": "summarized"}, agent


def test_the_repair_middleware_is_still_on_every_thinking_enabled_model(monkeypatch):
    """Summarized text doesn't remove the bug the repair middleware guards
    against (a streamed block missing its `thinking` key); it only makes it
    rarer. Every model that enables thinking must still carry it."""
    for agent, kwargs in build_every_agent(monkeypatch).items():
        kinds = [type(m) for m in kwargs["middleware"]]
        assert ThinkingBlockRepairMiddleware in kinds, agent


def test_the_chat_stream_and_rendered_replies_still_ignore_thinking_text():
    """With summarized thinking the blocks now carry real text; it must never
    reach the user's chat. server.py's extractors take `type == "text"` only."""
    from assistant import server

    blocks = [
        {"type": "thinking", "thinking": "Let me reason about this.", "signature": "sig"},
        {"type": "text", "text": "The answer is 4."},
    ]
    assert server._extract_token_text(blocks) == "The answer is 4."
    assert server._render_content(blocks) == "The answer is 4."
    only_thinking = [{"type": "thinking", "thinking": "hmm", "signature": "sig"}]
    assert server._extract_token_text(only_thinking) == ""
    assert server._render_content(only_thinking) == ""


# --- the text a specialist hands the supervisor --------------------------------------------


class StubSpecialist:
    """Stands in for a compiled specialist graph: `ainvoke` returns a message
    list whose last message is the specialist's final reply."""

    def __init__(self, final: AIMessage):
        self.final = final

    async def ainvoke(self, payload, config=None):
        return {"messages": [HumanMessage(content="task"), self.final]}


async def hand_over(content) -> sup.SpecialistResult:
    stub = StubSpecialist(AIMessage(content=content))
    return await sup._invoke_agent_graph(stub, "research_agent", [], set())


async def test_thinking_and_text_blocks_reach_the_supervisor_as_the_text_only():
    result = await hand_over(
        [
            {"type": "thinking", "thinking": "Summarized reasoning.", "signature": SIGNATURE},
            {"type": "text", "text": "Here is the answer.", "index": 1},
        ]
    )
    assert result.content == "Here is the answer."
    assert "signature" not in result.content and SIGNATURE not in result.content
    assert "thinking" not in result.content and "{" not in result.content  # not a repr


async def test_several_text_blocks_are_joined_with_newlines():
    result = await hand_over(
        [{"type": "text", "text": "First."}, {"type": "text", "text": "Second."}]
    )
    assert result.content == "First.\nSecond."


async def test_a_string_reply_is_passed_through_unchanged():
    reply = "  Plain text, exactly as written.\n"
    assert (await hand_over(reply)).content == reply


@pytest.mark.parametrize(
    "content",
    [
        [{"type": "thinking", "thinking": "Only reasoning.", "signature": SIGNATURE}],
        [{"type": "thinking", "thinking": "", "signature": SIGNATURE}],
        [{"type": "text", "text": "   \n"}],
        [{"type": "text", "text": ""}],
        [],
    ],
)
async def test_a_reply_with_no_text_at_all_becomes_a_short_marker_not_an_empty_result(content):
    result = await hand_over(content)
    assert result.content == "(the specialist returned no text)"


async def test_the_rest_of_the_result_is_unaffected():
    """Surfaces, phone actions and executed actions still come from the
    specialist's own messages, whatever its final reply looked like."""
    result = await hand_over([{"type": "text", "text": "ok"}])
    assert (result.surfaces, result.phone_actions, result.executed_actions) == ([], [], [])


# --- the same rule on the HTTP research path ------------------------------------------------


class FakeResponse:
    def __init__(self, lines):
        self._lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def raise_for_status(self):
        pass

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class FakeHttpClient:
    lines: list[str] = []

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    def stream(self, method, url, **kwargs):
        return FakeResponse(type(self).lines)


@contextmanager
def in_graph_thread(thread_id: str = "t-1"):
    token = var_child_runnable_config.set({"configurable": {"thread_id": thread_id}})
    try:
        yield
    finally:
        var_child_runnable_config.reset(token)


async def test_the_http_research_path_hands_over_text_only_too(monkeypatch):
    """Off by default (Phase 16's distributed-tracing spike), but it had the
    identical `str(content)` repr bug."""
    final = {
        "type": "final",
        "messages": [
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "reasoning", "signature": SIGNATURE},
                    {"type": "text", "text": "The researched answer."},
                ],
            }
        ],
    }
    FakeHttpClient.lines = [f"data: {json.dumps(final)}"]
    monkeypatch.setattr(sup.httpx, "AsyncClient", FakeHttpClient)
    with in_graph_thread():
        result = await sup._invoke_research_agent_via_http([HumanMessage(content="q")], set())
    assert result.content == "The researched answer."


async def test_the_http_research_path_marks_a_reply_with_no_text(monkeypatch):
    final = {
        "type": "final",
        "messages": [
            {
                "role": "assistant",
                "content": [{"type": "thinking", "thinking": "", "signature": SIGNATURE}],
            }
        ],
    }
    FakeHttpClient.lines = [f"data: {json.dumps(final)}"]
    monkeypatch.setattr(sup.httpx, "AsyncClient", FakeHttpClient)
    with in_graph_thread():
        result = await sup._invoke_research_agent_via_http([HumanMessage(content="q")], set())
    assert result.content == "(the specialist returned no text)"


def test_specialist_text_reuses_the_projects_text_only_renderer():
    """Not a fourth copy: the supervisor's helper delegates to memory_extraction's."""
    from assistant import memory_extraction

    assert sup.text_only_content is memory_extraction.text_only_content
