"""Tests for assistant.sub_agents — currently just the NoParallelMacWrites
guardrail (Phase 13) and that mac_control_agent's tool list actually wires
in the new Apple Calendar / Brave tools, mirroring test_supervisor.py's
NoParallelHandoffs tests and STEPS.md 47's "routing silently breaks if it
isn't described anywhere" lesson.
"""

import asyncio
from types import SimpleNamespace

from assistant.mac_tools import TOOLS as MAC_CONTROL_TOOLS
from assistant.sub_agents import MAC_CONTROL_SYSTEM_PROMPT, NoParallelMacWrites


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


if __name__ == "__main__":
    test_no_parallel_mac_writes_forces_parallel_tool_calls_false()
    print("OK: test_no_parallel_mac_writes_forces_parallel_tool_calls_false")
    test_no_parallel_mac_writes_preserves_other_model_settings()
    print("OK: test_no_parallel_mac_writes_preserves_other_model_settings")
    test_mac_control_tools_include_calendar_and_brave()
    print("OK: test_mac_control_tools_include_calendar_and_brave")
    test_mac_control_system_prompt_mentions_new_capabilities()
    print("OK: test_mac_control_system_prompt_mentions_new_capabilities")
    print("\n4 tests passed")
