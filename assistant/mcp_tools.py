"""MCP-loaded tools: async loading, merged into TOOLS by the caller.

Kept separate from tools.py — tools.py is Phase 1's hand-secured tool set
(sync, evaluated individually against the prompt-injection threat model);
this module is Phase 2+'s MCP integration (async-only, servers evaluated
against the same threat model before being added here). Callers merge the
two lists themselves (e.g. `TOOLS + await load_mcp_tools()`); neither module
knows about the other.
"""

from __future__ import annotations

import os
import shutil
from collections.abc import Awaitable, Callable
from pathlib import Path

from dotenv import load_dotenv
from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.interceptors import MCPToolCallRequest, MCPToolCallResult
from mcp.types import CallToolResult, TextContent

from assistant.tools import ensure_workspace_dir

load_dotenv()

# Gmail tools that write files to disk from inside the (separately-running,
# Node) MCP server process — entirely outside tools.py's own workspace
# confinement, since that only guards our own read_file/write_file/
# execute_shell_command tools. The server accepts a free-form `savePath` and
# (for attachments) `filename` with no confinement of its own — if the model
# is ever steered by adversarial email content (the exact prompt-injection
# threat model this project defends against) into requesting a savePath like
# an SSH key directory, the server would write there with the OS user's own
# permissions. The interceptor below forces both args into the same
# workspace/ directory tools.py already uses, unconditionally, regardless of
# what the model requests — no path is trusted from model input, matching
# tools.py's execution-side (not content-filtering) mitigation strategy.
_WORKSPACE_CONFINED_SAVE_PATH_TOOLS = {"download_attachment", "download_email"}


async def _confine_downloads_to_workspace(
    request: MCPToolCallRequest,
    handler: Callable[[MCPToolCallRequest], Awaitable[MCPToolCallResult]],
) -> MCPToolCallResult:
    """Force download tools' savePath/filename into workspace/, ignoring model input."""
    if request.name in _WORKSPACE_CONFINED_SAVE_PATH_TOOLS:
        args = dict(request.args)
        args["savePath"] = str(ensure_workspace_dir())
        if "filename" in args and args["filename"]:
            # basename only — neutralizes any '../' or absolute path smuggled
            # in via filename, which savePath alone wouldn't catch since the
            # server joins the two itself.
            args["filename"] = Path(args["filename"]).name
        request = request.override(args=args)
    return await handler(request)


# get_inbox_with_threads defaults to maxResults=50, expandThreads=True
# server-side if the model omits them — up to 50 *full* email threads dumped
# into context on a single call, unbounded unless we cap it ourselves.
# Cost impact per CLAUDE.md: this is exactly the "verbose tool outputs fed
# back into context" case it calls out to flag. Capped at the interceptor
# level (execution side) rather than relying on the system prompt asking the
# model nicely to pass a small maxResults.
_MAX_RESULTS_CEILING = 10
_RESULT_CAPPED_TOOLS = {"search_emails", "list_inbox_threads", "get_inbox_with_threads"}


async def _cap_result_size(
    request: MCPToolCallRequest,
    handler: Callable[[MCPToolCallRequest], Awaitable[MCPToolCallResult]],
) -> MCPToolCallResult:
    """Clamp maxResults on list/search tools so a single call can't pull in
    an unbounded number of (potentially full-content) threads/messages."""
    if request.name in _RESULT_CAPPED_TOOLS:
        args = dict(request.args)
        requested = args.get("maxResults")
        if requested is None or requested > _MAX_RESULTS_CEILING:
            args["maxResults"] = _MAX_RESULTS_CEILING
        request = request.override(args=args)
    return await handler(request)


# The Calendar server (nspady/google-calendar-mcp) has no equivalent to
# Gmail's --scopes=gmail.readonly — it hardcodes requesting the full
# read/write `.../auth/calendar` OAuth scope regardless of configuration
# (verified by reading src/auth/server.ts directly; see STEPS.md 17). Its
# ENABLED_TOOLS startup flag is a hard allowlist — tools not listed are never
# registered with the MCP protocol, so the model can't see or call them —
# but that's a server-config guarantee, not an OAuth-grant one.
#
# Phase 12 (STEPS.md 63): create-event/update-event/delete-event are now
# ENABLED — but only assistant.write_tools' gated wrappers ever get a chance
# to call them, since _select_life_admin_tools (sub_agents.py) never exposes
# these raw names to the model directly. This interceptor is the
# defense-in-depth layer underneath THAT guarantee: even if the sub-agent's
# tool selection were ever misconfigured and these raw names leaked into the
# model's tool list, write-capable tool names are refused here unconditionally
# for anything not yet designed a gate for (bulk create, invite responses,
# account management) — and even for the three that DO have a gate, this
# interceptor cannot distinguish "the model called this directly" from "the
# approved wrapper called this after interrupt() returned true", since both
# paths go through the same MultiServerMCPClient. The real enforcement point
# for those three is the model's tool list, not this interceptor — see
# write_tools.py's module docstring.
_CALENDAR_ENABLED_TOOLS = (
    "list-calendars,list-events,search-events,get-event,"
    "list-colors,get-freebusy,get-current-time,"
    "create-event,update-event,delete-event"
)
_CALENDAR_BLOCKED_TOOLS = {
    "create-events",
    "respond-to-event",
    "manage-accounts",
}


async def _block_calendar_writes(
    request: MCPToolCallRequest,
    handler: Callable[[MCPToolCallRequest], Awaitable[MCPToolCallResult]],
) -> MCPToolCallResult:
    """Refuse calendar tool calls not yet designed a confirmation gate for —
    belt-and-suspenders under the ENABLED_TOOLS allowlist. create-event/
    update-event/delete-event are NOT in this set: those are gated by
    write_tools.py instead, at the model-tool-list level (see comment above
    _CALENDAR_ENABLED_TOOLS)."""
    if request.name in _CALENDAR_BLOCKED_TOOLS:
        return CallToolResult(
            content=[
                TextContent(
                    type="text",
                    text=(
                        f"'{request.name}' is disabled — not yet supported by "
                        "this assistant."
                    ),
                )
            ],
            isError=True,
        )
    return await handler(request)


def _gmail_server_path() -> str:
    path = os.environ.get("GMAIL_MCP_SERVER_PATH")
    if not path:
        raise RuntimeError(
            "GMAIL_MCP_SERVER_PATH is not set — point it at the built "
            "Gmail-MCP-Server's dist/index.js (see .env.example)"
        )
    return path


def _calendar_server_path() -> str:
    path = os.environ.get("GOOGLE_CALENDAR_MCP_SERVER_PATH")
    if not path:
        raise RuntimeError(
            "GOOGLE_CALENDAR_MCP_SERVER_PATH is not set — point it at the "
            "built google-calendar-mcp's build/index.js (see .env.example)"
        )
    return path


def _calendar_credentials_path() -> str:
    path = os.environ.get("GOOGLE_CALENDAR_MCP_CREDENTIALS")
    if not path:
        raise RuntimeError(
            "GOOGLE_CALENDAR_MCP_CREDENTIALS is not set — point it at "
            "gcp-oauth.keys.json (see .env.example)"
        )
    return path


# Phase 14 packaging follow-up: a GUI-launched process (Tauri's app bundle,
# or its spawned backend/voice-daemon children — STEPS.md 71/72) does NOT
# inherit the user's interactive shell PATH (~/.zprofile etc.), only a
# minimal default one — bare "node" resolves fine when this code runs from
# a Terminal-launched process (main.py, or `uvicorn` started by hand) but
# fails with FileNotFoundError once launched via the packaged app. Found
# live: Gmail/Calendar tools silently unavailable, logged as a warning
# rather than crashing (STEPS.md's "tool errors are data, not exceptions"
# posture holds even for this setup-time failure). Resolved once via
# `shutil.which` first (correct in every context where PATH IS right,
# so this doesn't regress the normal Terminal-launched case) with a
# Homebrew/system fallback list for the case where it isn't.
_NODE_FALLBACK_PATHS = ("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node")


def _node_path() -> str:
    found = shutil.which("node")
    if found:
        return found
    for candidate in _NODE_FALLBACK_PATHS:
        if os.path.exists(candidate):
            return candidate
    raise RuntimeError(
        "Could not find a 'node' executable (checked PATH and "
        f"{_NODE_FALLBACK_PATHS}) — Gmail/Calendar MCP servers need it."
    )


async def load_mcp_tools() -> list[BaseTool]:
    """Load all tools from configured MCP servers.

    A new MCP session is created per tool call (langchain-mcp-adapters'
    documented behavior) — the client itself doesn't need to stay open past
    this call; the returned tools carry their own connection config.

    Returns:
        Tools from every configured MCP server, ready to merge into TOOLS.
    """
    node = _node_path()
    client = MultiServerMCPClient(
        {
            "gmail": {
                "transport": "stdio",
                "command": node,
                "args": [_gmail_server_path()],
            },
            "calendar": {
                "transport": "stdio",
                "command": node,
                "args": [_calendar_server_path()],
                "env": {
                    "GOOGLE_OAUTH_CREDENTIALS": _calendar_credentials_path(),
                    "ENABLED_TOOLS": _CALENDAR_ENABLED_TOOLS,
                },
            },
        },
        tool_interceptors=[
            _confine_downloads_to_workspace,
            _cap_result_size,
            _block_calendar_writes,
        ],
    )
    return await client.get_tools()
