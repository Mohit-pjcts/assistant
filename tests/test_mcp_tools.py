"""Tests for assistant.mcp_tools — the download-path confinement interceptor.

Runnable directly (no test framework required yet). Tests the interceptor in
isolation (no live MCP server/network call) — it's a pure function of
(request, handler), so a fake handler that just echoes back the args it
received is enough to verify what would actually be sent to the server.
"""

import asyncio
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import assistant.tools as tools
from assistant.mcp_tools import (
    _CALENDAR_BLOCKED_TOOLS,
    _MAX_RESULTS_CEILING,
    _block_calendar_writes,
    _cap_result_size,
    _confine_downloads_to_workspace,
)
from langchain_mcp_adapters.interceptors import MCPToolCallRequest


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
    print("\n10 tests passed")
