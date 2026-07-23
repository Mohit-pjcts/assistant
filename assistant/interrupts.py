"""Dummy confirmation-gated tool — demonstrates the LangGraph interrupt
mechanic ahead of any real side-effect tool existing (Phase 3 step 5,
implementing CLAUDE.md's standing confirmation rule). Delete or replace once
a real side-effectful tool (e.g. sending email) needs this pattern.
"""

from __future__ import annotations

from typing import Annotated, NotRequired, TypedDict

from langchain_core.messages import AnyMessage
from langchain_core.tools import tool
from langgraph.graph.message import add_messages
from langgraph.prebuilt import InjectedState
from langgraph.types import interrupt


class _AgentState(TypedDict):
    """Mirrors sub_agents.GatedAgentState's relevant shape — duplicated
    rather than imported to avoid a circular import (sub_agents -> ... ->
    interrupts), same rationale as write_tools.py's own local `_AgentState`."""

    messages: Annotated[list[AnyMessage], add_messages]
    pre_approved_actions: NotRequired[set[str]]


@tool
def send_test_notification(
    message: str,
    state: Annotated[_AgentState, InjectedState],
) -> str:
    """Simulate sending a notification (no real side effect) — asks for
    confirmation first via a LangGraph interrupt, UNLESS the supervisor
    already got upfront confirmation for "send_test_notification" this turn
    (supervisor.py's `request_gated_action_confirmation` /
    GATED_ACTIONS — see sub_agents.py's module docstring for the full
    design). Skipping interrupt() here only ever happens when that
    specific action name was explicitly pre-cleared; any other case still
    gates exactly as before.

    Args:
        message: The notification text that would be "sent".
    """
    if "send_test_notification" in (state.get("pre_approved_actions") or set()):
        return f"[simulated] notification sent: {message!r}"
    approved = interrupt(
        {
            "action": "send_test_notification",
            "message": message,
            # Ready-to-speak phrasing for the voice daemon's confirmation
            # gate — the structured fields above stay the machine-readable
            # payload; this is only ever read aloud.
            "spoken_prompt": f"Permission to send a notification saying '{message}'?",
        }
    )
    if not approved:
        return "Cancelled — user did not confirm."
    return f"[simulated] notification sent: {message!r}"
