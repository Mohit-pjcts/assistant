"""Tests for assistant.disk_tools — PLAN.md Phase 23's full-disk file
search/read/write/delete tools, the largest security-model change in this
project's history.

Real file operations against tempfile-created paths (never the real Mac
filesystem broadly) — no mocking of pathlib itself, same "real calls, no
mocking" convention as the rest of this project, scoped safely via
tempfile. `search_disk`'s `subprocess.run` (mdfind) IS mocked, same
established convention as test_mac_tools.py, since running a real
whole-disk Spotlight search in a test would be slow and
environment-dependent — real search results also cross the mdfind
subprocess boundary just like `mac_tools.py`'s osascript calls do.
"""

import asyncio
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

import assistant.disk_tools as disk_tools
from assistant.memory import get_checkpointer


class State(TypedDict):
    result: str | None


@contextmanager
def _capture_subprocess_calls():
    calls = []
    original = disk_tools.subprocess.run

    def fake_run(argv, **kwargs):
        calls.append(argv)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    disk_tools.subprocess.run = fake_run
    try:
        yield calls
    finally:
        disk_tools.subprocess.run = original


def _build_tool_graph(checkpointer, tool_name: str, tool_args: dict):
    def node(state: State) -> dict:
        target = getattr(disk_tools, tool_name)
        return {"result": target.invoke({**tool_args, "state": {"messages": []}})}

    builder = StateGraph(State)
    builder.add_node("act", node)
    builder.add_edge(START, "act")
    builder.add_edge("act", END)
    return builder.compile(checkpointer=checkpointer)


async def _run_gated_tool(tool_name: str, tool_args: dict, resume: bool):
    with tempfile.TemporaryDirectory() as tmp:
        async with get_checkpointer(Path(tmp) / "scratch.sqlite") as checkpointer:
            graph = _build_tool_graph(checkpointer, tool_name, tool_args)
            config = {"configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}}
            first = await graph.ainvoke({"result": None}, config=config)
            assert "__interrupt__" in first, f"expected interrupt, got {first}"
            interrupt_payload = first["__interrupt__"][0].value
            resumed = await graph.ainvoke(Command(resume=resume), config=config)
            return interrupt_payload, resumed


# --- _is_credential_path: the actual security boundary ----------------------


def test_is_credential_path_blocks_ssh_keys() -> None:
    assert disk_tools._is_credential_path(Path.home() / ".ssh" / "id_rsa")
    assert disk_tools._is_credential_path(Path.home() / ".ssh" / "config")


def test_is_credential_path_blocks_aws_and_docker_and_gnupg() -> None:
    assert disk_tools._is_credential_path(Path.home() / ".aws" / "credentials")
    assert disk_tools._is_credential_path(Path.home() / ".docker" / "config.json")
    assert disk_tools._is_credential_path(Path.home() / ".gnupg" / "secring.gpg")


def test_is_credential_path_blocks_keychains_and_browser_stores() -> None:
    assert disk_tools._is_credential_path(Path.home() / "Library" / "Keychains" / "login.keychain")
    assert disk_tools._is_credential_path(
        Path.home() / "Library" / "Application Support" / "Google" / "Chrome" / "Default" / "Login Data"
    )
    assert disk_tools._is_credential_path(Path.home() / "Library" / "Cookies" / "Cookies.binarycookies")


def test_is_credential_path_blocks_env_files_anywhere() -> None:
    """.env-shaped files are blocked by NAME, not a fixed path — a stray
    .env can live in any project folder, not just under a known prefix."""
    assert disk_tools._is_credential_path(Path("/Users/someone/random-project/.env"))
    assert disk_tools._is_credential_path(Path("/tmp/whatever/.env.production"))
    assert disk_tools._is_credential_path(Path("/tmp/x/id_rsa"))
    assert disk_tools._is_credential_path(Path("/tmp/x/.netrc"))


def test_is_credential_path_allows_ordinary_user_files() -> None:
    """The whole point of this phase — Desktop/Documents/Downloads must
    stay reachable, unlike tools.py's much broader shell-tool denylist
    (this module's own docstring explains why the two lists differ)."""
    assert not disk_tools._is_credential_path(Path.home() / "Desktop" / "notes.txt")
    assert not disk_tools._is_credential_path(Path.home() / "Documents" / "report.pdf")
    assert not disk_tools._is_credential_path(Path.home() / "Downloads" / "invoice.csv")


def test_is_credential_path_blocks_mixed_case_paths() -> None:
    """APFS (macOS's default filesystem) is case-insensitive-but-preserving
    — a differently-cased path resolves to the same real file and must be
    blocked the same as its canonical-case form."""
    assert disk_tools._is_credential_path(Path.home() / ".SSH" / "ID_RSA")
    assert disk_tools._is_credential_path(Path("/tmp/x/.ENV.production"))


# --- search_disk (mocked subprocess) -----------------------------------------


def test_search_disk_passes_query_and_scope_as_argv() -> None:
    with _capture_subprocess_calls() as calls:
        disk_tools.search_disk.invoke({"query": "invoice", "directory": "~/Desktop"})

    assert len(calls) == 1
    argv = calls[0]
    assert argv[0] == "mdfind"
    assert "-onlyin" in argv
    assert argv[-1] == "invoice"


def test_search_disk_hides_credential_paths_from_results() -> None:
    calls_seen = []
    original = disk_tools.subprocess.run

    def fake_run(argv, **kwargs):
        calls_seen.append(argv)
        stdout = "\n".join(
            [
                str(Path.home() / "Desktop" / "invoice.pdf"),
                str(Path.home() / ".ssh" / "id_rsa"),
                str(Path.home() / "Documents" / "invoice2.pdf"),
            ]
        )
        return SimpleNamespace(returncode=0, stdout=stdout, stderr="")

    disk_tools.subprocess.run = fake_run
    try:
        result = disk_tools.search_disk.invoke({"query": "invoice"})
    finally:
        disk_tools.subprocess.run = original

    assert "invoice.pdf" in result
    assert "invoice2.pdf" in result
    assert "id_rsa" not in result
    assert "hidden" in result.lower()


def test_search_disk_hides_symlinks_resolving_into_credential_paths() -> None:
    """A symlink whose own name looks innocuous but resolves into a
    denylisted directory must still be hidden — mirrors read/write/delete's
    resolve-before-check behavior, which search_disk didn't previously
    share (it checked the raw mdfind path string)."""
    with tempfile.TemporaryDirectory() as tmp:
        real_secret_dir = Path(tmp) / "real_ssh"
        real_secret_dir.mkdir()
        (real_secret_dir / "id_rsa").write_text("PRIVATE KEY")
        innocuous_link = Path(tmp) / "totally_normal_file"
        innocuous_link.symlink_to(real_secret_dir / "id_rsa")

        original = disk_tools.subprocess.run

        def fake_run(argv, **kwargs):
            return SimpleNamespace(returncode=0, stdout=str(innocuous_link), stderr="")

        disk_tools.subprocess.run = fake_run
        try:
            result = disk_tools.search_disk.invoke({"query": "id_rsa"})
        finally:
            disk_tools.subprocess.run = original

    assert "totally_normal_file" not in result
    assert "hidden" in result.lower()


# --- read_disk_file -----------------------------------------------------


def test_read_disk_file_reads_a_real_ordinary_file() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "notes.txt"
        p.write_text("hello from outside the workspace")
        result = disk_tools.read_disk_file.invoke({"path": str(p)})
    assert result == "hello from outside the workspace"


def test_read_disk_file_refuses_credential_shaped_filename() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / ".env"
        p.write_text("SECRET_KEY=abc123")
        result = disk_tools.read_disk_file.invoke({"path": str(p)})
    assert "credential" in result.lower()
    assert "abc123" not in result


def test_read_disk_file_missing_file_reports_error_not_exception() -> None:
    result = disk_tools.read_disk_file.invoke({"path": "/tmp/definitely-does-not-exist-xyz.txt"})
    assert result.startswith("Error:")


# --- write_disk_file: gated ---------------------------------------------


def test_write_disk_file_declined_never_writes() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        target = str(Path(tmp) / "new_file.txt")
        _payload, resumed = asyncio.run(
            _run_gated_tool(
                "write_disk_file",
                {"path": target, "content": "should not be written"},
                resume=False,
            )
        )
        assert not Path(target).exists()
        assert resumed["result"] == "Cancelled — user did not confirm."


def test_write_disk_file_approved_writes_real_content_and_payload_is_verbatim() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        target = str(Path(tmp) / "new_file.txt")
        payload, resumed = asyncio.run(
            _run_gated_tool(
                "write_disk_file",
                {"path": target, "content": "the real new content"},
                resume=True,
            )
        )
        assert payload["action"] == "write_disk_file"
        assert payload["new_content"] == "the real new content"
        assert payload["existed"] is False
        assert payload["voice_approvable"] is False
        assert Path(target).read_text() == "the real new content"
        assert "Wrote" in resumed["result"]


def test_write_disk_file_overwrite_shows_previous_content_in_payload() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "existing.txt"
        target.write_text("old content here")
        payload, _resumed = asyncio.run(
            _run_gated_tool(
                "write_disk_file",
                {"path": str(target), "content": "new content here"},
                resume=True,
            )
        )
        assert payload["existed"] is True
        assert payload["previous_content"] == "old content here"
        assert payload["new_content"] == "new content here"
        assert target.read_text() == "new content here"


def test_write_disk_file_refuses_credential_path_even_when_approved() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        target = str(Path(tmp) / ".env")
        # No interrupt at all expected here — the credential check happens
        # BEFORE interrupt() is ever called, same as read_disk_file.
        result = disk_tools.write_disk_file.invoke(
            {"path": target, "content": "SECRET=1", "state": {"messages": []}}
        )
        assert "credential" in result.lower()
        assert not Path(target).exists()


# --- delete_disk_file: gated ---------------------------------------------


def test_delete_disk_file_declined_never_deletes() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "keep_me.txt"
        target.write_text("do not delete")
        _payload, resumed = asyncio.run(
            _run_gated_tool("delete_disk_file", {"path": str(target)}, resume=False)
        )
        assert target.exists()
        assert resumed["result"] == "Cancelled — user did not confirm."


def test_delete_disk_file_approved_deletes_and_payload_shows_real_content() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "delete_me.txt"
        target.write_text("real content that will be shown before deletion")
        payload, resumed = asyncio.run(
            _run_gated_tool("delete_disk_file", {"path": str(target)}, resume=True)
        )
        assert payload["action"] == "delete_disk_file"
        assert payload["content"] == "real content that will be shown before deletion"
        assert payload["voice_approvable"] is False
        assert not target.exists()
        assert "Deleted" in resumed["result"]


def test_delete_disk_file_refuses_credential_path() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "id_rsa"
        target.write_text("fake key material")
        result = disk_tools.delete_disk_file.invoke({"path": str(target), "state": {"messages": []}})
        assert "credential" in result.lower()
        assert target.exists()


if __name__ == "__main__":
    test_is_credential_path_blocks_ssh_keys()
    print("OK: test_is_credential_path_blocks_ssh_keys")
    test_is_credential_path_blocks_aws_and_docker_and_gnupg()
    print("OK: test_is_credential_path_blocks_aws_and_docker_and_gnupg")
    test_is_credential_path_blocks_keychains_and_browser_stores()
    print("OK: test_is_credential_path_blocks_keychains_and_browser_stores")
    test_is_credential_path_blocks_env_files_anywhere()
    print("OK: test_is_credential_path_blocks_env_files_anywhere")
    test_is_credential_path_allows_ordinary_user_files()
    print("OK: test_is_credential_path_allows_ordinary_user_files")
    test_is_credential_path_blocks_mixed_case_paths()
    print("OK: test_is_credential_path_blocks_mixed_case_paths")
    test_search_disk_passes_query_and_scope_as_argv()
    print("OK: test_search_disk_passes_query_and_scope_as_argv")
    test_search_disk_hides_credential_paths_from_results()
    print("OK: test_search_disk_hides_credential_paths_from_results")
    test_search_disk_hides_symlinks_resolving_into_credential_paths()
    print("OK: test_search_disk_hides_symlinks_resolving_into_credential_paths")
    test_read_disk_file_reads_a_real_ordinary_file()
    print("OK: test_read_disk_file_reads_a_real_ordinary_file")
    test_read_disk_file_refuses_credential_shaped_filename()
    print("OK: test_read_disk_file_refuses_credential_shaped_filename")
    test_read_disk_file_missing_file_reports_error_not_exception()
    print("OK: test_read_disk_file_missing_file_reports_error_not_exception")
    test_write_disk_file_declined_never_writes()
    print("OK: test_write_disk_file_declined_never_writes")
    test_write_disk_file_approved_writes_real_content_and_payload_is_verbatim()
    print("OK: test_write_disk_file_approved_writes_real_content_and_payload_is_verbatim")
    test_write_disk_file_overwrite_shows_previous_content_in_payload()
    print("OK: test_write_disk_file_overwrite_shows_previous_content_in_payload")
    test_write_disk_file_refuses_credential_path_even_when_approved()
    print("OK: test_write_disk_file_refuses_credential_path_even_when_approved")
    test_delete_disk_file_declined_never_deletes()
    print("OK: test_delete_disk_file_declined_never_deletes")
    test_delete_disk_file_approved_deletes_and_payload_shows_real_content()
    print("OK: test_delete_disk_file_approved_deletes_and_payload_shows_real_content")
    test_delete_disk_file_refuses_credential_path()
    print("OK: test_delete_disk_file_refuses_credential_path")
    print("\n17 tests passed")
