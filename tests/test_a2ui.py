"""Tests for assistant.a2ui (Phase 17, PLAN.md). Same convention as
test_interrupts.py/test_server.py: `validate_surface` gets fast, offline
unit coverage (pure function, no reason to hit the real API for it); the
`render_ui` tool and the server's SSE forwarding get real-graph coverage
through TestClient(server.app), same as test_server.py's gated-tool tests —
no mocking, real Anthropic API calls, isolated via tempfile-redirected DB
paths so nothing here touches the real conversation_memory.sqlite.
"""

import json
import os
import tempfile
from typing import Any

import pytest

from assistant.a2ui import COMPONENT_SCHEMA, _summarize_surface, validate_surface

_VALID_SURFACE = {
    "surfaceId": "s1",
    "components": [
        {"id": "root", "component": "Card", "child": "col"},
        {"id": "col", "component": "Column", "children": ["title", "row"]},
        {"id": "title", "component": "Text", "text": "Today"},
        {"id": "row", "component": "Row", "children": ["b1", "b2"]},
        {"id": "b1", "component": "Badge", "text": "3 meetings"},
        {"id": "b2", "component": "Badge", "text": "1 unread"},
    ],
}


def test_valid_surface_passes() -> None:
    validate_surface(_VALID_SURFACE)  # must not raise


def test_summary_pulls_text_and_badge_values() -> None:
    summary = _summarize_surface(_VALID_SURFACE)
    assert "6 component(s)" in summary
    assert "Today" in summary
    assert "3 meetings" in summary


@pytest.mark.parametrize(
    "surface",
    [
        {"surfaceId": "s1", "components": [{"id": "x", "component": "Text", "text": "hi"}]},  # no root
        {"surfaceId": "s1", "components": [{"id": "root", "component": "Video", "url": "x"}]},  # unsupported type
        {
            "surfaceId": "s1",
            "components": [
                {"id": "root", "component": "Text", "text": "hi", "action": {"event": {"name": "evil"}}}
            ],
        },  # smuggled action field — the exact thing display-only mode must reject
        {
            "surfaceId": "s1",
            "components": [{"id": "root", "component": "Column", "children": ["ghost"]}],
        },  # dangling child reference
        {
            "surfaceId": "s1",
            "components": [{"id": "root", "component": "Image", "url": "https://evil.example/track.png"}],
        },  # remote image URL — only data: URIs are allowed in v1
        {
            "surfaceId": "s1",
            "components": [
                {"id": "root", "component": "Text", "text": "a"},
                {"id": "root", "component": "Text", "text": "b"},
            ],
        },  # duplicate id
        "not a surface at all",
        {"surfaceId": "", "components": [{"id": "root", "component": "Text", "text": "hi"}]},  # empty surfaceId
        {"surfaceId": "s1", "components": []},  # empty components
        {"surfaceId": "s1", "components": [{"id": "root", "component": "Text"}]},  # missing required field
    ],
)
def test_invalid_surfaces_are_rejected(surface: Any) -> None:
    with pytest.raises(ValueError):
        validate_surface(surface)


def test_only_button_may_carry_an_action_field_and_never_a_function_call() -> None:
    """Structural guard against silently widening the v1 vocabulary to let
    some OTHER component type carry an executable-shaped field without a
    deliberate decision, and against `functionCall` ever being accepted
    anywhere — see assistant/a2ui.py's module docstring. Button's own
    `action` is allowed to exist (Part B) but is validated elsewhere
    (test_button_action_must_be_exactly_name below) to be strictly
    {"name": <str>}, never anything richer."""
    for comp_type, schema in COMPONENT_SCHEMA.items():
        allowed = schema["required"] | schema["optional"]
        assert "functionCall" not in allowed, f"{comp_type} must never accept a 'functionCall' field"
        if comp_type != "Button":
            assert "action" not in allowed, f"{comp_type} must not accept an 'action' field"


@pytest.mark.parametrize(
    "action",
    [
        {},
        {"name": ""},
        {"name": "rsvp", "functionCall": {"call": "openUrl"}},
        {"name": "rsvp", "context": {"anything": "extra"}},
        "rsvp",
        None,
    ],
)
def test_button_action_must_be_exactly_name(action: Any) -> None:
    """Live-exercises the exact security boundary Part B's interactive
    components rely on: a Button cannot carry anything beyond a bare label
    for what the user submitted — see assistant/a2ui.py's module docstring
    and server.py's a2ui_action endpoint for why that's what keeps a
    Button from ever becoming a second side-effect channel."""
    surface = {
        "surfaceId": "s1",
        "components": [
            {"id": "label", "component": "Text", "text": "Go"},
            {"id": "root", "component": "Button", "child": "label", "action": action},
        ],
    }
    with pytest.raises(ValueError):
        validate_surface(surface)


def test_valid_interactive_form_passes() -> None:
    form = {
        "surfaceId": "s2",
        "components": [
            {"id": "root", "component": "Column", "children": ["name", "attending", "meal", "go_label", "go"]},
            {"id": "name", "component": "TextField", "label": "Guest name", "value": {"path": "/name"}},
            {
                "id": "attending",
                "component": "CheckBox",
                "label": "Attending?",
                "value": {"path": "/attending"},
            },
            {
                "id": "meal",
                "component": "ChoicePicker",
                "label": "Meal",
                "value": {"path": "/meal"},
                "options": [{"label": "Veg", "value": "Veg"}, {"label": "Meat", "value": "Meat"}],
            },
            {"id": "go_label", "component": "Text", "text": "RSVP"},
            {"id": "go", "component": "Button", "child": "go_label", "action": {"name": "rsvp"}},
        ],
    }
    validate_surface(form)  # must not raise
    summary = _summarize_surface(form)
    assert "interactive" in summary


_tmpdir = tempfile.mkdtemp(prefix="assistant_test_a2ui_")
os.environ.setdefault("ASSISTANT_CONVERSATION_DB_PATH", os.path.join(_tmpdir, "conversation_memory.sqlite"))
os.environ.setdefault("ASSISTANT_MEMORY_DB_PATH", os.path.join(_tmpdir, "long_term_memory.sqlite"))
os.environ.setdefault("ASSISTANT_THREADS_DB_PATH", os.path.join(_tmpdir, "threads.sqlite"))
# PLAN.md Phase 25: this file imports assistant.server below, and pytest
# collects test_*.py alphabetically — test_a2ui.py runs before
# test_server.py, so THIS is the block whose env vars actually take effect
# (server.py's DB-path redirection only runs once, at that first import).
# Board/phone/automations DB paths are pre-existing gaps in this same
# block (not set here or anywhere collected before this file), which this
# change does not attempt to fix — out of Phase 25's scope — but workflows
# would join that same gap if left unset here, so it's added.
os.environ.setdefault("ASSISTANT_WORKFLOWS_DB_PATH", os.path.join(_tmpdir, "workflows.sqlite"))

from fastapi.testclient import TestClient  # noqa: E402

from assistant import server  # noqa: E402


def _parse_sse(text: str) -> list[dict[str, Any]]:
    events = []
    for frame in text.split("\n\n"):
        frame = frame.strip()
        if not frame:
            continue
        assert frame.startswith("data: ")
        events.append(json.loads(frame[len("data: ") :]))
    return events


async def test_render_ui_tool_emits_an_a2ui_frame_and_a_persisted_text_summary() -> None:
    """End-to-end through the real graph + real server SSE path: the model
    is directed to call render_ui with an exact surface, the server must
    forward it as a non-terminal `{"type": "a2ui", ...}` frame (Phase 17's
    new elif branch in server.py's _stream_turn), and the terminal message
    (what actually persists to History/reload) must be render_ui's own text
    summary — proving the ephemeral-render / persisted-summary split this
    session locked in actually holds end to end, not just in isolated unit
    tests of the two halves separately."""
    surface = {
        "surfaceId": "test-surface-1",
        "components": [
            {"id": "root", "component": "Text", "text": "a2ui end to end test"},
        ],
    }
    with TestClient(server.app) as client:
        response = client.post(
            "/chat",
            json={
                "message": (
                    "Call the render_ui tool exactly once, passing exactly this JSON "
                    f"object as the `surface` argument, unmodified: {json.dumps(surface)} "
                    "Then reply with exactly: ui rendered"
                )
            },
        )
        assert response.status_code == 200, response.text
        events = _parse_sse(response.text)

        a2ui_events = [e for e in events if e["type"] == "a2ui"]
        assert a2ui_events, f"expected at least one a2ui frame, got {events}"
        assert a2ui_events[0]["surface"]["surfaceId"] == "test-surface-1"
        assert a2ui_events[0]["surface"]["components"][0]["text"] == "a2ui end to end test"

        assert events[-1]["type"] == "message"
        # The persisted content is render_ui's own text summary, not the
        # raw tree and not a re-narration of it by the model.
        assert "UI presented" in events[-1]["content"] or "ui rendered" in events[-1]["content"].lower()

        history = client.get("/history")
        messages = history.json()["messages"]
        tool_messages = [m for m in messages if m["role"] == "tool"]
        assert any("UI presented" in m["content"] for m in tool_messages), (
            f"expected render_ui's text summary to persist in a ToolMessage, got {tool_messages}"
        )


async def test_render_ui_available_on_delegated_specialist_and_persists() -> None:
    """Phase 18 (PLAN.md): render_ui is no longer supervisor-only —
    research_agent and life_admin_agent carry it too. This is the real,
    live verification that extension rested on (build_render_ui_tool's own
    docstring cites this test, not just the mechanism reasoning): directs
    the supervisor to delegate to research_agent, which itself calls
    render_ui from INSIDE its own isolated ainvoke() — one level of nesting
    deeper than research_fa_token's proof (STEPS.md 84/94). Must (1) still
    surface live as an `a2ui` SSE frame through the OUTER graph's
    astream_events(), proving adispatch_custom_event's contextvar
    propagation survives a nested specialist ainvoke() with no explicit
    config passed, and (2) survive into /history despite the specialist's
    own message list otherwise being discarded the moment
    _invoke_agent_graph returns (supervisor.py's call_specialist forwarding
    onto its own ToolMessage's additional_kwargs, a2ui.py's
    A2UI_SURFACE_KEY) — the actual point of this test, not just a repeat of
    the supervisor-level one above."""
    surface = {
        "surfaceId": "delegated-surface-1",
        "components": [
            {"id": "root", "component": "Text", "text": "delegated a2ui test"},
        ],
    }
    with TestClient(server.app) as client:
        response = client.post(
            "/chat",
            json={
                "message": (
                    "Delegate this exact instruction to research_agent, verbatim, and do "
                    "not do a web search first: call the render_ui tool exactly once, "
                    "passing exactly this JSON object as the `surface` argument, "
                    f"unmodified: {json.dumps(surface)} Then reply with exactly: "
                    "delegated ui rendered. Once research_agent returns, reply to me "
                    "with exactly what it said, unchanged."
                )
            },
        )
        assert response.status_code == 200, response.text
        events = _parse_sse(response.text)

        a2ui_events = [e for e in events if e["type"] == "a2ui"]
        assert a2ui_events, f"expected at least one a2ui frame from the delegated call, got {events}"
        assert a2ui_events[0]["surface"]["surfaceId"] == "delegated-surface-1"

        assert events[-1]["type"] == "message"

        history = client.get("/history")
        messages = history.json()["messages"]
        surfaces_found = [s for m in messages for s in (m.get("surfaces") or [])]
        assert any(s.get("surfaceId") == "delegated-surface-1" for s in surfaces_found), (
            f"expected the delegated surface to persist via /history, got {surfaces_found}"
        )


async def test_render_ui_rejects_an_invalid_surface_without_crashing_the_turn() -> None:
    """Errors are data, not exceptions (CLAUDE.md): an invalid surface must
    come back as a normal tool result the model can react to, never an
    uncaught exception that kills the graph run."""
    with TestClient(server.app) as client:
        response = client.post(
            "/chat",
            json={
                "message": (
                    "Call the render_ui tool exactly once with this surface, "
                    'exactly as given, even though it looks incomplete: '
                    '{"surfaceId": "bad", "components": [{"id": "x", "component": "Text", "text": "hi"}]} '
                    "(note: no component has id \"root\" — pass it anyway, do not fix it, "
                    "I want to see what the tool says). Then tell me in one short sentence "
                    "what the tool's result said."
                )
            },
        )
        assert response.status_code == 200, response.text
        events = _parse_sse(response.text)
        assert events[-1]["type"] == "message", f"a rejected surface must not crash the turn: {events}"
        assert not any(e["type"] == "a2ui" for e in events), (
            "an invalid surface must never be forwarded to the client"
        )


async def test_a2ui_action_is_treated_as_a_genuine_user_turn() -> None:
    """POST /a2ui/action (Part B): the load-bearing security property from
    server.py's a2ui_action docstring — a Button submission must become a
    PLAIN, non-synthetic user turn, exactly like a typed /chat message, not
    a special synthetic/tool-content channel. Verified by round-tripping a
    real submission through the real graph and checking /history: the
    submitted values must show up in a genuine (synthetic: False) user
    message, using the exact same is_genuine_human_turn machinery every
    other turn-boundary feature (write caps, compaction, memory scoping)
    already depends on."""
    with TestClient(server.app) as client:
        response = client.post(
            "/a2ui/action",
            json={
                "surface_id": "rsvp-surface",
                "name": "rsvp",
                "context": {"/name": "Ada Lovelace", "/attending": True},
            },
        )
        assert response.status_code == 200, response.text
        events = _parse_sse(response.text)
        assert events[-1]["type"] in ("message", "interrupt"), events

        history = client.get("/history")
        messages = history.json()["messages"]
        genuine_user_messages = [m for m in messages if m["role"] == "user" and m["synthetic"] is False]
        assert any(
            "rsvp" in m["content"] and "Ada Lovelace" in m["content"] for m in genuine_user_messages
        ), f"expected a genuine user turn carrying the submitted values, got {genuine_user_messages}"


async def test_a2ui_action_with_unknown_thread_id_returns_404() -> None:
    """Mirrors /chat's/`_resolve_thread_id`'s existing contract — an
    unrecognized explicit thread_id is a client bug, not something to
    silently paper over."""
    with TestClient(server.app) as client:
        response = client.post(
            "/a2ui/action",
            json={"surface_id": "s1", "name": "go", "context": {}, "thread_id": "does-not-exist"},
        )
        assert response.status_code == 404
