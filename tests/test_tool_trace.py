"""Tests for assistant.tool_trace — the middleware that records every tool call
(and, inside a delegation, every specialist model turn) into trace_store for the
History panel (STEPS.md 158), plus the supervisor.py wiring it relies on
(`_run_delegation`'s TRACE_CONTEXT, the middleware in every agent's list).

Offline: no model API is called. The unit tests drive `awrap_tool_call` and
`awrap_model_call` directly with fake requests and handlers; the integration test runs REAL
`create_agent` graphs — a supervisor whose delegation tool is supervisor.py's
own `_make_specialist_tool` over a nested specialist graph, with a real
`interrupt()` and a real resume — against a scripted fake chat model. That
test is what proves the context crosses the specialist's nested `ainvoke()`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import tempfile
import uuid
from contextlib import contextmanager
from functools import partial
from pathlib import Path
from types import SimpleNamespace

import pytest
from langchain.agents import create_agent
from langchain.agents.middleware.types import ExtendedModelResponse, ModelResponse
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables.config import var_child_runnable_config
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.errors import GraphInterrupt
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from assistant import activity_log, sub_agents, trace_store
from assistant import supervisor as sup
from assistant.tool_trace import TRACE_CONTEXT, ToolTraceMiddleware
from assistant.trace_content import render_text


@pytest.fixture()
def db(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "traces.sqlite"
        monkeypatch.setattr(trace_store, "DEFAULT_DB_PATH", path)
        monkeypatch.setattr(activity_log, "DEFAULT_DB_PATH", Path(tmp) / "activity.sqlite")
        yield path


@contextmanager
def in_graph_thread(thread_id: str):
    """What `get_config()` sees inside a real graph run: a config with a thread."""
    token = var_child_runnable_config.set({"configurable": {"thread_id": thread_id}})
    try:
        yield
    finally:
        var_child_runnable_config.reset(token)


def request(name: str = "web_search", args: object = None, call_id: str = "call-1"):
    """The only part of a ToolCallRequest the middleware reads."""
    call = {"name": name, "args": {"q": "x"} if args is None else args, "id": call_id}
    return SimpleNamespace(tool_call={**call, "type": "tool_call"})


def returns(message):
    async def handler(_request):
        return message

    return handler


def raises(exc: BaseException):
    async def handler(_request):
        raise exc

    return handler


async def rows(thread_id: str = "t-1"):
    return await trace_store.calls_for_thread(thread_id)


@contextmanager
def in_delegation(thread_id: str = "t-1", parent: str = "p1"):
    """What a specialist's model call sees: the context `_run_delegation` sets."""
    token = TRACE_CONTEXT.set((thread_id, parent))
    try:
        yield
    finally:
        TRACE_CONTEXT.reset(token)


def model_request():
    """The hook never reads the request; the handler stands in for the model."""
    return SimpleNamespace(messages=[], tools=[])


def reply(
    text: str = "",
    thinking: str | None = None,
    *,
    id: str | None = "msg_1",
    usage: dict | None = None,
    metadata: dict | None = None,
    tool_calls: tuple = (),
) -> AIMessage:
    """One model reply: content as Anthropic returns it (thinking, text blocks)."""
    content: list = []
    if thinking is not None:
        content.append({"type": "thinking", "thinking": thinking, "signature": "sig"})
    if text:
        content.append({"type": "text", "text": text})
    return AIMessage(
        content=content,
        id=id,
        tool_calls=[{"name": n, "args": a, "id": i, "type": "tool_call"} for n, a, i in tool_calls],
        usage_metadata=usage,
        response_metadata=metadata or {},
    )


def model_returns(*messages: AIMessage):
    async def handler(_request):
        return ModelResponse(result=list(messages))

    return handler


# --- one call, every outcome ---------------------------------------------------


async def test_an_ok_call_is_recorded_with_its_arguments_output_and_timing(db):
    middleware = ToolTraceMiddleware("research_agent")
    result = ToolMessage(content="3 results", tool_call_id="call-1", name="web_search")
    with in_graph_thread("t-1"):
        returned = await middleware.awrap_tool_call(
            request(args={"query": "oni", "n": 3}), returns(result)
        )
    assert returned is result  # recording never changes what the call returns
    [call] = await rows()
    assert call.agent == "research_agent"
    assert call.name == "web_search"
    assert call.tool_call_id == "call-1"
    assert call.parent_tool_call_id is None
    assert json.loads(call.input) == {"query": "oni", "n": 3}
    assert call.output == "3 results"
    assert call.status == "ok"
    assert call.error is None
    assert call.started_at <= call.ended_at
    assert call.duration_ms is not None and call.duration_ms >= 0


async def test_a_tool_message_marked_error_is_recorded_as_an_error(db):
    failing = ToolMessage(
        content="Error invoking tool: field required", tool_call_id="call-1", status="error"
    )
    with in_graph_thread("t-1"):
        await ToolTraceMiddleware("supervisor").awrap_tool_call(request(), returns(failing))
    [call] = await rows()
    assert call.status == "error"
    assert call.output == "Error invoking tool: field required"


async def test_an_interrupt_is_recorded_as_interrupted_and_reraised_untouched(db):
    gate = GraphInterrupt()
    with in_graph_thread("t-1"), pytest.raises(GraphInterrupt) as raised:
        await ToolTraceMiddleware("life_admin_agent").awrap_tool_call(
            request("send_email", {"to": "sam@example.com"}), raises(gate)
        )
    assert raised.value is gate  # the very same exception: the gate must still pause the graph
    [call] = await rows()
    assert call.status == "interrupted"
    assert call.output is None and call.error is None
    assert json.loads(call.input) == {"to": "sam@example.com"}


async def test_any_other_exception_is_recorded_with_its_text_and_reraised(db):
    boom = RuntimeError("engine fell over")
    with in_graph_thread("t-1"), pytest.raises(RuntimeError) as raised:
        await ToolTraceMiddleware("supervisor").awrap_tool_call(request(), raises(boom))
    assert raised.value is boom
    [call] = await rows()
    assert call.status == "error"
    assert call.error == "RuntimeError: engine fell over"
    assert call.output is None


async def test_a_cancelled_call_is_recorded_and_the_cancellation_propagates(db):
    """The user pressed stop mid-call. CancelledError isn't an Exception, so
    without its own clause the call would leave no trace at all."""
    with in_graph_thread("t-1"), pytest.raises(asyncio.CancelledError):
        await ToolTraceMiddleware("coding_agent").awrap_tool_call(
            request("run_claude_code"), raises(asyncio.CancelledError())
        )
    [call] = await rows()
    assert call.status == "error"
    assert call.error == "cancelled"


async def test_a_command_result_records_the_tool_messages_inside_it(db):
    command = Command(
        update={"messages": [ToolMessage(content="rendered a card", tool_call_id="call-1")]}
    )
    with in_graph_thread("t-1"):
        returned = await ToolTraceMiddleware("supervisor").awrap_tool_call(
            request("render_ui"), returns(command)
        )
    assert returned is command
    [call] = await rows()
    assert call.output == "rendered a card"
    assert call.status == "ok"


async def test_a_commands_error_tool_message_marks_the_call_failed(db):
    command = Command(
        update={
            "messages": [
                ToolMessage(content="Error: bad action", tool_call_id="call-1", status="error")
            ]
        }
    )
    with in_graph_thread("t-1"):
        await ToolTraceMiddleware("supervisor").awrap_tool_call(
            request("request_gated_action_confirmation"), returns(command)
        )
    [call] = await rows()
    assert call.status == "error"
    assert call.output == "Error: bad action"


async def test_a_command_may_carry_its_update_as_key_value_pairs(db):
    command = Command(update=[("messages", [ToolMessage(content="paired", tool_call_id="call-1")])])
    with in_graph_thread("t-1"):
        await ToolTraceMiddleware("supervisor").awrap_tool_call(request(), returns(command))
    [call] = await rows()
    assert call.output == "paired"


async def test_a_command_with_no_tool_message_has_no_output(db):
    with in_graph_thread("t-1"):
        await ToolTraceMiddleware("supervisor").awrap_tool_call(
            request(), returns(Command(update={"counter": 1}))
        )
    [call] = await rows()
    assert call.output is None
    assert call.status == "ok"


async def test_arguments_that_are_not_plain_json_are_still_recorded(db):
    with in_graph_thread("t-1"):
        await ToolTraceMiddleware("supervisor").awrap_tool_call(
            request(args={"path": Path("/tmp/x"), "tags": {"a"}}),
            returns(ToolMessage(content="ok", tool_call_id="call-1")),
        )
    [call] = await rows()
    assert json.loads(call.input)["path"] == "/tmp/x"


# --- extras: what else a result carries ------------------------------------------


async def test_a_tool_messages_additional_kwargs_are_recorded_as_extras(db):
    message = ToolMessage(
        content="opened it",
        tool_call_id="call-1",
        additional_kwargs={"phone_action": [{"type": "open_url", "url": "https://example.com"}]},
    )
    with in_graph_thread("t-1"):
        await ToolTraceMiddleware("phone_agent").awrap_tool_call(
            request("open_url_on_phone"), returns(message)
        )
    [call] = await rows()
    assert json.loads(call.extras) == {
        "phone_action": [{"type": "open_url", "url": "https://example.com"}]
    }


async def test_a_commands_extras_keep_every_key_including_the_a2ui_surface_tree(db):
    surface = {"surfaceId": "s1", "components": [{"id": "root", "component": "Text", "text": "hi"}]}
    command = Command(
        update={
            "messages": [
                ToolMessage(
                    content="[UI presented]",
                    tool_call_id="call-1",
                    additional_kwargs={
                        "a2ui_surface": [surface],
                        "gated_action_approved": "send_email",
                    },
                )
            ]
        }
    )
    with in_graph_thread("t-1"):
        await ToolTraceMiddleware("supervisor").awrap_tool_call(
            request("render_ui"), returns(command)
        )
    [call] = await rows()
    assert json.loads(call.extras) == {
        "a2ui_surface": [surface],
        "gated_action_approved": "send_email",
    }


async def test_a_result_with_nothing_attached_has_no_extras(db):
    with in_graph_thread("t-1"):
        await ToolTraceMiddleware("supervisor").awrap_tool_call(
            request(), returns(ToolMessage(content="plain", tool_call_id="call-1"))
        )
    [call] = await rows()
    assert call.extras is None


async def test_extras_from_several_tool_messages_are_merged_and_list_values_joined(db):
    command = Command(
        update={
            "messages": [
                ToolMessage(
                    content="a",
                    tool_call_id="call-1",
                    additional_kwargs={"a2ui_surface": [{"surfaceId": "one"}], "k": "first"},
                ),
                ToolMessage(
                    content="b",
                    tool_call_id="call-1",
                    additional_kwargs={"a2ui_surface": [{"surfaceId": "two"}], "k": "second"},
                ),
            ]
        }
    )
    with in_graph_thread("t-1"):
        await ToolTraceMiddleware("supervisor").awrap_tool_call(request(), returns(command))
    [call] = await rows()
    assert json.loads(call.extras) == {
        "a2ui_surface": [{"surfaceId": "one"}, {"surfaceId": "two"}],  # joined, none lost
        "k": "second",  # a plain value: the later one wins
    }


async def test_extras_have_their_image_bytes_replaced_by_size_markers(db):
    """A surface carries its pictures as data: URIs. Stored whole they would
    swamp the row — and past the store's cap leave it as unparseable half-JSON."""
    uri = "data:image/png;base64," + "A" * 3_000_000
    surface = {"components": [{"component": "Image", "url": uri}], "blob": {"data": "B" * 4000}}
    message = ToolMessage(
        content="[UI presented]",
        tool_call_id="call-1",
        additional_kwargs={"a2ui_surface": [surface]},
    )
    with in_graph_thread("t-1"):
        await ToolTraceMiddleware("supervisor").awrap_tool_call(
            request("render_local_media"), returns(message)
        )
    [call] = await rows()
    stored = json.loads(call.extras)  # still valid JSON
    assert len(call.extras) < 1000
    [kept] = stored["a2ui_surface"]
    assert kept["components"][0]["url"] == f"<data URI: image/png, {len(uri)} chars>"
    assert kept["blob"]["data"] == "<base64 data: 4000 chars>"


async def test_an_error_tool_messages_extras_are_recorded_too(db):
    failed = ToolMessage(
        content="Error: nope",
        tool_call_id="call-1",
        status="error",
        additional_kwargs={"note": "kept"},
    )
    with in_graph_thread("t-1"):
        await ToolTraceMiddleware("supervisor").awrap_tool_call(request(), returns(failed))
    [call] = await rows()
    assert call.status == "error"
    assert json.loads(call.extras) == {"note": "kept"}


async def test_extras_with_values_json_cannot_hold_are_still_recorded(db):
    message = ToolMessage(
        content="ok", tool_call_id="call-1", additional_kwargs={"tags": {1}, "path": Path("/x")}
    )
    with in_graph_thread("t-1"):
        await ToolTraceMiddleware("supervisor").awrap_tool_call(request(), returns(message))
    [call] = await rows()
    assert json.loads(call.extras) == {"tags": "{1}", "path": "/x"}


# --- which thread, which parent -------------------------------------------------


async def test_the_supervisor_takes_its_thread_from_the_graph_config_and_has_no_parent(db):
    with in_graph_thread("thread-from-config"):
        await ToolTraceMiddleware("supervisor").awrap_tool_call(
            request(), returns(ToolMessage(content="ok", tool_call_id="call-1"))
        )
    [call] = await rows("thread-from-config")
    assert call.parent_tool_call_id is None


async def test_a_specialist_takes_thread_and_parent_from_the_delegation_context(db):
    token = TRACE_CONTEXT.set(("thread-9", "delegation-call"))
    try:
        await ToolTraceMiddleware("mac_control_agent").awrap_tool_call(
            request("open_app"), returns(ToolMessage(content="opened", tool_call_id="call-1"))
        )
    finally:
        TRACE_CONTEXT.reset(token)
    [call] = await rows("thread-9")
    assert call.agent == "mac_control_agent"
    assert call.parent_tool_call_id == "delegation-call"


async def test_the_delegation_context_wins_over_the_ambient_config(db):
    token = TRACE_CONTEXT.set(("thread-ctx", "parent"))
    try:
        with in_graph_thread("thread-config"):
            await ToolTraceMiddleware("phone_agent").awrap_tool_call(
                request(), returns(ToolMessage(content="ok", tool_call_id="call-1"))
            )
    finally:
        TRACE_CONTEXT.reset(token)
    assert len(await rows("thread-ctx")) == 1
    assert await rows("thread-config") == []


async def test_with_no_thread_anywhere_nothing_is_recorded_but_the_call_still_runs(db):
    result = ToolMessage(content="ran", tool_call_id="call-1")
    returned = await ToolTraceMiddleware("supervisor").awrap_tool_call(request(), returns(result))
    assert returned is result
    assert not db.exists()  # not even the file: there was nothing to record


async def test_a_config_without_a_thread_records_nothing(db):
    token = var_child_runnable_config.set({"configurable": {}})
    try:
        await ToolTraceMiddleware("supervisor").awrap_tool_call(
            request(), returns(ToolMessage(content="ok", tool_call_id="call-1"))
        )
    finally:
        var_child_runnable_config.reset(token)
    assert not db.exists()


async def test_a_call_that_raises_with_no_thread_still_raises_and_records_nothing(db):
    with pytest.raises(ValueError):
        await ToolTraceMiddleware("supervisor").awrap_tool_call(request(), raises(ValueError("x")))
    assert not db.exists()


# --- best effort ----------------------------------------------------------------


async def test_a_store_failure_never_breaks_the_tool_call(db, monkeypatch, caplog):
    async def broken(*args, **kwargs):
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(trace_store, "record_call", broken)
    result = ToolMessage(content="still fine", tool_call_id="call-1")
    with in_graph_thread("t-1"), caplog.at_level(logging.WARNING, logger="assistant.tool_trace"):
        returned = await ToolTraceMiddleware("supervisor").awrap_tool_call(
            request(), returns(result)
        )
    assert returned is result
    assert "could not record web_search" in caplog.text


async def test_a_store_failure_does_not_mask_the_tools_own_exception(db, monkeypatch):
    async def broken(*args, **kwargs):
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(trace_store, "record_call", broken)
    with in_graph_thread("t-1"), pytest.raises(KeyError):
        await ToolTraceMiddleware("supervisor").awrap_tool_call(request(), raises(KeyError("k")))


# --- a specialist's model turns -----------------------------------------------------

USAGE = {
    "input_tokens": 1200,
    "output_tokens": 80,
    "total_tokens": 1280,
    "input_token_details": {"cache_read": 900, "cache_creation": 0},
}


async def test_a_model_turn_inside_a_delegation_is_recorded_with_text_thinking_and_usage(db):
    response = reply(
        "Looking up Sam.",
        thinking="I should look up Sam first.",
        usage=USAGE,
        metadata={"model_name": "claude-sonnet-5", "stop_reason": "tool_use"},
        tool_calls=(("lookup", {"q": "sam"}, "s1"),),
    )
    handler = model_returns(response)
    with in_delegation("t-1", "p1"):
        returned = await ToolTraceMiddleware("research_agent").awrap_model_call(
            model_request(), handler
        )
    assert returned.result == [response]  # what the model returned is passed on untouched
    [row] = await rows()
    assert row.kind == "assistant"
    assert row.agent == "research_agent"
    assert row.parent_tool_call_id == "p1"
    assert row.tool_call_id == "msg_1"  # the reply's own id
    assert row.name == "claude-sonnet-5"
    assert row.input == ""
    assert row.output == "Looking up Sam."
    assert row.thinking == "I should look up Sam first."
    assert json.loads(row.extras) == {
        "usage": {
            "input_tokens": 1200,
            "output_tokens": 80,
            "cache_read_tokens": 900,
            "cache_creation_tokens": 0,
        },
        "stop_reason": "tool_use",
    }
    assert row.status == "ok" and row.error is None
    assert row.started_at <= row.ended_at
    assert row.duration_ms is not None and row.duration_ms >= 0


async def test_model_turns_are_not_recorded_outside_a_delegation(db):
    """The supervisor's own turns are in the checkpoint already (recording them
    here too would show each one twice), and with no thread there is nowhere to
    record under."""
    handler = model_returns(reply("hello"))
    with in_graph_thread("t-1"):  # a real thread, but no delegation context
        response = await ToolTraceMiddleware("supervisor").awrap_model_call(
            model_request(), handler
        )
    assert response.result[0].content[0]["text"] == "hello"
    await ToolTraceMiddleware("supervisor").awrap_model_call(model_request(), handler)  # no thread
    assert not db.exists()


async def test_a_bare_tool_use_turn_is_not_recorded(db):
    """Its tool row already says everything; a row with nothing in it would
    only be noise."""
    bare = reply(tool_calls=(("lookup", {"q": "x"}, "s1"),))
    blank = reply("   \n", tool_calls=(("lookup", {"q": "x"}, "s2"),))
    with in_delegation():
        await ToolTraceMiddleware("research_agent").awrap_model_call(
            model_request(), model_returns(bare)
        )
        await ToolTraceMiddleware("research_agent").awrap_model_call(
            model_request(), model_returns(blank)
        )
    assert await rows() == []


async def test_a_turn_with_only_thinking_is_recorded(db):
    with in_delegation():
        await ToolTraceMiddleware("research_agent").awrap_model_call(
            model_request(),
            model_returns(reply(thinking="hmm", tool_calls=(("lookup", {}, "s1"),))),
        )
    [row] = await rows()
    assert row.output == "" and row.thinking == "hmm"


async def test_a_turn_with_only_an_empty_signature_only_thinking_block_is_not_recorded(db):
    """The API's old default for this model: a thinking block with no text."""
    with in_delegation():
        await ToolTraceMiddleware("research_agent").awrap_model_call(
            model_request(), model_returns(reply(thinking="", tool_calls=(("lookup", {}, "s1"),)))
        )
    assert await rows() == []


async def test_the_name_falls_back_to_model_and_the_id_to_a_generated_one(db):
    with in_delegation():
        await ToolTraceMiddleware("research_agent").awrap_model_call(
            model_request(), model_returns(reply("hi", id=None))
        )
    [row] = await rows()
    assert row.name == "model"
    assert uuid.UUID(row.tool_call_id)  # a uuid4, not empty


async def test_the_model_name_can_come_from_either_metadata_key(db):
    with in_delegation():
        await ToolTraceMiddleware("research_agent").awrap_model_call(
            model_request(), model_returns(reply("hi", id="a", metadata={"model": "claude-x"}))
        )
    [row] = await rows()
    assert row.name == "claude-x"


async def test_usage_sums_cache_creation_by_lifetime_and_drops_what_is_absent(db):
    split = {
        "input_tokens": 500,
        "output_tokens": 9,
        "total_tokens": 509,
        "input_token_details": {
            "cache_creation": 0,
            "ephemeral_5m_input_tokens": 300,
            "ephemeral_1h_input_tokens": 50,
        },
    }
    plain = {"input_tokens": 7, "output_tokens": 3, "total_tokens": 10}
    with in_delegation():
        mw = ToolTraceMiddleware("research_agent")
        await mw.awrap_model_call(model_request(), model_returns(reply("a", id="a", usage=split)))
        await mw.awrap_model_call(model_request(), model_returns(reply("b", id="b", usage=plain)))
        await mw.awrap_model_call(model_request(), model_returns(reply("c", id="c")))
    first, second, third = await rows()
    assert json.loads(first.extras) == {
        "usage": {"input_tokens": 500, "output_tokens": 9, "cache_creation_tokens": 350}
    }
    assert json.loads(second.extras) == {"usage": {"input_tokens": 7, "output_tokens": 3}}
    assert third.extras is None  # no usage and no stop reason: nothing to store


async def test_all_three_model_return_shapes_are_understood(db):
    message = reply("hello", id="m1")
    shapes = {
        "model response": ModelResponse(result=[message]),
        "extended": ExtendedModelResponse(model_response=ModelResponse(result=[message])),
        "bare message": message,
    }
    mw = ToolTraceMiddleware("research_agent")
    with in_delegation():
        for name, shape in shapes.items():

            async def handler(_request, shape=shape):
                return shape

            returned = await mw.awrap_model_call(model_request(), handler)
            assert returned is shape, name  # never swapped for a copy
    assert [r.output for r in await rows()] == ["hello", "hello", "hello"]


async def test_every_reply_that_said_something_gets_its_own_row(db):
    quiet = reply(tool_calls=(("lookup", {}, "s1"),), id="quiet")
    with in_delegation():
        await ToolTraceMiddleware("research_agent").awrap_model_call(
            model_request(),
            model_returns(
                reply("one", id="m1"), quiet, ToolMessage(content="x", tool_call_id="s9")
            ),
        )
    assert [r.tool_call_id for r in await rows()] == ["m1"]


async def test_a_failing_model_call_is_recorded_as_an_error_and_reraised(db):
    boom = RuntimeError("overloaded")
    with in_delegation(), pytest.raises(RuntimeError) as raised:
        await ToolTraceMiddleware("research_agent").awrap_model_call(model_request(), raises(boom))
    assert raised.value is boom
    [row] = await rows()
    assert row.kind == "assistant"
    assert row.status == "error"
    assert row.error == "RuntimeError: overloaded"
    assert row.output is None and row.thinking is None
    assert row.name == "model"
    assert row.parent_tool_call_id == "p1"


async def test_an_interrupt_through_a_model_call_is_reraised_with_no_row(db):
    gate = GraphInterrupt()
    with in_delegation(), pytest.raises(GraphInterrupt) as raised:
        await ToolTraceMiddleware("research_agent").awrap_model_call(model_request(), raises(gate))
    assert raised.value is gate
    assert not db.exists()  # control flow: nothing was said, so nothing is recorded


async def test_a_cancelled_model_call_is_recorded_and_the_cancellation_propagates(db):
    with in_delegation(), pytest.raises(asyncio.CancelledError):
        await ToolTraceMiddleware("research_agent").awrap_model_call(
            model_request(), raises(asyncio.CancelledError())
        )
    [row] = await rows()
    assert row.status == "error" and row.error == "cancelled"


async def test_a_store_failure_never_breaks_a_model_call(db, monkeypatch, caplog):
    async def broken(*args, **kwargs):
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(trace_store, "record_call", broken)
    response = ModelResponse(result=[reply("still fine")])

    async def handler(_request):
        return response

    with in_delegation(), caplog.at_level(logging.WARNING, logger="assistant.tool_trace"):
        returned = await ToolTraceMiddleware("research_agent").awrap_model_call(
            model_request(), handler
        )
    assert returned is response
    assert "could not record" in caplog.text


async def test_an_unreadable_reply_never_breaks_a_model_call(db, monkeypatch, caplog):
    """A reply the recorder can't make sense of is logged and skipped."""
    from assistant import tool_trace

    def explode(_content):
        raise ValueError("odd content")

    monkeypatch.setattr(tool_trace, "ai_text_and_thinking", explode)
    response = ModelResponse(result=[reply("hi")])
    with in_delegation(), caplog.at_level(logging.WARNING, logger="assistant.tool_trace"):
        returned = await ToolTraceMiddleware("research_agent").awrap_model_call(
            model_request(), model_returns(*response.result)
        )
    assert returned.result == response.result
    assert "could not record a model turn" in caplog.text


# --- rendering ------------------------------------------------------------------


def test_render_text_passes_strings_through_and_joins_text_blocks():
    assert render_text("plain") == "plain"
    blocks = [{"type": "text", "text": "one"}, "two", {"type": "text", "text": "three"}]
    assert render_text(blocks) == "one\ntwo\nthree"


def test_render_text_keeps_non_text_blocks_as_json_without_their_base64():
    image = {"type": "image", "mime_type": "image/png", "data": "A" * 5000}
    text = render_text([{"type": "text", "text": "see:"}, image])
    assert text.startswith("see:\n{")
    assert json.loads(text.split("\n", 1)[1]) == {
        "type": "image",
        "mime_type": "image/png",
        "data": "<base64 data: 5000 chars>",
    }


def test_render_text_keeps_short_data_fields_in_full():
    block = {"type": "file", "data": "tiny"}
    assert json.loads(render_text([block])) == block


# --- the supervisor.py wiring ---------------------------------------------------


async def test_run_delegation_publishes_the_trace_context_while_work_runs_and_resets_it(
    monkeypatch,
):
    async def no_frames(*args, **kwargs):
        pass

    monkeypatch.setattr(sup, "adispatch_custom_event", no_frames)
    monkeypatch.setattr(activity_log, "record_event", no_frames)
    seen = []

    async def work():
        seen.append(TRACE_CONTEXT.get())
        return "done"

    with in_graph_thread("t-1"):
        assert await sup._run_delegation("coding_agent", work, "call-9") == "done"
    assert seen == [("t-1", "call-9")]
    assert TRACE_CONTEXT.get() is None


async def test_run_delegation_resets_the_context_when_work_fails_or_is_paused(monkeypatch):
    async def no_frames(*args, **kwargs):
        pass

    monkeypatch.setattr(sup, "adispatch_custom_event", no_frames)
    monkeypatch.setattr(activity_log, "record_event", no_frames)
    for exc in (RuntimeError("boom"), GraphInterrupt()):

        async def work(exc=exc):
            raise exc

        with in_graph_thread("t-1"), pytest.raises(type(exc)):
            await sup._run_delegation("coding_agent", work, "call-9")
        assert TRACE_CONTEXT.get() is None


async def test_run_delegation_without_a_call_id_or_thread_sets_no_context(monkeypatch):
    async def no_frames(*args, **kwargs):
        pass

    monkeypatch.setattr(sup, "adispatch_custom_event", no_frames)
    monkeypatch.setattr(activity_log, "record_event", no_frames)
    seen = []

    async def work():
        seen.append(TRACE_CONTEXT.get())

    with in_graph_thread("t-1"):
        await sup._run_delegation("coding_agent", work)  # no tool_call_id
    await sup._run_delegation("coding_agent", work, "call-9")  # no thread in scope
    assert seen == [None, None]


def test_every_agent_builder_includes_a_tool_trace_middleware_named_for_it(monkeypatch):
    """CLAUDE.md's standing rule for new agents (the same one the caching and
    circuit-breaker middleware have): an agent built without it makes calls the
    History panel never sees."""
    built: dict[str, list] = {}

    def fake_create_agent(**kwargs):
        built[kwargs["name"]] = kwargs["middleware"]
        return object()

    monkeypatch.setattr(sub_agents, "create_agent", fake_create_agent)
    monkeypatch.setattr(sup, "create_agent", fake_create_agent)
    sub_agents.build_coding_agent()
    sub_agents.build_research_agent()
    sub_agents.build_life_admin_agent([])
    sub_agents.build_mac_control_agent()
    sub_agents.build_phone_agent()
    sup.build_supervisor(*[object()] * 5)

    assert set(built) == {
        "supervisor",
        "coding_agent",
        "research_agent",
        "life_admin_agent",
        "mac_control_agent",
        "phone_agent",
    }
    for agent, middleware in built.items():
        traces = [m for m in middleware if isinstance(m, ToolTraceMiddleware)]
        assert [m.agent_name for m in traces] == [agent]


# --- the whole thing through real graphs ----------------------------------------


class ScriptedModel(BaseChatModel):
    """A chat model that replays fixed AIMessages — enough for create_agent."""

    script: list = []
    position: int = 0

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        message = self.script[self.position]
        self.position += 1
        return ChatResult(generations=[ChatGeneration(message=message)])


def calling(name: str, args: dict, call_id: str, content="", **fields) -> AIMessage:
    return AIMessage(
        content=content,
        tool_calls=[{"name": name, "args": args, "id": call_id, "type": "tool_call"}],
        **fields,
    )


@tool
def lookup(q: str) -> str:
    """Look something up."""
    return f"result for {q}"


@tool
def send_email(to: str) -> str:
    """Send an email, after the user confirms."""
    approved = interrupt({"action": "send_email", "to": to})
    return "sent" if approved else "Cancelled — user did not confirm."


async def test_a_specialists_work_is_recorded_under_its_delegation_through_real_graphs(db):
    """The whole chain, offline: real create_agent graphs, supervisor.py's own
    delegation tool, a real interrupt() and resume. What it proves: the trace
    context crosses the specialist's nested ainvoke(); the specialist's model
    turns and tool calls land in the order they finished; its bare tool-use
    turn adds no row; the supervisor's own turns add none; and the gated call
    keeps its tool_call_id across the pause."""
    usage = {
        "input_tokens": 1200,
        "output_tokens": 80,
        "total_tokens": 1280,
        "input_token_details": {"cache_read": 900, "cache_creation": 0},
    }
    meta = {"model_name": "claude-sonnet-5", "stop_reason": "tool_use"}
    specialist = create_agent(
        model=ScriptedModel(
            script=[
                calling(
                    "lookup",
                    {"q": "sam"},
                    "s1",
                    content=[
                        {"type": "thinking", "thinking": "Look Sam up first.", "signature": "sig"},
                        {"type": "text", "text": "Looking up Sam."},
                    ],
                    usage_metadata=usage,
                    response_metadata=meta,
                ),
                calling("send_email", {"to": "sam"}, "s2"),  # a bare tool-use turn
                AIMessage(
                    content=[{"type": "text", "text": "Emailed Sam."}],
                    usage_metadata=usage,
                    response_metadata={"model_name": "claude-sonnet-5", "stop_reason": "end_turn"},
                ),
            ]
        ),
        tools=[lookup, send_email],
        middleware=[ToolTraceMiddleware("life_admin_agent")],
        name="life_admin_agent",
    )
    delegate = sup._make_specialist_tool(
        "life_admin_agent",
        "delegate",
        partial(sup._invoke_agent_graph, specialist, "life_admin_agent"),
    )
    supervisor = create_agent(
        model=ScriptedModel(
            script=[
                calling("life_admin_agent", {"request": "email sam"}, "p1", content="On it."),
                AIMessage(content="Done."),
            ]
        ),
        tools=[delegate],
        middleware=[ToolTraceMiddleware("supervisor")],
        name="supervisor",
    )
    builder = StateGraph(sup.GraphState)
    builder.add_node("supervisor", supervisor)
    builder.add_edge(START, "supervisor")
    builder.add_edge("supervisor", END)
    graph = builder.compile(checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "T-1", "checkpoint_ns": ""}}

    paused = await graph.ainvoke({"messages": [HumanMessage(content="email sam")]}, config=config)
    assert paused["__interrupt__"], "the gated send_email should have paused the turn"

    def shape(calls):
        return [
            (c.kind, c.agent, c.name, c.tool_call_id[:2], c.parent_tool_call_id, c.status)
            for c in calls
        ]

    assert shape(await rows("T-1")) == [
        ("assistant", "life_admin_agent", "claude-sonnet-5", "lc", "p1", "ok"),
        ("tool", "life_admin_agent", "lookup", "s1", "p1", "ok"),
        ("tool", "life_admin_agent", "send_email", "s2", "p1", "interrupted"),
        ("tool", "supervisor", "life_admin_agent", "p1", None, "interrupted"),
    ]

    done = await graph.ainvoke(Command(resume=True), config=config)
    assert done["messages"][-1].content == "Done."

    calls = await rows("T-1")
    # On resume the specialist continues from where it paused: only the gated
    # call (and the delegation around it) pass through the middleware again,
    # each under the same tool_call_id as before — and its last model turn,
    # which hadn't happened yet, is recorded after them.
    assert shape(calls)[4:] == [
        ("tool", "life_admin_agent", "send_email", "s2", "p1", "ok"),
        ("assistant", "life_admin_agent", "claude-sonnet-5", "lc", "p1", "ok"),
        ("tool", "supervisor", "life_admin_agent", "p1", None, "ok"),
    ]
    assert all(c.thread_id == "T-1" for c in calls)
    assert [c.seq for c in calls] == [1, 2, 3, 4, 5, 6, 7]
    first, last = calls[0], calls[5]
    assert (first.output, first.thinking) == ("Looking up Sam.", "Look Sam up first.")
    assert json.loads(first.extras) == {
        "usage": {
            "input_tokens": 1200,
            "output_tokens": 80,
            "cache_read_tokens": 900,
            "cache_creation_tokens": 0,
        },
        "stop_reason": "tool_use",
    }
    assert (last.output, last.thinking) == ("Emailed Sam.", None)
    assert json.loads(calls[1].input) == {"q": "sam"}
    assert calls[1].output == "result for sam"
    assert calls[4].output == "sent"
    assert calls[6].output == "Emailed Sam."
    # The supervisor's own turns ("On it.", "Done.") are in the checkpoint, not here.
    assert not [c for c in calls if c.kind == "assistant" and c.agent == "supervisor"]
    assert TRACE_CONTEXT.get() is None  # nothing leaked out of the delegation
