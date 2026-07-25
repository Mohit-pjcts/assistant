"""phone_agent's own tools (PLAN.md Phase 21).

**Governing platform constraint (see PLAN.md's Phase 21 entry — applies to
this whole module):** Apple does not let a remote server trigger a
Shortcut, open an app, or open a URL on the iPhone unprompted — only a
LOCAL trigger (the Action Button, a Share Sheet, an automation) can invoke
one. The backend can therefore never command the phone out of the blue,
in either direction: `open_app_on_phone`/`open_url_on_phone` below cannot
themselves open anything, and `get_latest_health_snapshot` cannot ask the
phone for fresh data on demand.

**How `open_app_on_phone`/`open_url_on_phone` "work" anyway:** each
returns a `Command` stashing a structured action on its own ToolMessage's
`additional_kwargs[PHONE_ACTION_KEY]` — the exact same side-channel
mechanism `a2ui.py`'s `render_ui` already uses for its own persistence
marker (never sent back to the model, only readable by code).
`supervisor.py`'s `_invoke_agent_graph`/`call_specialist` forward it
across the nested specialist boundary the same way they already forward
`A2UI_SURFACE_KEY` (Phase 18's proven mechanism). `server.py`'s
`_run_turn` (the `/phone/turn`/`/phone/resume` endpoints) then reads it
off the newly-added messages for THIS turn specifically (not the whole
persisted thread — see `_run_turn`'s own docstring) and includes it in
its JSON response as `phone_actions`; the calling Shortcut checks for that
field and, if present, executes it locally (`Open App`/`Open URLs`)
AFTER speaking the reply. Nothing in this module can make that actually
happen — it only ever describes an action for an external, human-operated
Shortcut to carry out. Ungated (PLAN.md Phase 21's grilling checkpoint,
matching `mac_tools.py`'s `open_app`/`open_url_in_brave` precedent):
open-only, no automation, reversible, immediately visible to the user the
moment it happens.

**`get_latest_health_snapshot`:** reads whatever the user last pushed via
their own sync Shortcut (`phone_store.py`, `POST /phone/health-sync` in
server.py) — never live, always says how stale the data is.

**`run_shortcut_on_phone` (added after `open_app_on_phone`/
`open_url_on_phone` were already live-verified):** same
stash-a-phone_action mechanism as those two. **Originally built GATED**
(mirroring `mac_tools.py`'s own `run_shortcut` — a named Shortcut's
actual behavior is opaque to this codebase, so every name would be
gated regardless of what it sounds like) — **then explicitly UNGATED at
the user's direct request the same session**, a deliberate choice, not
an oversight, same category as `mac_tools.py`'s own `open_url_in_brave`
decision (Phase 13): the user was told plainly this diverges from the
Mac precedent and chose ungated anyway. Treated the identical way
`open_app_on_phone`/`open_url_on_phone` are — open-only in the sense
that nothing here executes anything itself, only describes an action
for the calling Shortcut to carry out.
"""

from __future__ import annotations

from typing import Annotated

from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool, InjectedToolCallId, tool
from langgraph.types import Command

from assistant import phone_store

# additional_kwargs marker key, mirroring a2ui.py's A2UI_SURFACE_KEY —
# always a LIST (of one, typically) for the same reason: a uniform shape
# whether this ToolMessage is read directly or forwarded from a delegated
# specialist's own isolated run.
PHONE_ACTION_KEY = "phone_action"


@tool
def open_app_on_phone(
    name: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> Command:
    """Open an app on the iPhone that made this request, by name (e.g.
    "Maps", "Spotify"). Only has any effect when this conversation was
    reached via the Action Button / Share Sheet phone channel — from the
    Mac dashboard, CLI, or voice there is no phone to open anything on.
    The app opens AFTER you finish replying, not immediately.

    Args:
        name: The app's name as it appears on the iPhone.
    """
    return Command(
        update={
            "messages": [
                ToolMessage(
                    content=f"Will open the '{name}' app on your phone.",
                    tool_call_id=tool_call_id,
                    additional_kwargs={PHONE_ACTION_KEY: [{"type": "open_app", "name": name}]},
                )
            ]
        }
    )


@tool
def open_url_on_phone(
    url: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> Command:
    """Open a URL on the iPhone that made this request, in whatever
    browser the user has set as their iOS default — open/navigate only,
    never clicking/typing/filling forms/scraping. Only has any effect via
    the Action Button / Share Sheet phone channel.

    Also how a WhatsApp compose draft opens (PLAN.md Phase 22): pass a
    `whatsapp://send?phone=<number>&text=<message>` URL the same way as
    any other URL — the user still has to tap Send themselves inside
    WhatsApp; nothing here can complete that send.

    Args:
        url: The URL to open.
    """
    return Command(
        update={
            "messages": [
                ToolMessage(
                    content=f"Will open {url} on your phone.",
                    tool_call_id=tool_call_id,
                    additional_kwargs={PHONE_ACTION_KEY: [{"type": "open_url", "url": url}]},
                )
            ]
        }
    )


@tool
async def get_latest_health_snapshot() -> str:
    """The most recent health-data snapshot pushed from the iPhone via its
    own sync Shortcut — NOT live. Only as fresh as the last time the user
    ran that Shortcut; there is no way to query current health data on
    demand. Always say plainly how old the returned data is (using its
    timestamp) rather than implying it's current.
    """
    snapshot = await phone_store.get_snapshot("health")
    if snapshot is None:
        return "No health data has ever been synced from the phone."
    return f"Health snapshot from {snapshot.synced_at}:\n{snapshot.content}"


@tool
def run_shortcut_on_phone(
    name: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> Command:
    """Run a named Shortcut on the iPhone that made this request. Only
    has any effect via the Action Button / Share Sheet phone channel;
    has no effect from the Mac dashboard, CLI, or voice. The Shortcut
    runs AFTER you finish replying, not immediately.

    Deliberately UNGATED (the user's own explicit choice — see this
    module's docstring) even though a Shortcut's actual behavior is
    opaque to this codebase; `mac_tools.py`'s own `run_shortcut` stays
    gated, this one does not.

    Args:
        name: The exact name of the Shortcut to run, as it appears in
            the Shortcuts app on the phone.
    """
    return Command(
        update={
            "messages": [
                ToolMessage(
                    content=f"Will run the '{name}' shortcut on your phone.",
                    tool_call_id=tool_call_id,
                    additional_kwargs={PHONE_ACTION_KEY: [{"type": "run_shortcut", "name": name}]},
                )
            ]
        }
    )


def build_phone_action_tools() -> list[BaseTool]:
    return [open_app_on_phone, open_url_on_phone, get_latest_health_snapshot, run_shortcut_on_phone]
