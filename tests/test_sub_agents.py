"""Tests for assistant.sub_agents — currently just the NoParallelMacWrites
guardrail (Phase 13) and that mac_control_agent's tool list actually wires
in the new Apple Calendar / Brave tools, mirroring test_supervisor.py's
NoParallelHandoffs tests and STEPS.md 47's "routing silently breaks if it
isn't described anywhere" lesson.
"""

import asyncio
from types import SimpleNamespace

from assistant.mac_tools import TOOLS as MAC_CONTROL_TOOLS
from assistant.sub_agents import (
    LIFE_ADMIN_SYSTEM_PROMPT,
    MAC_CONTROL_SYSTEM_PROMPT,
    RESEARCH_SYSTEM_PROMPT,
    NoParallelMacWrites,
    _life_admin_unavailable_integrations_note,
    build_life_admin_agent,
    build_research_agent,
)


def test_no_parallel_mac_writes_forces_parallel_tool_calls_false() -> None:
    """Phase 13 gave mac_control_agent a second and third gated tool
    (calendar_create_event, calendar_update_event, alongside the existing
    run_shortcut) — without this, a compound request could make the model
    call two gated tools in one AIMessage, and server.py's
    _serialize_turn_result only relays the FIRST pending interrupt, silently
    stranding the second one's approval/decline. Same fix as
    write_tools.py's NoParallelWrites and supervisor.py's
    NoParallelHandoffs."""
    middleware = NoParallelMacWrites()
    request = SimpleNamespace(model_settings={})

    async def fake_handler(req):
        return req

    result = asyncio.run(middleware.awrap_model_call(request, fake_handler))
    assert result.model_settings == {"parallel_tool_calls": False}


def test_no_parallel_mac_writes_preserves_other_model_settings() -> None:
    middleware = NoParallelMacWrites()
    request = SimpleNamespace(model_settings={"some_other_setting": "value"})

    async def fake_handler(req):
        return req

    result = asyncio.run(middleware.awrap_model_call(request, fake_handler))
    assert result.model_settings == {
        "some_other_setting": "value",
        "parallel_tool_calls": False,
    }


def test_mac_control_tools_include_calendar_and_brave() -> None:
    names = {t.name for t in MAC_CONTROL_TOOLS}
    assert {
        "calendar_list_events",
        "calendar_create_event",
        "calendar_update_event",
        "open_url_in_brave",
    } <= names


def test_mac_control_system_prompt_mentions_new_capabilities() -> None:
    """Phase 3's lesson (STEPS.md, referenced throughout this codebase):
    whatever owns a tool must be DESCRIBED in its agent's system prompt, or
    routing/tool-selection silently breaks even though the tool technically
    exists."""
    prompt = MAC_CONTROL_SYSTEM_PROMPT
    assert "Apple Calendar" in prompt
    assert "Google Calendar" in prompt  # disambiguation, not just a mention
    assert "Brave" in prompt


def test_mac_control_system_prompt_tells_model_to_call_gated_tools_directly() -> None:
    """Phase 14 fix (STEPS.md 69 section 2's gate-UX-friction finding): the
    model sometimes asked the user for confirmation in chat BEFORE calling
    run_shortcut/calendar_create_event/calendar_update_event, instead of
    just calling the tool and letting its own interrupt() fire — not a
    security gap (the structural gate still held) but real friction.
    LIFE_ADMIN_SYSTEM_PROMPT already had this exact instruction since Phase
    12 (STEPS.md 63); MAC_CONTROL_SYSTEM_PROMPT never did until now."""
    prompt = MAC_CONTROL_SYSTEM_PROMPT
    assert "just call the tool directly" in prompt
    assert "never ask the user to confirm in chat before calling it" in prompt


def test_research_agent_carries_render_ui() -> None:
    """Phase 18 (PLAN.md): render_ui is no longer supervisor-only —
    research_agent is one of the two specialists it was extended to. Cheap,
    offline structural check that the tool is actually bound onto the
    compiled graph's ToolNode, mirroring
    test_mac_control_tools_include_calendar_and_brave above; the real,
    costed, live verification that the extension actually WORKS across a
    nested specialist boundary is
    tests/test_a2ui.py::test_render_ui_available_on_delegated_specialist_and_persists,
    not repeated here."""
    graph = build_research_agent()
    tool_names = set(graph.get_graph().nodes["tools"].data.tools_by_name)
    assert {"tavily_search", "render_ui"} <= tool_names


def test_life_admin_agent_carries_render_ui() -> None:
    """Same Phase 18 extension, the other specialist it was added to."""
    graph = build_life_admin_agent([])
    tool_names = set(graph.get_graph().nodes["tools"].data.tools_by_name)
    assert "render_ui" in tool_names


def test_research_system_prompt_mentions_render_ui() -> None:
    """Phase 3's "whatever owns a tool must be DESCRIBED in its agent's
    system prompt" lesson, same as test_mac_control_system_prompt_mentions_
    new_capabilities above — a tool the model doesn't know it has is a tool
    it will rarely think to use."""
    assert "render_ui" in RESEARCH_SYSTEM_PROMPT


def test_life_admin_system_prompt_mentions_render_ui() -> None:
    assert "render_ui" in LIFE_ADMIN_SYSTEM_PROMPT


def test_life_admin_unavailable_integrations_note() -> None:
    """STEPS.md 151: the note only appears when an integration is actually
    missing, and names which one(s) — checked via SimpleNamespace fakes
    with a `.name`, no real MCP tools/network needed."""
    gmail_tool = SimpleNamespace(name="search_emails")
    calendar_tool = SimpleNamespace(name="list-events")

    assert _life_admin_unavailable_integrations_note([gmail_tool, calendar_tool]) == ""

    both_missing = _life_admin_unavailable_integrations_note([])
    assert "Gmail and Google Calendar are" in both_missing

    gmail_missing = _life_admin_unavailable_integrations_note([calendar_tool])
    assert "Gmail is currently unavailable" in gmail_missing

    calendar_missing = _life_admin_unavailable_integrations_note([gmail_tool])
    assert "Google Calendar is currently unavailable" in calendar_missing


if __name__ == "__main__":
    test_no_parallel_mac_writes_forces_parallel_tool_calls_false()
    print("OK: test_no_parallel_mac_writes_forces_parallel_tool_calls_false")
    test_no_parallel_mac_writes_preserves_other_model_settings()
    print("OK: test_no_parallel_mac_writes_preserves_other_model_settings")
    test_mac_control_tools_include_calendar_and_brave()
    print("OK: test_mac_control_tools_include_calendar_and_brave")
    test_mac_control_system_prompt_mentions_new_capabilities()
    print("OK: test_mac_control_system_prompt_mentions_new_capabilities")
    test_mac_control_system_prompt_tells_model_to_call_gated_tools_directly()
    print("OK: test_mac_control_system_prompt_tells_model_to_call_gated_tools_directly")
    test_research_agent_carries_render_ui()
    print("OK: test_research_agent_carries_render_ui")
    test_life_admin_agent_carries_render_ui()
    print("OK: test_life_admin_agent_carries_render_ui")
    test_research_system_prompt_mentions_render_ui()
    print("OK: test_research_system_prompt_mentions_render_ui")
    test_life_admin_system_prompt_mentions_render_ui()
    print("OK: test_life_admin_system_prompt_mentions_render_ui")
    test_life_admin_unavailable_integrations_note()
    print("OK: test_life_admin_unavailable_integrations_note")
    print("\n10 tests passed")
