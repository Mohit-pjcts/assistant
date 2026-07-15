"""Tests for assistant.mcp_tools — the download-path confinement interceptor.

Runnable directly (no test framework required yet). Tests the interceptor in
isolation (no live MCP server/network call) — it's a pure function of
(request, handler), so a fake handler that just echoes back the args it
received is enough to verify what would actually be sent to the server.
"""

import asyncio
import os
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from langchain_mcp_adapters.interceptors import MCPToolCallRequest

import assistant.tools as tools
from assistant.mcp_tools import (
    _CALENDAR_BLOCKED_TOOLS,
    _MAX_RESULTS_CEILING,
    _NODE_FALLBACK_PATHS,
    _block_calendar_writes,
    _cap_result_size,
    _confine_downloads_to_workspace,
    _node_path,
)


@contextmanager
def _stripped_path_env() -> Iterator[None]:
    """Simulate a GUI-launched process's minimal PATH (no /opt/homebrew/bin,
    no ~/.zprofile additions) — the exact condition that broke Gmail/
    Calendar tool loading once the app was packaged (STEPS.md 71/72
    follow-up: FileNotFoundError: 'node', found live via the voice
    daemon's own log after launching through the Tauri-built app)."""
    original = os.environ.get("PATH")
    os.environ["PATH"] = "/usr/bin:/bin"
    try:
        yield
    finally:
        if original is not None:
            os.environ["PATH"] = original


@contextmanager
def _temp_workspace() -> Iterator[Path]:
    """Swap tools.WORKSPACE_DIR to a fresh temp dir for the duration of a test."""
    original = tools.WORKSPACE_DIR
    with tempfile.TemporaryDirectory() as tmp:
        tools.WORKSPACE_DIR = Path(tmp) / "workspace"
        try:
            yield tools.WORKSPACE_DIR
        finally:
            tools.WORKSPACE_DIR = original


async def _echo_handler(request: MCPToolCallRequest) -> dict:
    """Fake handler standing in for the real MCP call — returns what it received."""
    return request.args


def test_download_attachment_savepath_forced_into_workspace() -> None:
    with _temp_workspace() as workspace:
        request = MCPToolCallRequest(
            name="download_attachment",
            args={
                "messageId": "m1",
                "attachmentId": "a1",
                "savePath": "/tmp/evil-exfil-dir",
            },
            server_name="gmail",
        )
        result = asyncio.run(_confine_downloads_to_workspace(request, _echo_handler))
        assert Path(result["savePath"]) == workspace.resolve()


def test_download_email_savepath_forced_into_workspace() -> None:
    with _temp_workspace() as workspace:
        request = MCPToolCallRequest(
            name="download_email",
            args={"messageId": "m1", "savePath": "/etc", "format": "txt"},
            server_name="gmail",
        )
        result = asyncio.run(_confine_downloads_to_workspace(request, _echo_handler))
        assert Path(result["savePath"]) == workspace.resolve()


def test_download_attachment_filename_traversal_stripped_to_basename() -> None:
    with _temp_workspace():
        request = MCPToolCallRequest(
            name="download_attachment",
            args={
                "messageId": "m1",
                "attachmentId": "a1",
                "filename": "../../../../etc/evil.txt",
                "savePath": "/tmp/whatever",
            },
            server_name="gmail",
        )
        result = asyncio.run(_confine_downloads_to_workspace(request, _echo_handler))
        assert result["filename"] == "evil.txt"
        assert "/" not in result["filename"]


def test_non_download_tool_call_passes_through_unmodified() -> None:
    with _temp_workspace():
        request = MCPToolCallRequest(
            name="search_emails",
            args={"query": "in:inbox", "maxResults": 5},
            server_name="gmail",
        )
        result = asyncio.run(_confine_downloads_to_workspace(request, _echo_handler))
        assert result == {"query": "in:inbox", "maxResults": 5}


def test_cap_result_size_clamps_missing_max_results() -> None:
    request = MCPToolCallRequest(
        name="get_inbox_with_threads",
        args={"query": "in:inbox", "expandThreads": True},
        server_name="gmail",
    )
    result = asyncio.run(_cap_result_size(request, _echo_handler))
    assert result["maxResults"] == _MAX_RESULTS_CEILING


def test_cap_result_size_clamps_oversized_request() -> None:
    request = MCPToolCallRequest(
        name="list_inbox_threads",
        args={"query": "in:inbox", "maxResults": 500},
        server_name="gmail",
    )
    result = asyncio.run(_cap_result_size(request, _echo_handler))
    assert result["maxResults"] == _MAX_RESULTS_CEILING


def test_cap_result_size_leaves_small_requests_alone() -> None:
    request = MCPToolCallRequest(
        name="search_emails",
        args={"query": "in:inbox", "maxResults": 3},
        server_name="gmail",
    )
    result = asyncio.run(_cap_result_size(request, _echo_handler))
    assert result["maxResults"] == 3


def test_cap_result_size_ignores_uncapped_tools() -> None:
    request = MCPToolCallRequest(
        name="read_email", args={"messageId": "m1"}, server_name="gmail"
    )
    result = asyncio.run(_cap_result_size(request, _echo_handler))
    assert "maxResults" not in result


async def _never_call_handler(request: MCPToolCallRequest):
    raise AssertionError(
        f"handler must not be invoked for blocked tool {request.name!r}"
    )


def test_calendar_write_tools_blocked_without_reaching_handler() -> None:
    for name in _CALENDAR_BLOCKED_TOOLS:
        request = MCPToolCallRequest(name=name, args={}, server_name="calendar")
        result = asyncio.run(_block_calendar_writes(request, _never_call_handler))
        assert result.isError is True
        assert name in result.content[0].text


def test_calendar_read_tools_pass_through() -> None:
    request = MCPToolCallRequest(
        name="list-events", args={"calendarId": "primary"}, server_name="calendar"
    )
    result = asyncio.run(_block_calendar_writes(request, _echo_handler))
    assert result == {"calendarId": "primary"}


def test_calendar_gated_write_tools_pass_through_this_interceptor() -> None:
    """create-event/update-event/delete-event are gated by write_tools.py at
    the model-tool-list level (Phase 12, STEPS.md 63) — this interceptor no
    longer blocks them; it isn't the enforcement point for these three."""
    for name in ("create-event", "update-event", "delete-event"):
        request = MCPToolCallRequest(name=name, args={"foo": "bar"}, server_name="calendar")
        result = asyncio.run(_block_calendar_writes(request, _echo_handler))
        assert result == {"foo": "bar"}


def test_node_path_falls_back_to_known_locations_when_path_is_stripped() -> None:
    """Reproduces the exact failure mode found live (STEPS.md 71/72
    follow-up): a GUI-launched process's PATH doesn't include
    /opt/homebrew/bin, so a bare 'node' command lookup fails even though
    node is genuinely installed. _node_path() must still find it via the
    fallback list."""
    with _stripped_path_env():
        # shutil.which("node") must genuinely fail under this PATH for the
        # test to mean anything — otherwise it isn't exercising the
        # fallback branch at all.
        import shutil

        assert shutil.which("node") is None, "test setup invalid: node still on PATH"
        found = _node_path()
        assert found in _NODE_FALLBACK_PATHS
        assert os.path.exists(found)


def test_node_path_prefers_which_when_path_is_correct() -> None:
    """The normal (Terminal-launched) case must keep working exactly as
    before — no regression from adding the fallback."""
    found = _node_path()
    assert os.path.exists(found)


if __name__ == "__main__":
    test_download_attachment_savepath_forced_into_workspace()
    print("OK: test_download_attachment_savepath_forced_into_workspace")
    test_download_email_savepath_forced_into_workspace()
    print("OK: test_download_email_savepath_forced_into_workspace")
    test_download_attachment_filename_traversal_stripped_to_basename()
    print("OK: test_download_attachment_filename_traversal_stripped_to_basename")
    test_non_download_tool_call_passes_through_unmodified()
    print("OK: test_non_download_tool_call_passes_through_unmodified")
    test_cap_result_size_clamps_missing_max_results()
    print("OK: test_cap_result_size_clamps_missing_max_results")
    test_cap_result_size_clamps_oversized_request()
    print("OK: test_cap_result_size_clamps_oversized_request")
    test_cap_result_size_leaves_small_requests_alone()
    print("OK: test_cap_result_size_leaves_small_requests_alone")
    test_cap_result_size_ignores_uncapped_tools()
    print("OK: test_cap_result_size_ignores_uncapped_tools")
    test_calendar_write_tools_blocked_without_reaching_handler()
    print("OK: test_calendar_write_tools_blocked_without_reaching_handler")
    test_calendar_read_tools_pass_through()
    print("OK: test_calendar_read_tools_pass_through")
    test_calendar_gated_write_tools_pass_through_this_interceptor()
    print("OK: test_calendar_gated_write_tools_pass_through_this_interceptor")
    test_node_path_falls_back_to_known_locations_when_path_is_stripped()
    print("OK: test_node_path_falls_back_to_known_locations_when_path_is_stripped")
    test_node_path_prefers_which_when_path_is_correct()
    print("OK: test_node_path_prefers_which_when_path_is_correct")
    print("\n13 tests passed")
