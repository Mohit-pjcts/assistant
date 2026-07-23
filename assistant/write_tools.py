"""Gated write tools for Gmail + Google Calendar — Phase 12 (STEPS.md 63-64).

Architecture (locked at the Phase 12 step-2 checkpoint, STEPS.md 63): the
confirmation gate cannot sit on the raw Gmail/Calendar MCP tools themselves —
those run in a separate Node process per server and cannot call LangGraph's
interrupt(). Every tool in this module is a LOCAL wrapper instead (same
pattern as mac_tools.run_shortcut): it builds a payload of the VERBATIM
content about to be written, calls interrupt(), and only on approval invokes
the underlying raw MCP tool via .ainvoke(). The raw write tools (send_email,
modify_email, create-event, update-event, delete-event, create_filter,
delete_filter) are never given to a model directly — sub_agents.py's
_select_life_admin_tools exposes ONLY the wrappers this module builds, never
those raw names. mcp_tools.py's _block_calendar_writes interceptor cannot
distinguish "the model called this" from "the approved wrapper called this
after interrupt() returned True", since both paths go through the same
MultiServerMCPClient — the real enforcement point for write access is the
model's tool list (this module + sub_agents.py's selection), not that
interceptor.

TOCTOU: the exact values shown at the gate are the exact values passed to the
raw tool after approval — no re-generation, no re-fetch between showing and
acting. This is easier to guarantee here than in memory_extraction.py's
multi-interrupt-per-node loop, because each wrapper below has exactly ONE
interrupt() call per tool invocation, with the side effect strictly after it
— LangGraph only re-runs a node from the top on resume, and a single
interrupt() per function body means no already-approved side effect ever
sits between two interrupts to be re-run on a later resume (see
memory_extraction.py's docstring for the failure mode this shape avoids).

Read-back requirement: update/delete operate on an opaque ID (eventId,
filterId, messageId) that is not itself human-vettable. Every update/delete/
label-modify wrapper below fetches the REAL current content first
(get-event / get_filter / read_email) and shows THAT at the gate — never the
bare ID, never a model paraphrase of what it thinks the ID refers to.

Per-turn write cap: MAX_WRITES_PER_TURN mirrors supervisor.py's
MAX_HANDOFFS_PER_TURN and memory_extraction.py's MAX_MEMORY_WRITES_PER_TURN —
enforced structurally by counting this turn's already-completed gated-write
ToolMessages via InjectedState, not left to the model's own judgment. Checked
BEFORE interrupt() so a capped-out call doesn't waste a confirmation
round-trip on something that's going to be refused anyway.

No-parallel-writes guard: sub_agents.py disables parallel_tool_calls on
life_admin_agent's model (mirrors supervisor.py's NoParallelHandoffs) —
server.py's _serialize_turn_result only relays the FIRST pending interrupt in
a turn, so two gated tool calls in the same AIMessage would silently strand
the second one's approval/decline.

Scope, deliberately bounded (v1): calendar create/update/delete take the
fields locked at the checkpoint (title/start/end/timezone/location/
attendees/description) — not the raw servers' full schemas (recurrence,
conferenceData, attachments, etc. are out of scope; a future need can extend
these wrappers). Gmail filters go through create_filter directly; this
module does NOT wire in create_filter_from_template — the model constructs
criteria/action itself, same as every other tool here, so there is exactly
one filter-creation code path to keep gated and no template-name-only
display to worry about (PLAN.md's "never shown as a bare template name"
requirement is satisfied by not having a template path at all, not by
resolving one).

Field-name mapping for the read-back parsers below (_read_back_event,
_read_back_filter_text, _read_back_message) is grounded in the actual
installed MCP servers' source (google-calendar-mcp's structured-
responses.ts, Gmail-MCP-Server's index.ts) as of Phase 12 step 3, and
CONFIRMED against real live calls during Phase 12 step 5 (STEPS.md 66):
send_email, create/delete_calendar_event (including a real _read_back_event
parse), create/delete_gmail_filter (including a real _read_back_filter_text
parse), and modify_gmail_labels all round-tripped successfully against the
real Gmail/Calendar APIs. update_calendar_event remains unit-tested only
(fake MCP tools) — not yet exercised live; closing that gap is carried
forward to PLAN.md Phase 14 step 4.
"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any, NotRequired, TypedDict

from langchain_core.messages import AnyMessage, ToolMessage
from langchain_core.tools import BaseTool, tool
from langgraph.graph.message import add_messages
from langgraph.prebuilt import InjectedState
from langgraph.types import interrupt

from assistant.compaction import is_genuine_human_turn

logger = logging.getLogger(__name__)


class _AgentState(TypedDict):
    """Mirrors sub_agents.GatedAgentState's shape — duplicated rather than
    imported to avoid a circular import (supervisor -> sub_agents ->
    write_tools -> supervisor). `pre_approved_actions` backs the upfront-
    confirmation mechanism (supervisor.py's `request_gated_action_confirmation`
    / GATED_ACTIONS — see sub_agents.py's module docstring) every gated tool
    below checks before falling back to its own interrupt()."""

    messages: Annotated[list[AnyMessage], add_messages]
    pre_approved_actions: NotRequired[set[str]]


# Structural cap on gated write-tool calls per top-level turn — mirrors
# supervisor.MAX_HANDOFFS_PER_TURN / memory_extraction.MAX_MEMORY_WRITES_PER_TURN.
# Generous headroom (a real multi-action request needs at most a couple), not
# a tuned limit — purely a runaway-loop / confirmation-fatigue guard.
MAX_WRITES_PER_TURN = 3

_GATED_WRITE_TOOL_NAMES = {
    "send_email",
    "modify_gmail_labels",
    "create_calendar_event",
    "update_calendar_event",
    "delete_calendar_event",
    "create_gmail_filter",
    "delete_gmail_filter",
}

_WRITE_CAP_MESSAGE = (
    f"Cancelled — this turn has already reached its limit of "
    f"{MAX_WRITES_PER_TURN} write actions (send/create/update/delete). "
    "Ask again in a new message if you still need this done."
)


def _count_writes_this_turn(messages: list[AnyMessage]) -> int:
    """Same turn-boundary logic as supervisor._count_handoffs: scoped to
    messages since the most recent GENUINE HumanMessage (is_genuine_human_turn
    already excludes the routing bridge and recalled-facts injection), not
    the thread's lifetime total — this project's fixed THREAD_ID means one
    thread persists forever, so an unscoped count would hit the cap
    permanently after enough accumulated history."""
    turn_start = 0
    for i, m in enumerate(messages):
        if is_genuine_human_turn(m):
            turn_start = i
    return sum(
        1
        for m in messages[turn_start:]
        if isinstance(m, ToolMessage) and (m.name or "") in _GATED_WRITE_TOOL_NAMES
    )


def _find_tool(tools: list[BaseTool], name: str) -> BaseTool | None:
    for t in tools:
        if t.name == name:
            return t
    return None


def _extract_text(result: Any) -> str:
    """Normalize an MCP tool's .ainvoke() result to plain text. Langchain-mcp-
    adapters' default response_format returns the joined text content as a
    plain string; defensively handle the content_and_artifact tuple shape and
    raw content-block lists too, since which one we get in practice hasn't
    been exercised against a live call yet (see module docstring)."""
    if isinstance(result, tuple):
        result = result[0]
    if isinstance(result, list):
        parts = []
        for block in result:
            if isinstance(block, dict) and "text" in block:
                parts.append(block["text"])
            else:
                parts.append(str(block))
        return "\n".join(parts)
    return str(result)


def _parse_json_maybe(text: str) -> dict | None:
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except (ValueError, TypeError):
        return None


async def _read_back_event(get_event_tool: BaseTool, calendar_id: str, event_id: str) -> dict | None:
    """Fetch the REAL current event content before an update/delete gate —
    an opaque eventId alone is not human-vettable. google-calendar-mcp's
    get-event returns a JSON text body shaped {"event": {...}}
    (createStructuredResponse); see structured-responses.ts's
    convertGoogleEventToStructured for the field names relied on here.
    Returns None if the response can't be parsed — callers must refuse to
    proceed rather than show a gate with guessed/incomplete content."""
    raw = await get_event_tool.ainvoke({"calendarId": calendar_id, "eventId": event_id})
    parsed = _parse_json_maybe(_extract_text(raw))
    if parsed is None:
        return None
    event = parsed.get("event")
    if not isinstance(event, dict):
        return None
    start = event.get("start") or {}
    end = event.get("end") or {}
    return {
        "title": event.get("summary", "(no title)"),
        "start": start.get("dateTime") or start.get("date") or "(unknown)",
        "end": end.get("dateTime") or end.get("date") or "(unknown)",
        "timezone": start.get("timeZone") or end.get("timeZone") or "(unspecified)",
        "location": event.get("location") or "",
        "attendees": event.get("attendees") or [],
        "description": event.get("description") or "",
    }


async def _read_back_filter_text(get_filter_tool: BaseTool, filter_id: str) -> str | None:
    """Fetch the REAL current filter content before a delete gate. Unlike
    get-event, Gmail-MCP-Server's get_filter returns pre-formatted, human-
    readable text (server-side mechanical string formatting of the real API
    response — see index.ts's get_filter handler — not an LLM summary), so
    it's shown as-is rather than re-parsed into a dict."""
    raw = await get_filter_tool.ainvoke({"filterId": filter_id})
    text = _extract_text(raw)
    if not text or text.strip() == "":
        return None
    return text


async def _read_back_message(read_email_tool: BaseTool, message_id: str) -> dict | None:
    """Fetch real From/Subject before a label-modify gate — an opaque
    messageId alone is not human-vettable."""
    raw = await read_email_tool.ainvoke({"messageId": message_id})
    text = _extract_text(raw)
    if not text:
        return None
    parsed = _parse_json_maybe(text)
    if parsed is not None:
        return {
            "from": parsed.get("from", "(unknown)"),
            "subject": parsed.get("subject", "(unknown)"),
        }
    # Not JSON — Gmail-MCP-Server's read_email returns formatted text in
    # some versions; show the raw text itself rather than guessing fields.
    return {"raw": text}


def build_write_tools(mcp_tools: list[BaseTool]) -> list[BaseTool]:
    """Build the gated write-tool wrappers, bound via closure to the raw MCP
    tools they call internally after approval.

    Returns ONLY the wrappers — never the raw tools themselves. Each wrapper
    is included only if every raw MCP tool it depends on was actually loaded
    (mirrors the rest of this codebase's graceful degradation when a server
    isn't configured, e.g. server.py's empty-list fallback when
    GMAIL_MCP_SERVER_PATH is unset) — a partially-configured MCP setup (e.g.
    Calendar built but Gmail not) still gets whichever gated tools it can
    actually support, instead of failing to start entirely.
    """
    send_email_raw = _find_tool(mcp_tools, "send_email")
    modify_email_raw = _find_tool(mcp_tools, "modify_email")
    read_email_raw = _find_tool(mcp_tools, "read_email")
    create_event_raw = _find_tool(mcp_tools, "create-event")
    update_event_raw = _find_tool(mcp_tools, "update-event")
    delete_event_raw = _find_tool(mcp_tools, "delete-event")
    get_event_raw = _find_tool(mcp_tools, "get-event")
    create_filter_raw = _find_tool(mcp_tools, "create_filter")
    delete_filter_raw = _find_tool(mcp_tools, "delete_filter")
    get_filter_raw = _find_tool(mcp_tools, "get_filter")

    built: list[BaseTool] = []

    # --- Email: send --------------------------------------------------

    if send_email_raw is not None:

        @tool
        async def send_email(
            to: list[str],
            subject: str,
            body: str,
            cc: list[str] | None = None,
            bcc: list[str] | None = None,
            *,
            state: Annotated[_AgentState, InjectedState],
        ) -> str:
            """Send an email. Requires the user's explicit confirmation,
            which will show the exact recipient(s), subject, and body —
            plaintext only (no HTML) in this version.

            Args:
                to: Recipient email address(es).
                subject: Email subject line.
                body: Plain-text email body — exactly what will be sent, no
                    summarization happens between this and the confirmation.
                cc: Optional CC recipient address(es).
                bcc: Optional BCC recipient address(es).
            """
            if _count_writes_this_turn(state["messages"]) >= MAX_WRITES_PER_TURN:
                return _WRITE_CAP_MESSAGE
            payload = {
                "action": "send_email",
                "to": to,
                "cc": cc or [],
                "bcc": bcc or [],
                "subject": subject,
                "body": body,
                "body_format": "plain",
                "voice_approvable": False,
            }
            if "send_email" in (state.get("pre_approved_actions") or set()):
                approved = True
            else:
                approved = interrupt(payload)
            if not approved:
                return "Cancelled — user did not confirm."
            result = await send_email_raw.ainvoke(
                {"to": to, "subject": subject, "body": body, "cc": cc or [], "bcc": bcc or []}
            )
            return _extract_text(result)

        built.append(send_email)

    # --- Email: label / archive ----------------------------------------

    if modify_email_raw is not None and read_email_raw is not None:

        @tool
        async def modify_gmail_labels(
            message_id: str,
            add_label_ids: list[str] | None = None,
            remove_label_ids: list[str] | None = None,
            *,
            state: Annotated[_AgentState, InjectedState],
        ) -> str:
            """Add/remove labels on an email — including archiving, which is
            removing the 'INBOX' label. Requires the user's explicit
            confirmation, showing the real message (From/Subject, read back
            first since a message ID alone isn't identifiable) and the exact
            label change.

            Args:
                message_id: ID of the message to modify.
                add_label_ids: Label IDs to add (use list_email_labels to see
                    available IDs).
                remove_label_ids: Label IDs to remove — pass ["INBOX"] to
                    archive.
            """
            if _count_writes_this_turn(state["messages"]) >= MAX_WRITES_PER_TURN:
                return _WRITE_CAP_MESSAGE
            message = await _read_back_message(read_email_raw, message_id)
            if message is None:
                return f"Error: could not read back message {message_id!r} to confirm — refusing to proceed blind."
            payload = {
                "action": "modify_gmail_labels",
                "message_id": message_id,
                "message": message,
                "add_label_ids": add_label_ids or [],
                "remove_label_ids": remove_label_ids or [],
                "voice_approvable": False,
            }
            if "modify_gmail_labels" in (state.get("pre_approved_actions") or set()):
                approved = True
            else:
                approved = interrupt(payload)
            if not approved:
                return "Cancelled — user did not confirm."
            result = await modify_email_raw.ainvoke(
                {
                    "messageId": message_id,
                    "addLabelIds": add_label_ids or [],
                    "removeLabelIds": remove_label_ids or [],
                }
            )
            return _extract_text(result)

        built.append(modify_gmail_labels)

    # --- Calendar: create ------------------------------------------------

    if create_event_raw is not None:

        @tool
        async def create_calendar_event(
            title: str,
            start: str,
            end: str,
            timezone: str,
            calendar_id: str = "primary",
            location: str = "",
            description: str = "",
            attendees: list[dict] | None = None,
            *,
            state: Annotated[_AgentState, InjectedState],
        ) -> str:
            """Create a calendar event. Requires the user's explicit
            confirmation showing the exact event details. If attendees are
            included, real invitations are sent to them — this is shown
            prominently at confirmation, same as an email recipient.

            Args:
                title: Event title.
                start: Start time, ISO 8601 (e.g. '2026-07-20T15:00:00').
                end: End time, ISO 8601.
                timezone: IANA timezone name (e.g. 'America/Los_Angeles') —
                    always required explicitly, never left implicit.
                calendar_id: Calendar to create the event on; 'primary' for
                    the main calendar.
                location: Optional location text.
                description: Optional description/notes.
                attendees: Optional list of {"email": ..., "displayName": ...}
                    dicts — each attendee receives a real invitation email.
            """
            if _count_writes_this_turn(state["messages"]) >= MAX_WRITES_PER_TURN:
                return _WRITE_CAP_MESSAGE
            payload = {
                "action": "create_calendar_event",
                "calendar_id": calendar_id,
                "title": title,
                "start": start,
                "end": end,
                "timezone": timezone,
                "location": location,
                "attendees": attendees or [],
                "description": description,
                "voice_approvable": False,
            }
            if "create_calendar_event" in (state.get("pre_approved_actions") or set()):
                approved = True
            else:
                approved = interrupt(payload)
            if not approved:
                return "Cancelled — user did not confirm."
            result = await create_event_raw.ainvoke(
                {
                    "calendarId": calendar_id,
                    "summary": title,
                    "start": start,
                    "end": end,
                    "timeZone": timezone,
                    "location": location,
                    "description": description,
                    "attendees": attendees or [],
                }
            )
            return _extract_text(result)

        built.append(create_calendar_event)

    # --- Calendar: update --------------------------------------------------

    if update_event_raw is not None and get_event_raw is not None:

        @tool
        async def update_calendar_event(
            event_id: str,
            calendar_id: str = "primary",
            title: str | None = None,
            start: str | None = None,
            end: str | None = None,
            timezone: str | None = None,
            location: str | None = None,
            description: str | None = None,
            attendees: list[dict] | None = None,
            *,
            state: Annotated[_AgentState, InjectedState],
        ) -> str:
            """Update a calendar event. Requires the user's explicit
            confirmation showing BOTH the event's real current content (read
            back first — an event ID alone isn't identifiable) and the exact
            requested changes. Only pass the fields you want to change; all
            others stay as they are.

            Args:
                event_id: ID of the event to update.
                calendar_id: Calendar the event is on; 'primary' by default.
                title: New title, if changing.
                start: New start time (ISO 8601), if changing.
                end: New end time (ISO 8601), if changing.
                timezone: New IANA timezone, if changing.
                location: New location, if changing.
                description: New description, if changing.
                attendees: New full attendee list, if changing — replaces the
                    existing list; each new attendee gets a real invitation.
            """
            if _count_writes_this_turn(state["messages"]) >= MAX_WRITES_PER_TURN:
                return _WRITE_CAP_MESSAGE
            current = await _read_back_event(get_event_raw, calendar_id, event_id)
            if current is None:
                return f"Error: could not read back event {event_id!r} to confirm — refusing to proceed blind."
            changes: dict[str, Any] = {}
            if title is not None:
                changes["title"] = title
            if start is not None:
                changes["start"] = start
            if end is not None:
                changes["end"] = end
            if timezone is not None:
                changes["timezone"] = timezone
            if location is not None:
                changes["location"] = location
            if description is not None:
                changes["description"] = description
            if attendees is not None:
                changes["attendees"] = attendees
            if not changes:
                return "Nothing to update — no fields were provided."
            payload = {
                "action": "update_calendar_event",
                "calendar_id": calendar_id,
                "event_id": event_id,
                "current": current,
                "changes": changes,
                "voice_approvable": False,
            }
            if "update_calendar_event" in (state.get("pre_approved_actions") or set()):
                approved = True
            else:
                approved = interrupt(payload)
            if not approved:
                return "Cancelled — user did not confirm."
            args: dict[str, Any] = {"calendarId": calendar_id, "eventId": event_id}
            if title is not None:
                args["summary"] = title
            if start is not None:
                args["start"] = start
            if end is not None:
                args["end"] = end
            if timezone is not None:
                args["timeZone"] = timezone
            if location is not None:
                args["location"] = location
            if description is not None:
                args["description"] = description
            if attendees is not None:
                args["attendees"] = attendees
            result = await update_event_raw.ainvoke(args)
            return _extract_text(result)

        built.append(update_calendar_event)

    # --- Calendar: delete --------------------------------------------------

    if delete_event_raw is not None and get_event_raw is not None:

        @tool
        async def delete_calendar_event(
            event_id: str,
            calendar_id: str = "primary",
            *,
            state: Annotated[_AgentState, InjectedState],
        ) -> str:
            """Delete a calendar event. Requires the user's explicit
            confirmation showing the event's real current content (read back
            first — an event ID alone isn't identifiable). This is the one
            gated action in this module that CAN be approved by voice, since
            deleting carries no free-text payload to hide an injection in.

            Args:
                event_id: ID of the event to delete.
                calendar_id: Calendar the event is on; 'primary' by default.
            """
            if _count_writes_this_turn(state["messages"]) >= MAX_WRITES_PER_TURN:
                return _WRITE_CAP_MESSAGE
            event = await _read_back_event(get_event_raw, calendar_id, event_id)
            if event is None:
                return f"Error: could not read back event {event_id!r} to confirm — refusing to proceed blind."
            payload = {
                "action": "delete_calendar_event",
                "calendar_id": calendar_id,
                "event_id": event_id,
                "event": event,
                # Deliberately True, unlike every other write action in this
                # module — see this tool's docstring and STEPS.md 63.
                "voice_approvable": True,
                "spoken_prompt": (
                    f"Delete the calendar event '{event['title']}' on {event['start']}?"
                ),
            }
            if "delete_calendar_event" in (state.get("pre_approved_actions") or set()):
                approved = True
            else:
                approved = interrupt(payload)
            if not approved:
                return "Cancelled — user did not confirm."
            result = await delete_event_raw.ainvoke({"calendarId": calendar_id, "eventId": event_id})
            return _extract_text(result)

        built.append(delete_calendar_event)

    # --- Gmail: create filter -----------------------------------------

    if create_filter_raw is not None:

        @tool
        async def create_gmail_filter(
            criteria: dict,
            add_label_ids: list[str] | None = None,
            remove_label_ids: list[str] | None = None,
            forward_to: str | None = None,
            *,
            state: Annotated[_AgentState, InjectedState],
        ) -> str:
            """Create a Gmail filter — a STANDING rule that keeps acting on
            every future matching email, not a one-time action. Requires the
            user's explicit confirmation showing the exact criteria and
            action, with any forwarding address called out prominently
            (forwarding is the one filter action that sends mail elsewhere).

            Args:
                criteria: Matching criteria — any of from/to/subject/query/
                    negatedQuery/hasAttachment/excludeChats/size/
                    sizeComparison (Gmail search-query semantics).
                add_label_ids: Label IDs to add to matching mail.
                remove_label_ids: Label IDs to remove from matching mail
                    (pass ["INBOX"] to auto-archive matches).
                forward_to: Email address to forward matching mail to, if
                    any — shown as the most prominent field at confirmation.
            """
            if _count_writes_this_turn(state["messages"]) >= MAX_WRITES_PER_TURN:
                return _WRITE_CAP_MESSAGE
            resulting_action = {
                "add_labels": add_label_ids or [],
                "remove_labels": remove_label_ids or [],
                "forward_to": forward_to,
            }
            payload = {
                "action": "create_gmail_filter",
                "criteria": criteria,
                "resulting_action": resulting_action,
                "voice_approvable": False,
            }
            if "create_gmail_filter" in (state.get("pre_approved_actions") or set()):
                approved = True
            else:
                approved = interrupt(payload)
            if not approved:
                return "Cancelled — user did not confirm."
            action: dict[str, Any] = {}
            if add_label_ids:
                action["addLabelIds"] = add_label_ids
            if remove_label_ids:
                action["removeLabelIds"] = remove_label_ids
            if forward_to:
                action["forward"] = forward_to
            result = await create_filter_raw.ainvoke({"criteria": criteria, "action": action})
            return _extract_text(result)

        built.append(create_gmail_filter)

    # --- Gmail: delete filter -----------------------------------------

    if delete_filter_raw is not None and get_filter_raw is not None:

        @tool
        async def delete_gmail_filter(
            filter_id: str,
            *,
            state: Annotated[_AgentState, InjectedState],
        ) -> str:
            """Delete a Gmail filter. Requires the user's explicit
            confirmation showing the real filter content (read back first —
            a filter ID alone isn't identifiable).

            Args:
                filter_id: ID of the filter to delete.
            """
            if _count_writes_this_turn(state["messages"]) >= MAX_WRITES_PER_TURN:
                return _WRITE_CAP_MESSAGE
            filter_text = await _read_back_filter_text(get_filter_raw, filter_id)
            if filter_text is None:
                return f"Error: could not read back filter {filter_id!r} to confirm — refusing to proceed blind."
            payload = {
                "action": "delete_gmail_filter",
                "filter_id": filter_id,
                "filter": filter_text,
                # Deliberately False, unlike calendar delete — identifying
                # which filter is being removed requires reading its
                # forward-target/criteria content aloud, reintroducing the
                # summary-vetting problem voice_approvable=True is meant to
                # avoid. See STEPS.md 64.
                "voice_approvable": False,
            }
            if "delete_gmail_filter" in (state.get("pre_approved_actions") or set()):
                approved = True
            else:
                approved = interrupt(payload)
            if not approved:
                return "Cancelled — user did not confirm."
            result = await delete_filter_raw.ainvoke({"filterId": filter_id})
            return _extract_text(result)

        built.append(delete_gmail_filter)

    missing = [
        name
        for name, raw in (
            ("send_email", send_email_raw),
            ("modify_email", modify_email_raw),
            ("create-event", create_event_raw),
            ("update-event", update_event_raw),
            ("delete-event", delete_event_raw),
            ("get-event", get_event_raw),
            ("create_filter", create_filter_raw),
            ("delete_filter", delete_filter_raw),
            ("get_filter", get_filter_raw),
        )
        if raw is None
    ]
    if missing:
        logger.warning(
            "write_tools: raw MCP tool(s) not found, related gated tool(s) unavailable: %s",
            missing,
        )

    return built
