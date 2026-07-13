"""Dummy confirmation-gated tool — demonstrates the LangGraph interrupt
mechanic ahead of any real side-effect tool existing (Phase 3 step 5,
implementing CLAUDE.md's standing confirmation rule). Delete or replace once
a real side-effectful tool (e.g. sending email) needs this pattern.
"""

from __future__ import annotations

from langchain_core.tools import tool
from langgraph.types import interrupt


@tool
def send_test_notification(message: str) -> str:
    """Simulate sending a notification (no real side effect) — asks for
    confirmation first via a LangGraph interrupt.

    Args:
        message: The notification text that would be "sent".
    """
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
