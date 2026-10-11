"""Tests for assistant.history_trace — the pure builder behind the History
panel's conversation view (STEPS.md 158) — and the thin `GET /history/trace`
endpoint around it.

The builder tests need no graph, database or network: messages and trace rows
are built by hand, which is the point of keeping it a pure function. The
endpoint tests drive the real FastAPI app through `TestClient` WITHOUT its
lifespan (no real graph, MCP servers or checkpointer): a stub stands in for
`app.state.graph` and the stores point at temp files.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from assistant import compaction, history_trace, trace_store
from assistant.history_trace import build_trace, trace_page
from assistant.trace_content import DATA_URI_MIN_CHARS, elide_data_uris
from assistant.trace_store import TraceRow

DELEGATIONS = {
    "coding_agent",
    "research_agent",
    "life_admin_agent",
    "mac_control_agent",
    "phone_agent",
    "backstage",
    "onstage",
}


def human(text) -> HumanMessage:
    return HumanMessage(content=text)


def recalled_facts(text: str = "[Known facts: likes tea]") -> HumanMessage:
    message = HumanMessage(content=text)
    compaction.tag_recalled_facts(message)
    return message


def summary(text: str = "[Summary of earlier conversation: they planned a trip]") -> HumanMessage:
    return HumanMessage(content=text, additional_kwargs={compaction._SUMMARY_MARKER_KEY: True})


def ai(text="", calls=(), thinking=None) -> AIMessage:
    """`calls` is [(name, args, id), ...]."""
    content = (
        text
        if thinking is None
        else [
            {"type": "thinking", "thinking": thinking, "signature": "sig"},
            {"type": "text", "text": text},
        ]
    )
    return AIMessage(
        content=content,
        tool_calls=[{"name": n, "args": a, "id": i, "type": "tool_call"} for n, a, i in calls],
    )


def result(call_id: str, content, status: str = "success", **attached) -> ToolMessage:
    """A ToolMessage; keyword arguments become its `additional_kwargs`."""
    return ToolMessage(
        content=content, tool_call_id=call_id, status=status, additional_kwargs=attached
    )


def row(
    seq: int,
    tool_call_id: str,
    name: str,
    *,
    parent: str | None = None,
    agent: str | None = None,
    kind: str = "tool",
    status: str = "ok",
    input=None,
    output: str | None = "out",
    thinking: str | None = None,
    extras=None,
    error: str | None = None,
    started: str = "2026-10-06T10:00:00+00:00",
    ended: str = "2026-10-06T10:00:01+00:00",
    duration: int | None = 1000,
) -> TraceRow:
    return TraceRow(
        id=f"row-{seq}",
        seq=seq,
        thread_id="t",
        tool_call_id=tool_call_id,
        parent_tool_call_id=parent,
        agent=agent or ("supervisor" if parent is None else "specialist"),
        name=name,
        kind=kind,
        input=input if isinstance(input, str) else json.dumps({} if input is None else input),
        output=output,
        thinking=thinking,
        extras=extras if extras is None or isinstance(extras, str) else json.dumps(extras),
        status=status,
        error=error,
        started_at=started,
        ended_at=ended,
        duration_ms=duration,
    )


def build(messages, calls=()):
    return build_trace(messages, list(calls), delegation_names=DELEGATIONS)


# --- turns -----------------------------------------------------------------------


def test_every_genuine_human_message_starts_a_turn():
    turns = build([human("first"), ai("one"), human("second"), ai("two")])
    assert [t["index"] for t in turns] == [0, 1]
    assert [t["user"] for t in turns] == [
        {"content": "first", "synthetic": False},
        {"content": "second", "synthetic": False},
    ]
    assert [t["reply"] for t in turns] == ["one", "two"]


def test_an_empty_thread_has_no_turns():
    assert build([]) == []
    assert trace_page([], [], limit=30, delegation_names=DELEGATIONS) == (0, [])


def test_the_reply_is_the_last_assistant_messages_text_or_none():
    turns = build(
        [
            human("a"),
            ai("let me check", [("web_search", {"q": "x"}, "c1")]),
            result("c1", "found"),
            ai("here you go"),
            human("b"),
            ai("", [("web_search", {"q": "y"}, "c2")]),  # the turn stops mid-call
        ]
    )
    assert turns[0]["reply"] == "here you go"
    assert turns[1]["reply"] is None


def test_a_user_messages_image_blocks_show_as_a_size_not_their_base64():
    content = [
        {"type": "image", "source_type": "base64", "mime_type": "image/png", "data": "A" * 9000},
        {"type": "text", "text": "what is this?"},
    ]
    [turn] = build([human(content), ai("a cat")])
    shown = turn["user"]["content"]
    assert "what is this?" in shown
    assert "<base64 data: 9000 chars>" in shown
    assert "AAAA" not in shown


# --- assistant text and thinking ---------------------------------------------------


def test_an_assistant_event_carries_its_text_and_its_thinking_in_full():
    thought = "step one\n\nstep two " + "x" * 3000
    [turn] = build([human("q"), ai("the answer", thinking=thought)])
    assert turn["events"] == [{"kind": "assistant", "text": "the answer", "thinking": thought}]


def test_thinking_is_none_when_the_message_has_none():
    [turn] = build([human("q"), ai("plain")])
    assert turn["events"] == [{"kind": "assistant", "text": "plain", "thinking": None}]


def test_a_message_with_only_tool_calls_makes_no_assistant_event():
    [turn] = build([human("q"), ai("", [("render_ui", {}, "c1")]), result("c1", "ok")])
    assert [e["kind"] for e in turn["events"]] == ["tool"]


def test_a_message_with_only_thinking_still_shows():
    [turn] = build([human("q"), ai("", thinking="hm", calls=[("render_ui", {}, "c1")])])
    assert [e["kind"] for e in turn["events"]] == ["assistant", "tool"]
    assert turn["events"][0] == {"kind": "assistant", "text": "", "thinking": "hm"}


def test_text_and_tool_calls_in_one_message_keep_that_order():
    [turn] = build(
        [
            human("q"),
            ai("checking", [("web_search", {"q": "a"}, "c1"), ("web_search", {"q": "b"}, "c2")]),
            result("c1", "A"),
            result("c2", "B"),
        ]
    )
    assert [(e["kind"], e.get("id")) for e in turn["events"]] == [
        ("assistant", None),
        ("tool", "c1"),
        ("tool", "c2"),
    ]


# --- context ---------------------------------------------------------------------


def test_recalled_facts_and_a_compaction_summary_are_context_events_not_turns():
    messages = [summary(), human("hi"), recalled_facts(), ai("hello")]
    turns = build(messages)
    assert [t["index"] for t in turns] == [0, 1]
    # Before the first genuine message: a leading turn with no user.
    assert turns[0]["user"] is None
    assert turns[0]["events"] == [
        {
            "kind": "context",
            "label": "conversation summary",
            "content": "[Summary of earlier conversation: they planned a trip]",
        }
    ]
    assert turns[0]["reply"] is None
    assert turns[1]["user"] == {"content": "hi", "synthetic": False}
    assert turns[1]["events"][0] == {
        "kind": "context",
        "label": "recalled facts",
        "content": "[Known facts: likes tea]",
    }
    assert turns[1]["events"][1]["kind"] == "assistant"


def test_what_counts_as_a_genuine_turn_matches_the_servers_synthetic_flag():
    """`/history` flags synthetic messages with server._is_synthetic; the
    builder can't import it (server imports the builder), so this keeps the two
    answers from drifting apart."""
    from assistant import server

    messages = [
        human("typed by the user"),
        recalled_facts(),
        summary(),
        ai("hi"),
        result("c1", "x"),
        SystemMessage(content="s"),
    ]
    for message in messages:
        if isinstance(message, HumanMessage):
            assert history_trace._is_turn_start(message) == (not server._is_synthetic(message))
        else:
            assert not history_trace._is_turn_start(message)
            assert not server._is_synthetic(message)


def test_any_other_injected_message_is_labelled_context_or_system():
    [turn] = build([human("q"), SystemMessage(content="be brief"), ai("ok")])
    assert turn["events"][0] == {"kind": "context", "label": "system", "content": "be brief"}


# --- tool events ----------------------------------------------------------------


def test_a_tool_event_pairs_the_call_with_its_tool_message():
    [turn] = build(
        [
            human("q"),
            ai("", [("web_search", {"query": "oni", "n": 3}, "c1")]),
            result("c1", "3 results"),
        ]
    )
    [event] = turn["events"]
    assert event == {
        "kind": "tool",
        "id": "c1",
        "agent": "supervisor",
        "name": "web_search",
        "input": {"query": "oni", "n": 3},
        "output": "3 results",
        "status": "ok",
        "delegation": None,
        "started_at": None,
        "ended_at": None,
        "duration_ms": None,
        "stage_run_id": None,
        "error": None,
        "surfaces": [],
        "extras": {},
        "children": [],
    }


def test_a_tool_events_output_renders_content_blocks_as_text():
    blocks = [{"type": "text", "text": "line one"}, {"type": "text", "text": "line two"}]
    [turn] = build([human("q"), ai("", [("read", {}, "c1")]), result("c1", blocks)])
    assert turn["events"][0]["output"] == "line one\nline two"


def test_a_delegation_is_marked_with_its_specialists_name():
    [turn] = build(
        [
            human("q"),
            ai("", [("coding_agent", {"request": "list files"}, "c1")]),
            result("c1", "done"),
        ]
    )
    assert turn["events"][0]["delegation"] == "coding_agent"


def test_a_tool_message_with_status_error_is_an_error_event():
    [turn] = build(
        [human("q"), ai("", [("render_ui", {}, "c1")]), result("c1", "Error: bad", "error")]
    )
    assert turn["events"][0]["status"] == "error"
    assert turn["events"][0]["output"] == "Error: bad"


def test_a_call_with_no_tool_message_and_no_row_is_pending():
    [turn] = build([human("q"), ai("", [("coding_agent", {"request": "x"}, "c1")])])
    event = turn["events"][0]
    assert event["status"] == "pending"
    assert event["output"] is None


def test_a_still_running_call_shows_its_children_so_far():
    """A delegation whose result isn't in the checkpoint yet already has the
    specialist's earlier calls recorded: live progress, by re-reading."""
    [turn] = build(
        [human("q"), ai("", [("research_agent", {"request": "x"}, "p1")])],
        [row(1, "s1", "web_search", parent="p1", agent="research_agent", output="hits")],
    )
    event = turn["events"][0]
    assert event["status"] == "pending"
    assert [c["name"] for c in event["children"]] == ["web_search"]


# --- trace rows: timing, status, errors ------------------------------------------


def test_a_trace_row_supplies_timing_and_the_agent_and_status():
    [turn] = build(
        [human("q"), ai("", [("coding_agent", {"request": "x"}, "c1")]), result("c1", "done")],
        [
            row(
                1,
                "c1",
                "coding_agent",
                started="2026-10-06T10:00:00+00:00",
                ended="2026-10-06T10:00:07+00:00",
                duration=7000,
            )
        ],
    )
    event = turn["events"][0]
    assert event["started_at"] == "2026-10-06T10:00:00+00:00"
    assert event["ended_at"] == "2026-10-06T10:00:07+00:00"
    assert event["duration_ms"] == 7000
    assert event["agent"] == "supervisor"
    assert event["status"] == "ok"


def test_a_call_that_raised_shows_its_error_as_its_output_too():
    """The tool raised, so there is no ToolMessage; what it produced IS the
    error. It is in `output` so a reader built against the spec's event shape
    shows it, and in `error` for one that wants to tell them apart."""
    [turn] = build(
        [human("q"), ai("", [("run_claude_code", {"task": "x"}, "c1")])],
        [row(1, "c1", "run_claude_code", status="error", output=None, error="OSError: no space")],
    )
    event = turn["events"][0]
    assert event["status"] == "error"
    assert event["output"] == "OSError: no space"
    assert event["error"] == "OSError: no space"


def test_an_interrupted_call_with_no_result_stays_interrupted():
    [turn] = build(
        [
            human("q"),
            ai("", [("request_gated_action_confirmation", {"action": "send_email"}, "c1")]),
        ],
        [row(1, "c1", "request_gated_action_confirmation", status="interrupted", output=None)],
    )
    assert turn["events"][0]["status"] == "interrupted"


def test_an_interrupted_row_next_to_a_tool_message_defers_to_the_message():
    """A result exists, so the call can't still be paused — the row of its
    finished attempt just wasn't recorded."""
    [turn] = build(
        [human("q"), ai("", [("send_email", {}, "c1")]), result("c1", "sent")],
        [row(1, "c1", "send_email", status="interrupted", output=None)],
    )
    assert turn["events"][0]["status"] == "ok"
    assert turn["events"][0]["output"] == "sent"


def test_the_checkpoints_output_wins_over_the_rows_for_a_supervisor_call():
    [turn] = build(
        [human("q"), ai("", [("web_search", {}, "c1")]), result("c1", "from the checkpoint")],
        [row(1, "c1", "web_search", output="from the row")],
    )
    assert turn["events"][0]["output"] == "from the checkpoint"


def test_a_turn_from_before_tracing_simply_has_no_timing_or_children():
    [turn] = build(
        [human("q"), ai("", [("coding_agent", {"request": "x"}, "c1")]), result("c1", "done")]
    )
    event = turn["events"][0]
    assert (event["started_at"], event["ended_at"], event["duration_ms"]) == (None, None, None)
    assert event["children"] == []
    assert event["status"] == "ok"


# --- children --------------------------------------------------------------------


def test_a_delegations_children_are_the_rows_that_name_it_as_their_parent_in_seq_order():
    messages = [
        human("q"),
        ai("", [("life_admin_agent", {"request": "x"}, "p1")]),
        result("p1", "done"),
        ai("", [("coding_agent", {"request": "y"}, "p2")]),
        result("p2", "done"),
    ]
    calls = [
        row(1, "s2", "read_email", parent="p1", agent="life_admin_agent", input={"id": 2}),
        row(2, "s1", "search_emails", parent="p1", agent="life_admin_agent", input={"q": "x"}),
        row(3, "p1", "life_admin_agent"),
        row(4, "t1", "run_claude_code", parent="p2", agent="coding_agent"),
        row(5, "p2", "coding_agent"),
    ]
    [turn] = build(messages, calls)
    first, second = [e for e in turn["events"] if e["kind"] == "tool"]
    assert [(c["name"], c["agent"], c["id"]) for c in first["children"]] == [
        ("read_email", "life_admin_agent", "s2"),
        ("search_emails", "life_admin_agent", "s1"),
    ]
    assert first["children"][0]["input"] == {"id": 2}
    assert [c["name"] for c in second["children"]] == ["run_claude_code"]


def test_children_have_the_same_shape_as_any_tool_event_and_nest_recursively():
    messages = [human("q"), ai("", [("research_agent", {"request": "x"}, "p1")]), result("p1", "r")]
    calls = [
        row(1, "g1", "web_search", parent="c1", agent="deep_agent", output="leaf"),
        row(2, "c1", "deep_agent", parent="p1", agent="research_agent", output="mid"),
    ]
    [turn] = build(messages, calls)
    [child] = turn["events"][0]["children"]
    assert child["kind"] == "tool"
    assert child["agent"] == "research_agent"
    assert child["output"] == "mid"
    assert child["started_at"] == "2026-10-06T10:00:00+00:00"
    assert [g["name"] for g in child["children"]] == ["web_search"]
    assert child["children"][0]["children"] == []


def test_a_row_naming_itself_as_its_own_parent_does_not_recurse_forever():
    messages = [human("q"), ai("", [("research_agent", {}, "p1")]), result("p1", "r")]
    calls = [row(1, "loop", "odd", parent="loop", agent="x")]
    [turn] = build(messages, calls)
    assert turn["events"][0]["children"] == []  # no row names p1 as a parent
    # And when one does, the cycle is cut at the repeated id.
    calls = [row(1, "p1", "odd", parent="p1", agent="x")]
    [turn] = build(messages, calls)
    [child] = turn["events"][0]["children"]
    assert child["children"] == []


def test_rows_for_calls_that_are_not_in_the_conversation_are_ignored():
    """e.g. the rows of a turn compaction has since removed from the
    checkpoint: nothing to hang them on."""
    [turn] = build(
        [human("q"), ai("", [("web_search", {}, "c1")]), result("c1", "ok")],
        [
            row(1, "old-call", "web_search", output="from a compacted turn"),
            row(2, "x", "child", parent="old-call"),
        ],
    )
    assert [e["id"] for e in turn["events"]] == ["c1"]
    assert turn["events"][0]["output"] == "ok"


def test_a_gated_call_that_ran_twice_shows_once_as_its_final_attempt():
    """A confirmation gate pauses the call (recorded 'interrupted'); on resume
    it runs again under the same tool_call_id. One call must not read as two."""
    messages = [
        human("email sam"),
        ai("on it", [("life_admin_agent", {"request": "email sam"}, "p1")]),
        result("p1", "emailed sam"),
        ai("done"),
    ]
    calls = [
        row(1, "s1", "search_emails", parent="p1", agent="life_admin_agent", output="1 thread"),
        row(
            2,
            "s2",
            "send_email",
            parent="p1",
            agent="life_admin_agent",
            status="interrupted",
            output=None,
        ),
        row(3, "p1", "life_admin_agent", status="interrupted", output=None, duration=40),
        row(
            4,
            "s2",
            "send_email",
            parent="p1",
            agent="life_admin_agent",
            output="sent",
            started="2026-10-06T10:05:00+00:00",
            ended="2026-10-06T10:05:01+00:00",
            duration=900,
        ),
        row(5, "p1", "life_admin_agent", output="emailed sam", duration=950),
    ]
    [turn] = build(messages, calls)
    delegation = turn["events"][1]
    assert delegation["id"] == "p1"
    assert delegation["status"] == "ok"
    assert delegation["duration_ms"] == 950  # the final attempt's own timing
    # Children keep the place they first appeared, with the final attempt's content.
    assert [(c["id"], c["status"], c["output"]) for c in delegation["children"]] == [
        ("s1", "ok", "1 thread"),
        ("s2", "ok", "sent"),
    ]
    assert delegation["children"][1]["duration_ms"] == 900


# --- surfaces and extras ---------------------------------------------------------

BIG_URI = "data:image/png;base64," + "A" * 800
SURFACE = {
    "surfaceId": "s1",
    "components": [
        {"id": "root", "component": "Card", "child": "pic"},
        {"id": "pic", "component": "Image", "url": BIG_URI},
    ],
}
PHONE_ACTION = [{"type": "open_url", "url": "https://example.com"}]


def one_tool_turn(message: ToolMessage, rows=()):
    [turn] = build([human("q"), ai("", [("render_ui", {"surface": {}}, "c1")]), message], rows)
    return turn["events"][0]


def test_a_top_level_events_surfaces_come_from_its_tool_message_and_are_never_elided():
    """The panel draws these as the real card: an elided image src would
    render broken. Everything else on the event is still elided."""
    event = one_tool_turn(
        result("c1", f"rendered {BIG_URI}", a2ui_surface=[SURFACE]),
    )
    assert event["surfaces"] == [SURFACE]
    assert event["surfaces"][0]["components"][1]["url"] == BIG_URI  # whole, 800 chars of base64
    assert event["output"] == f"rendered <data URI: image/png, {len(BIG_URI)} chars>"
    assert event["extras"] == {}  # the surface is not repeated under extras


def test_a_surface_in_a_tool_calls_input_is_still_elided_even_under_a_surfaces_key():
    """Only the event's own `surfaces` field is exempt — not any value that
    happens to sit under a key of that name in an argument."""
    [turn] = build(
        [
            human("q"),
            ai("", [("render_ui", {"surfaces": [BIG_URI]}, "c1")]),
            result("c1", "ok"),
        ]
    )
    assert turn["events"][0]["input"] == {
        "surfaces": [f"<data URI: image/png, {len(BIG_URI)} chars>"]
    }


def test_a_lone_surface_dict_is_wrapped_and_anything_else_is_no_surface():
    assert one_tool_turn(result("c1", "ok", a2ui_surface=SURFACE))["surfaces"] == [SURFACE]
    assert one_tool_turn(result("c1", "ok", a2ui_surface="nonsense"))["surfaces"] == []
    assert one_tool_turn(result("c1", "ok"))["surfaces"] == []


def test_top_level_extras_are_every_other_additional_kwargs_key():
    event = one_tool_turn(
        result(
            "c1",
            "opened",
            phone_action=PHONE_ACTION,
            gated_action_approved=["send_email", "send_imessage"],
            workflow_run_id="run-1",
            a2ui_surface=[SURFACE],
        )
    )
    assert event["extras"] == {
        "phone_action": PHONE_ACTION,
        "gated_action_approved": ["send_email", "send_imessage"],
        "workflow_run_id": "run-1",
    }
    assert event["surfaces"] == [SURFACE]


def test_extras_are_elided_unlike_surfaces():
    event = one_tool_turn(result("c1", "ok", note={"image": BIG_URI}))
    assert event["extras"] == {"note": {"image": f"<data URI: image/png, {len(BIG_URI)} chars>"}}


def test_extras_a_message_carries_that_json_cannot_hold_never_break_the_event():
    event = one_tool_turn(result("c1", "ok", tags={1}, path=object))
    assert event["extras"]["tags"] == "{1}"
    json.dumps(event)  # the whole event still serialises


def test_without_a_tool_message_extras_fall_back_to_the_rows_and_surfaces_are_empty():
    """The call finished but its ToolMessage isn't checkpointed yet. The row's
    extras keep every key (the surface tree included, as plain data)."""
    recorded = {"phone_action": PHONE_ACTION, "a2ui_surface": [SURFACE]}
    [turn] = build(
        [human("q"), ai("", [("render_ui", {}, "c1")])],
        [row(1, "c1", "render_ui", extras=recorded)],
    )
    event = turn["events"][0]
    assert event["surfaces"] == []
    assert event["extras"]["phone_action"] == PHONE_ACTION
    assert event["extras"]["a2ui_surface"][0]["components"][1]["url"].startswith("<data URI")


def test_a_tool_message_with_no_extras_does_not_fall_back_to_the_rows():
    event = one_tool_turn(
        result("c1", "ok"), [row(1, "c1", "render_ui", extras={"stale": "row data"})]
    )
    assert event["extras"] == {}


def test_every_tool_event_carries_error_surfaces_and_extras_top_level_and_child():
    messages = [human("q"), ai("", [("coding_agent", {}, "p1")]), result("p1", "r")]
    calls = [row(1, "t1", "run_claude_code", parent="p1", agent="coding_agent")]
    [turn] = build(messages, calls)
    [parent] = turn["events"]
    [child] = parent["children"]
    for event in (parent, child):
        assert {"error", "surfaces", "extras"} <= set(event)
    assert (child["error"], child["surfaces"], child["extras"]) == (None, [], {})


def test_a_childs_surfaces_are_always_empty_but_its_extras_keep_every_key():
    """A specialist's cards are already forwarded onto its delegation's
    ToolMessage (the parent's `surfaces`); drawing them on the child as well
    would read as two cards. The child's recorded tree is still reachable, as
    plain data, under its extras."""
    messages = [
        human("q"),
        ai("", [("research_agent", {"request": "x"}, "p1")]),
        result("p1", "done", a2ui_surface=[SURFACE]),
    ]
    calls = [
        row(
            1,
            "s1",
            "render_ui",
            parent="p1",
            agent="research_agent",
            extras={"a2ui_surface": [SURFACE], "other": 1},
        )
    ]
    [turn] = build(messages, calls)
    parent = turn["events"][0]
    [child] = parent["children"]
    assert parent["surfaces"] == [SURFACE]
    assert child["surfaces"] == []
    assert set(child["extras"]) == {"a2ui_surface", "other"}
    assert child["extras"]["a2ui_surface"][0]["components"][1]["url"] == (
        f"<data URI: image/png, {len(BIG_URI)} chars>"
    )  # plain data, so elided like any other


def test_clipped_extras_come_back_as_their_raw_text_under_a_key():
    messages = [human("q"), ai("", [("research_agent", {}, "p1")]), result("p1", "r")]
    calls = [row(1, "s1", "render_ui", parent="p1", extras='{"a2ui_surface": [{"x": "cut o')]
    [turn] = build(messages, calls)
    assert turn["events"][0]["children"][0]["extras"] == {
        "_clipped": '{"a2ui_surface": [{"x": "cut o'
    }


# --- mixed children: tool calls and model turns ----------------------------------------


def model_row(
    seq: int,
    message_id: str,
    *,
    parent: str = "p1",
    agent: str = "research_agent",
    name: str = "claude-sonnet-5",
    text: str | None = "Looking it up.",
    thinking: str | None = None,
    extras=None,
    status: str = "ok",
    error: str | None = None,
    duration: int | None = 800,
) -> TraceRow:
    return row(
        seq,
        message_id,
        name,
        parent=parent,
        agent=agent,
        kind="assistant",
        input="",
        output=text,
        thinking=thinking,
        extras=extras,
        status=status,
        error=error,
        duration=duration,
    )


def delegation_children(rows, *, call_id="p1"):
    messages = [
        human("q"),
        ai("", [("research_agent", {"request": "x"}, call_id)]),
        result(call_id, "done"),
    ]
    [turn] = build(messages, rows)
    return turn["events"][0]["children"]


def test_children_are_one_list_of_tool_calls_and_model_turns_in_seq_order():
    children = delegation_children(
        [
            model_row(1, "msg_a", text="Searching.", thinking="Need current data."),
            row(2, "s1", "web_search", parent="p1", agent="research_agent"),
            row(3, "s2", "web_search", parent="p1", agent="research_agent"),
            model_row(4, "msg_b", text="Here is what I found."),
        ]
    )
    assert [(c["kind"], c["id"]) for c in children] == [
        ("assistant", "msg_a"),
        ("tool", "s1"),
        ("tool", "s2"),
        ("assistant", "msg_b"),
    ]


def test_a_model_child_has_exactly_the_contracts_fields():
    usage = {
        "usage": {
            "input_tokens": 1200,
            "output_tokens": 80,
            "cache_read_tokens": 900,
            "cache_creation_tokens": 0,
        },
        "stop_reason": "end_turn",
    }
    [child] = delegation_children(
        [
            model_row(
                1,
                "msg_a",
                text="All done.",
                thinking="Nothing else to check.",
                extras=usage,
            )
        ]
    )
    assert child == {
        "kind": "assistant",
        "id": "msg_a",
        "agent": "research_agent",
        "model": "claude-sonnet-5",
        "text": "All done.",
        "thinking": "Nothing else to check.",
        "status": "ok",
        "error": None,
        "started_at": "2026-10-06T10:00:00+00:00",
        "ended_at": "2026-10-06T10:00:01+00:00",
        "duration_ms": 800,
        "usage": {
            "input_tokens": 1200,
            "output_tokens": 80,
            "cache_read_tokens": 900,
            "cache_creation_tokens": 0,
        },
    }


def test_a_model_child_without_a_model_name_thinking_or_usage_says_none():
    [child] = delegation_children([model_row(1, "msg_a", name="model", thinking=None)])
    assert (child["model"], child["thinking"], child["usage"]) == (None, None, None)


def test_a_model_child_that_failed_shows_its_error_and_empty_text():
    [child] = delegation_children(
        [
            model_row(
                1,
                "gen-1",
                name="model",
                text=None,
                status="error",
                error="RuntimeError: overloaded",
            )
        ]
    )
    assert child["status"] == "error"
    assert child["error"] == "RuntimeError: overloaded"
    assert child["text"] == ""


def test_usage_needs_input_and_output_and_whole_numbers_and_keeps_only_known_fields():
    def usage_of(extras):
        return delegation_children([model_row(1, "m", extras=extras)])[0]["usage"]

    assert usage_of({"usage": {"input_tokens": 5, "output_tokens": 2, "total_tokens": 7}}) == {
        "input_tokens": 5,
        "output_tokens": 2,
    }
    assert usage_of({"usage": {"input_tokens": 5}}) is None
    assert usage_of({"usage": {"input_tokens": "5", "output_tokens": 2}}) is None
    assert usage_of({"usage": {"input_tokens": True, "output_tokens": 2}}) is None
    assert usage_of({"usage": "lots"}) is None
    assert usage_of({"stop_reason": "end_turn"}) is None
    assert usage_of('{"usage": {"input_tokens": 5, "outp') is None  # clipped JSON


def test_model_turns_never_collapse_but_a_resumed_tool_call_still_does():
    """Two model replies can share an id (a replay); each happened once. A
    gated tool call recorded twice is one call."""
    children = delegation_children(
        [
            model_row(1, "same-id", text="first"),
            model_row(2, "same-id", text="second"),
            row(3, "s1", "send_email", parent="p1", status="interrupted", output=None),
            row(4, "s1", "send_email", parent="p1", output="sent"),
        ]
    )
    assert [(c["kind"], c.get("text") or c["output"]) for c in children] == [
        ("assistant", "first"),
        ("assistant", "second"),
        ("tool", "sent"),
    ]


def test_a_gated_delegation_reads_back_in_the_order_things_happened():
    """The shape a real run leaves behind (spiked offline through real graphs):
    the interrupted rows are superseded, the model turn that came after the
    approval lands after the tool call it followed."""
    messages = [
        human("email sam"),
        ai("On it.", [("life_admin_agent", {"request": "email sam"}, "p1")]),
        result("p1", "Emailed Sam."),
        ai("Done."),
    ]
    calls = [
        model_row(
            1, "msg_a", agent="life_admin_agent", text="Looking up Sam.", thinking="Sam first."
        ),
        row(2, "s1", "lookup", parent="p1", agent="life_admin_agent", output="found"),
        row(
            3,
            "s2",
            "send_email",
            parent="p1",
            agent="life_admin_agent",
            status="interrupted",
            output=None,
        ),
        row(4, "p1", "life_admin_agent", status="interrupted", output=None),
        row(5, "s2", "send_email", parent="p1", agent="life_admin_agent", output="sent"),
        model_row(6, "msg_b", agent="life_admin_agent", text="Emailed Sam."),
        row(7, "p1", "life_admin_agent", output="Emailed Sam."),
    ]
    [turn] = build(messages, calls)
    delegation = turn["events"][1]
    assert delegation["status"] == "ok"
    assert [(c["kind"], c["id"], c["status"]) for c in delegation["children"]] == [
        ("assistant", "msg_a", "ok"),
        ("tool", "s1", "ok"),
        ("tool", "s2", "ok"),
        ("assistant", "msg_b", "ok"),
    ]
    assert (
        delegation["children"][2]["output"] == "sent"
    )  # the final attempt's, in the first one's place


def test_a_model_childs_text_and_thinking_are_elided_like_any_other_string():
    [child] = delegation_children([model_row(1, "m", text=f"see {BIG_URI}", thinking=BIG_URI)])
    marker = f"<data URI: image/png, {len(BIG_URI)} chars>"
    assert child["text"] == f"see {marker}"
    assert child["thinking"] == marker


def test_top_level_assistant_events_stay_text_and_thinking_only():
    [turn] = build([human("q"), ai("hello", thinking="hm")])
    [event] = turn["events"]
    assert set(event) == {"kind", "text", "thinking"}


def test_a_model_rows_own_children_are_not_looked_up_by_its_message_id():
    """A model row's id is a message id, never a delegation's tool-call id —
    but a row that names one as its parent must not make the builder recurse."""
    children = delegation_children(
        [
            model_row(1, "msg_a"),
            row(2, "x", "web_search", parent="msg_a", agent="research_agent"),  # never reached
        ]
    )
    assert [c["id"] for c in children] == ["msg_a"]


# --- the Stage run link -----------------------------------------------------------


def test_stage_run_id_comes_from_backstage_and_stage_status_output():
    text = (
        "Backstage run run-jev-2026-10-05T09-51-33-446Z-o03v (finished, done): "
        "1/1 tasks done in 4.2 s, $0.0000\n1. Calculator: DONE — 446.4"
    )
    status_text = (
        "Stage at http://127.0.0.1:3000: Backstage idle; overlay on.\n\n"
        "Backstage run run-llm-2026-10-06T08-00-00-000Z-abcd (finished, done): 1/1\n\n"
        "Backstage run run-jev-2026-10-05T09-51-33-446Z-o03v (finished, done): 1/1"
    )
    turns = build(
        [
            human("q"),
            ai("", [("backstage", {"tasks": []}, "b1")]),
            result("b1", text),
            ai("", [("stage_status", {}, "b2")]),
            result("b2", status_text),
            ai("", [("web_search", {}, "b3")]),
            result("b3", "Backstage run run-nope appears in a search result"),
        ]
    )
    ids = {e["id"]: e["stage_run_id"] for e in turns[0]["events"]}
    assert ids["b1"] == "run-jev-2026-10-05T09-51-33-446Z-o03v"
    assert ids["b2"] == "run-llm-2026-10-06T08-00-00-000Z-abcd"  # the first match
    assert ids["b3"] is None  # only those two tools name a run


def test_stage_run_id_is_none_without_a_match():
    [turn] = build(
        [
            human("q"),
            ai("", [("backstage", {}, "b1")]),
            result("b1", "Error: Backstage didn't start: no installed app called Foo"),
        ]
    )
    assert turn["events"][0]["stage_run_id"] is None


# --- data URIs ---------------------------------------------------------------------


def test_a_long_data_uri_is_replaced_by_a_size_marker_everywhere():
    uri = "data:image/png;base64," + "A" * 600
    surface = {"surface": {"components": [{"type": "Image", "src": uri}]}}
    [turn] = build(
        [
            human("q"),
            ai("", [("render_ui", surface, "c1")]),
            result("c1", f"rendered ![x]({uri}) done"),
        ]
    )
    event = turn["events"][0]
    marker = f"<data URI: image/png, {len(uri)} chars>"
    assert event["input"]["surface"]["components"][0]["src"] == marker
    assert event["output"] == f"rendered ![x]({marker}) done"


def test_short_data_uris_and_every_other_string_are_left_whole():
    short = "data:text/plain;base64,aGVsbG8="
    exactly_500 = "data:text/plain," + "a" * (500 - len("data:text/plain,"))
    long_prose = "word " * 20_000
    assert elide_data_uris(short) == short
    assert elide_data_uris(exactly_500) == exactly_500
    assert elide_data_uris({"k": [long_prose]}) == {"k": [long_prose]}


def test_a_data_uri_with_no_mime_type_is_named_text_plain():
    uri = "data:," + "x" * 600
    assert elide_data_uris(uri) == f"<data URI: text/plain, {len(uri)} chars>"


def test_dict_keys_are_never_rewritten_and_non_strings_pass_through():
    assert elide_data_uris({"n": 3, "ok": True, "none": None}) == {"n": 3, "ok": True, "none": None}


def test_a_malformed_data_uri_does_not_make_the_matcher_backtrack_badly():
    nasty = "see data:image/png" + ";" * 5000 + "no comma here"
    assert elide_data_uris(nasty) == nasty
    assert elide_data_uris(nasty.removeprefix("see ")) == nasty.removeprefix("see ")


def test_long_prose_that_merely_starts_with_data_is_not_mistaken_for_a_data_uri():
    prose = "data: the quarterly numbers are in, " + "and they look fine. " * 100
    assert len(prose) > DATA_URI_MIN_CHARS
    assert elide_data_uris(prose) == prose


def test_a_whole_string_data_uri_is_elided_whatever_its_payload_characters():
    uri = "data:text/html," + "<p>hi</p>" * 100
    assert elide_data_uris(uri) == f"<data URI: text/html, {len(uri)} chars>"


# --- clipped and invalid inputs ------------------------------------------------------


def test_an_input_the_store_clipped_comes_back_as_its_raw_text():
    clipped = '{"surface": "' + "x" * 50 + '"\n[… 99 more characters not stored]'
    [turn] = build(
        [human("q"), ai("", [("research_agent", {"request": "x"}, "p1")]), result("p1", "r")],
        [row(1, "s1", "render_ui", parent="p1", agent="research_agent", input=clipped)],
    )
    assert turn["events"][0]["children"][0]["input"] == clipped


def test_a_tool_call_with_invalid_arguments_shows_as_an_error_event():
    message = AIMessage(
        content="",
        invalid_tool_calls=[
            {
                "name": "render_ui",
                "args": '{"surface": {"components": [',
                "id": "bad1",
                "error": "Malformed args.",
                "type": "invalid_tool_call",
            }
        ],
    )
    [turn] = build([human("q"), message])
    [event] = turn["events"]
    assert event["kind"] == "tool"
    assert event["name"] == "render_ui"
    assert event["input"] == '{"surface": {"components": ['
    assert event["status"] == "error"
    assert event["output"] == "Malformed args."


# --- pagination ----------------------------------------------------------------------


def _five_turns():
    messages = []
    for i in range(5):
        messages += [human(f"q{i}"), ai(f"a{i}")]
    return messages


def _page(**kwargs):
    total, turns = trace_page(_five_turns(), [], delegation_names=DELEGATIONS, **kwargs)
    return total, [t["index"] for t in turns]


def test_the_default_page_is_the_most_recent_turns_oldest_first():
    assert _page(limit=2) == (5, [3, 4])
    assert _page(limit=30) == (5, [0, 1, 2, 3, 4])


def test_before_pages_backwards_through_the_thread():
    assert _page(limit=2, before=3) == (5, [1, 2])
    assert _page(limit=2, before=1) == (5, [0])
    assert _page(limit=2, before=0) == (5, [])


def test_before_beyond_the_end_is_clamped():
    assert _page(limit=2, before=99) == (5, [3, 4])


def test_paging_all_the_way_back_visits_every_turn_exactly_once():
    seen: list[int] = []
    before = None
    while True:
        total, indexes = _page(limit=2, before=before)
        if not indexes:
            break
        seen = indexes + seen
        before = indexes[0]
    assert seen == [0, 1, 2, 3, 4]


def test_only_the_requested_turns_are_built():
    page = trace_page(_five_turns(), [], limit=1, delegation_names=DELEGATIONS)[1]
    assert [t["user"]["content"] for t in page] == ["q4"]


# --- defaults ------------------------------------------------------------------------


def test_delegation_names_default_to_the_supervisors_specialist_set():
    """build_trace(messages, calls) alone must already mark delegations — the
    spec's two-argument form. (Imports supervisor.py, so only this test does.)"""
    turns = build_trace(
        [
            human("q"),
            ai("", [("coding_agent", {}, "c1"), ("web_search", {}, "c2")]),
            result("c1", "x"),
            result("c2", "y"),
        ],
        [],
    )
    delegations = {e["name"]: e["delegation"] for e in turns[0]["events"]}
    assert delegations == {"coding_agent": "coding_agent", "web_search": None}


def test_the_default_set_includes_the_stage_tools_a_run_link_hangs_off():
    from assistant import supervisor

    assert {"backstage", "onstage"} <= set(supervisor._SPECIALIST_TOOL_NAMES)


# --- the endpoint --------------------------------------------------------------------


class StubGraph:
    """Stands in for `app.state.graph`: the one method the endpoints call."""

    def __init__(self, messages):
        self.messages = messages
        self.configs = []

    async def aget_state(self, config):
        self.configs.append(config)
        return SimpleNamespace(values={"messages": self.messages})


@pytest.fixture()
def env(monkeypatch, tmp_path):
    from assistant import server, thread_store

    monkeypatch.setattr(thread_store, "DEFAULT_DB_PATH", tmp_path / "threads.sqlite")
    monkeypatch.setattr(trace_store, "DEFAULT_DB_PATH", tmp_path / "traces.sqlite")
    graph = StubGraph(
        [
            human("first"),
            ai("", [("coding_agent", {"request": "ls"}, "p1")]),
            result("p1", "a.txt"),
            ai("listed"),
            human("second"),
            ai("again"),
        ]
    )
    monkeypatch.setattr(server.app.state, "graph", graph, raising=False)
    active = asyncio.run(thread_store.get_active_thread_id(db_path=tmp_path / "threads.sqlite"))
    return SimpleNamespace(server=server, graph=graph, thread_id=active, thread_store=thread_store)


def _client(env, **kwargs):
    from fastapi.testclient import TestClient

    return TestClient(env.server.app, **kwargs)  # no `with`: the real lifespan must not run


def test_the_endpoint_returns_the_active_threads_turns_with_their_children(env):
    asyncio.run(
        trace_store.record_call(
            env.thread_id,
            "s1",
            "coding_agent",
            "run_claude_code",
            parent_tool_call_id="p1",
            input='{"task": "ls"}',
            output="a.txt",
        )
    )
    response = _client(env).get("/history/trace")
    assert response.status_code == 200
    body = response.json()
    assert body["thread_id"] == env.thread_id
    assert body["total_turns"] == 2
    assert [t["index"] for t in body["turns"]] == [0, 1]
    delegation = body["turns"][0]["events"][0]
    assert delegation["name"] == "coding_agent"
    assert delegation["delegation"] == "coding_agent"  # the server passes supervisor's real set
    assert [c["name"] for c in delegation["children"]] == ["run_claude_code"]
    assert delegation["children"][0]["input"] == {"task": "ls"}
    assert env.graph.configs[0]["configurable"]["thread_id"] == env.thread_id


def test_the_endpoint_serves_surfaces_extras_and_a_specialists_mixed_children(env):
    """Through the real route and the real store: a delegation whose ToolMessage
    carries a card (a big embedded image, not elided) and a phone action, over
    two stored rows — a model turn and a tool call."""
    env.graph.messages = [
        human("show me"),
        ai("", [("research_agent", {"request": "find it"}, "p1")]),
        result("p1", "Found it.", a2ui_surface=[SURFACE], phone_action=PHONE_ACTION),
        ai("Here you go."),
    ]
    record = trace_store.record_call
    asyncio.run(
        record(
            env.thread_id,
            "msg_1",
            "research_agent",
            "claude-sonnet-5",
            parent_tool_call_id="p1",
            kind=trace_store.KIND_ASSISTANT,
            output="Searching.",
            thinking="Need current data.",
            extras=json.dumps({"usage": {"input_tokens": 9, "output_tokens": 4}}),
            duration_ms=700,
        )
    )
    asyncio.run(
        record(
            env.thread_id,
            "s1",
            "research_agent",
            "web_search",
            parent_tool_call_id="p1",
            input='{"q": "x"}',
            output="3 hits",
            extras=json.dumps({"note": BIG_URI}),
        )
    )
    body = _client(env).get("/history/trace").json()
    delegation = body["turns"][0]["events"][0]
    assert delegation["surfaces"] == [SURFACE]
    assert delegation["surfaces"][0]["components"][1]["url"] == BIG_URI  # not elided, over the wire
    assert delegation["extras"] == {"phone_action": PHONE_ACTION}
    model, tool = delegation["children"]
    assert (model["kind"], model["text"], model["thinking"], model["model"]) == (
        "assistant",
        "Searching.",
        "Need current data.",
        "claude-sonnet-5",
    )
    assert model["usage"] == {"input_tokens": 9, "output_tokens": 4}
    assert (tool["kind"], tool["name"], tool["input"], tool["surfaces"]) == (
        "tool",
        "web_search",
        {"q": "x"},
        [],
    )
    assert tool["extras"] == {"note": f"<data URI: image/png, {len(BIG_URI)} chars>"}


def test_limit_and_before_page_the_turns(env):
    client = _client(env)
    latest = client.get("/history/trace", params={"limit": 1}).json()
    assert (latest["total_turns"], [t["index"] for t in latest["turns"]]) == (2, [1])
    earlier = client.get("/history/trace", params={"limit": 1, "before": 1}).json()
    assert [t["index"] for t in earlier["turns"]] == [0]
    assert client.get("/history/trace", params={"before": 0}).json()["turns"] == []


@pytest.mark.parametrize(
    "params", [{"limit": 0}, {"limit": 201}, {"before": -1}, {"limit": "many"}]
)
def test_bad_paging_parameters_are_rejected(env, params):
    assert _client(env).get("/history/trace", params=params).status_code == 422


def test_an_explicit_thread_id_is_used_and_an_unknown_one_is_a_404(env):
    created = asyncio.run(
        env.thread_store.create_thread(title="other", db_path=env.thread_store.DEFAULT_DB_PATH)
    )
    client = _client(env)
    ok = client.get("/history/trace", params={"thread_id": created.id})
    assert ok.status_code == 200 and ok.json()["thread_id"] == created.id
    assert client.get("/history/trace", params={"thread_id": "no-such-thread"}).status_code == 404


def test_a_thread_with_no_messages_is_an_empty_page(env):
    env.graph.messages = []
    body = _client(env).get("/history/trace").json()
    assert (body["total_turns"], body["turns"]) == (0, [])


def test_only_this_computer_may_read_the_trace(env):
    remote = _client(env, client=("203.0.113.9", 4242))
    assert remote.get("/history/trace").status_code == 403
    # a loopback address with someone else's hostname (DNS rebinding, a proxy)
    assert (
        _client(env, client=("127.0.0.1", 4242), base_url="http://evil.example")
        .get("/history/trace")
        .status_code
        == 403
    )
    assert (
        _client(env, client=("127.0.0.1", 4242), base_url="http://127.0.0.1:8000")
        .get("/history/trace")
        .status_code
        == 200
    )


def test_existing_endpoints_keep_their_access(env):
    """The loopback rule is only on the new routes: /history still answers a
    remote client, exactly as before (the iPhone dashboard uses it)."""
    remote = _client(env, client=("203.0.113.9", 4242))
    assert remote.get("/history").status_code == 200


def test_history_itself_is_unchanged(env):
    body = _client(env).get("/history").json()
    assert set(body) == {"messages", "thread_id"}
    assert set(body["messages"][0]) == {"role", "content", "synthetic", "name", "surfaces"}


def test_the_builder_does_not_pull_in_the_graph_at_import():
    """history_trace stays import-light: supervisor.py (the whole graph, and a
    Langfuse prompt fetch at import) is imported lazily, and only when the
    caller doesn't pass delegation names."""
    probe = "import sys, assistant.history_trace;print('assistant.supervisor' in sys.modules)"
    done = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, check=True)
    assert done.stdout.strip() == "False"
