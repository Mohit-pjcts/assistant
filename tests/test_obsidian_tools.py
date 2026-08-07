"""Tests for assistant.obsidian_tools — PLAN.md Phase 27's Obsidian vault
(Oni's own note-store), fully ungated per docs/adr/0001-*.

Real file operations against a tempdir monkeypatched in as VAULT_DIR (never
the real ~/Documents/OniVault) — same "real calls, no mocking" convention as
test_disk_tools.py.
"""

import tempfile
from contextlib import contextmanager
from pathlib import Path

from langchain_core.messages import AIMessage

import assistant.obsidian_tools as obsidian_tools


@contextmanager
def _temp_vault():
    with tempfile.TemporaryDirectory() as tmp:
        vault = Path(tmp) / "OniVault"
        vault.mkdir()
        original = obsidian_tools.VAULT_DIR
        obsidian_tools.VAULT_DIR = vault
        try:
            yield vault
        finally:
            obsidian_tools.VAULT_DIR = original


def _writes_call_history(n: int) -> list:
    """A fake message history containing `n` prior write/update tool calls,
    for exercising the per-turn cap without actually making n real calls."""
    return [
        AIMessage(content="", tool_calls=[{"name": "write_vault_note", "id": f"c{i}", "args": {}}])
        for i in range(n)
    ]


def _invoke(tool, args: dict, messages: list | None = None):
    return tool.invoke({**args, "state": {"messages": messages or []}})


# --- search_vault ---------------------------------------------------------


def test_search_vault_finds_by_title() -> None:
    with _temp_vault() as vault:
        (vault / "Recursion Basics.md").write_text("---\noni: true\n---\n\nSome content.\n")
        result = obsidian_tools.search_vault.invoke({"query": "recursion"})
    assert "[[Recursion Basics]]" in result


def test_search_vault_finds_by_content_and_shows_snippet() -> None:
    with _temp_vault() as vault:
        (vault / "Random Note.md").write_text(
            "---\noni: true\n---\n\nThe Fibonacci sequence is a classic recursion example.\n"
        )
        result = obsidian_tools.search_vault.invoke({"query": "fibonacci"})
    assert "[[Random Note]]" in result
    assert "fibonacci" in result.lower() or "Fibonacci" in result


def test_search_vault_no_matches_reports_plainly() -> None:
    with _temp_vault():
        result = obsidian_tools.search_vault.invoke({"query": "nonexistent topic xyz"})
    assert "No notes found" in result


def test_search_vault_is_recursive_into_subfolders() -> None:
    with _temp_vault() as vault:
        nested = vault / "Semester 2" / "COMP2113"
        nested.mkdir(parents=True)
        (nested / "STL Containers.md").write_text("---\noni: false\n---\n\nvector, list, map.\n")
        result = obsidian_tools.search_vault.invoke({"query": "STL"})
    assert "[[STL Containers]]" in result


# --- read_vault_note --------------------------------------------------------


def test_read_vault_note_reads_existing_note() -> None:
    with _temp_vault() as vault:
        (vault / "My Note.md").write_text("---\noni: true\n---\n\nHello world.\n")
        result = obsidian_tools.read_vault_note.invoke({"title": "My Note"})
    assert "Hello world." in result


def test_read_vault_note_missing_reports_error_not_exception() -> None:
    with _temp_vault():
        result = obsidian_tools.read_vault_note.invoke({"title": "Does Not Exist"})
    assert result.startswith("Error:")


def test_read_vault_note_finds_notes_in_subfolders() -> None:
    with _temp_vault() as vault:
        nested = vault / "Semester 1" / "MATH1013"
        nested.mkdir(parents=True)
        (nested / "Ch 1 — Functions.md").write_text("---\noni: false\n---\n\nDomain and range.\n")
        result = obsidian_tools.read_vault_note.invoke({"title": "Ch 1 — Functions"})
    assert "Domain and range." in result


# --- write_vault_note --------------------------------------------------------


def test_write_vault_note_creates_note_with_oni_marker() -> None:
    with _temp_vault() as vault:
        result = _invoke(obsidian_tools.write_vault_note, {"title": "New Idea", "content": "Some content."})
        path = vault / "New Idea.md"
        assert path.exists()
        text = path.read_text()
        assert "oni: true" in text
        assert "Some content." in text
        assert "Created" in result


def test_write_vault_note_refuses_title_collision() -> None:
    with _temp_vault() as vault:
        (vault / "Existing.md").write_text("---\noni: true\n---\n\nAlready here.\n")
        result = _invoke(obsidian_tools.write_vault_note, {"title": "Existing", "content": "New stuff"})
        assert "already exists" in result.lower()
        assert vault.joinpath("Existing.md").read_text() == "---\noni: true\n---\n\nAlready here.\n"


def test_write_vault_note_auto_links_related_notes_by_title_overlap() -> None:
    with _temp_vault() as vault:
        (vault / "COMP2113 — Recursion.md").write_text("---\noni: false\n---\n\nBase case, recursive case.\n")
        result = _invoke(
            obsidian_tools.write_vault_note,
            {"title": "COMP2113 — Recursion Practice Problems", "content": "More examples."},
        )
        text = (vault / "COMP2113 — Recursion Practice Problems.md").read_text()
    assert "Related Notes" in text
    assert "[[COMP2113 — Recursion]]" in text
    assert "linked to 1 related note" in result


def test_write_vault_note_no_related_notes_found_still_succeeds() -> None:
    with _temp_vault() as vault:
        result = _invoke(obsidian_tools.write_vault_note, {"title": "Completely Unrelated Xyzzy", "content": "..."})
        text = (vault / "Completely Unrelated Xyzzy.md").read_text()
    assert "Related Notes" not in text
    assert "no related notes found" in result.lower()


def test_write_vault_note_creates_vault_dir_if_missing() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        vault = Path(tmp) / "does" / "not" / "exist" / "yet"
        original = obsidian_tools.VAULT_DIR
        obsidian_tools.VAULT_DIR = vault
        try:
            _invoke(obsidian_tools.write_vault_note, {"title": "First Note", "content": "hi"})
            assert (vault / "First Note.md").exists()
        finally:
            obsidian_tools.VAULT_DIR = original


def test_write_vault_note_respects_per_turn_cap() -> None:
    with _temp_vault() as vault:
        result = _invoke(
            obsidian_tools.write_vault_note,
            {"title": "Once Too Many", "content": "x"},
            messages=_writes_call_history(3),
        )
        assert "per-turn cap" in result.lower()
        assert not (vault / "Once Too Many.md").exists()


def test_write_vault_note_under_cap_still_succeeds() -> None:
    with _temp_vault() as vault:
        _invoke(
            obsidian_tools.write_vault_note,
            {"title": "Fits Under Cap", "content": "x"},
            messages=_writes_call_history(2),
        )
        assert (vault / "Fits Under Cap.md").exists()


# --- update_vault_note --------------------------------------------------------


def test_update_vault_note_replaces_body_and_preserves_oni_marker() -> None:
    with _temp_vault() as vault:
        (vault / "Draft.md").write_text("---\noni: true\ncreated: 2026-01-01\n---\n\nOld body.\n")
        result = _invoke(obsidian_tools.update_vault_note, {"title": "Draft", "content": "New body."})
        text = (vault / "Draft.md").read_text()
    assert "New body." in text
    assert "Old body." not in text
    assert "oni: true" in text
    assert "created: 2026-01-01" in text  # original creation date preserved
    assert "updated:" in text
    assert "Updated" in result


def test_update_vault_note_refuses_note_not_authored_by_oni() -> None:
    """The user's own MATH1013/COMP2113/etc. notes carry no oni:true marker
    at all — this is the same protection delete_vault_note has, deliberately
    extended to update (see module docstring)."""
    with _temp_vault() as vault:
        (vault / "Users Own Note.md").write_text("---\noni: false\n---\n\nThe user wrote this.\n")
        result = _invoke(obsidian_tools.update_vault_note, {"title": "Users Own Note", "content": "Overwritten!"})
        text = (vault / "Users Own Note.md").read_text()
    assert "refusing" in result.lower()
    assert "The user wrote this." in text
    assert "Overwritten!" not in text


def test_update_vault_note_refuses_note_with_no_frontmatter_at_all() -> None:
    with _temp_vault() as vault:
        (vault / "Plain File.md").write_text("Just plain text, no frontmatter.\n")
        result = _invoke(obsidian_tools.update_vault_note, {"title": "Plain File", "content": "Overwritten!"})
    assert "refusing" in result.lower()


def test_update_vault_note_missing_note_reports_error() -> None:
    with _temp_vault():
        result = _invoke(obsidian_tools.update_vault_note, {"title": "Nope", "content": "x"})
    assert result.startswith("Error:")


def test_update_vault_note_respects_per_turn_cap() -> None:
    with _temp_vault() as vault:
        (vault / "Draft.md").write_text("---\noni: true\n---\n\nOld.\n")
        result = _invoke(
            obsidian_tools.update_vault_note,
            {"title": "Draft", "content": "New."},
            messages=_writes_call_history(3),
        )
        assert "per-turn cap" in result.lower()
        assert "Old." in (vault / "Draft.md").read_text()


# --- delete_vault_note --------------------------------------------------------


def test_delete_vault_note_deletes_oni_authored_note() -> None:
    with _temp_vault() as vault:
        (vault / "Scratch.md").write_text("---\noni: true\n---\n\nDelete me.\n")
        result = obsidian_tools.delete_vault_note.invoke({"title": "Scratch"})
        assert not (vault / "Scratch.md").exists()
        assert "Deleted" in result


def test_delete_vault_note_refuses_note_not_authored_by_oni() -> None:
    with _temp_vault() as vault:
        (vault / "Users Own Note.md").write_text("---\noni: false\n---\n\nKeep this.\n")
        result = obsidian_tools.delete_vault_note.invoke({"title": "Users Own Note"})
        assert "refusing" in result.lower()
        assert (vault / "Users Own Note.md").exists()


def test_delete_vault_note_refuses_note_with_no_frontmatter() -> None:
    with _temp_vault() as vault:
        (vault / "No Frontmatter.md").write_text("Just text.\n")
        result = obsidian_tools.delete_vault_note.invoke({"title": "No Frontmatter"})
        assert "refusing" in result.lower()
        assert (vault / "No Frontmatter.md").exists()


def test_delete_vault_note_missing_note_reports_error() -> None:
    with _temp_vault():
        result = obsidian_tools.delete_vault_note.invoke({"title": "Ghost"})
    assert result.startswith("Error:")


# --- lifecycle integration ---------------------------------------------------


def test_full_lifecycle_write_read_update_delete() -> None:
    with _temp_vault():
        _invoke(obsidian_tools.write_vault_note, {"title": "Lifecycle Note", "content": "v1"})
        assert "v1" in obsidian_tools.read_vault_note.invoke({"title": "Lifecycle Note"})

        _invoke(obsidian_tools.update_vault_note, {"title": "Lifecycle Note", "content": "v2"})
        read_back = obsidian_tools.read_vault_note.invoke({"title": "Lifecycle Note"})
        assert "v2" in read_back
        assert "v1" not in read_back

        delete_result = obsidian_tools.delete_vault_note.invoke({"title": "Lifecycle Note"})
        assert "Deleted" in delete_result
        assert obsidian_tools.read_vault_note.invoke({"title": "Lifecycle Note"}).startswith("Error:")


if __name__ == "__main__":
    tests = [
        test_search_vault_finds_by_title,
        test_search_vault_finds_by_content_and_shows_snippet,
        test_search_vault_no_matches_reports_plainly,
        test_search_vault_is_recursive_into_subfolders,
        test_read_vault_note_reads_existing_note,
        test_read_vault_note_missing_reports_error_not_exception,
        test_read_vault_note_finds_notes_in_subfolders,
        test_write_vault_note_creates_note_with_oni_marker,
        test_write_vault_note_refuses_title_collision,
        test_write_vault_note_auto_links_related_notes_by_title_overlap,
        test_write_vault_note_no_related_notes_found_still_succeeds,
        test_write_vault_note_creates_vault_dir_if_missing,
        test_write_vault_note_respects_per_turn_cap,
        test_write_vault_note_under_cap_still_succeeds,
        test_update_vault_note_replaces_body_and_preserves_oni_marker,
        test_update_vault_note_refuses_note_not_authored_by_oni,
        test_update_vault_note_refuses_note_with_no_frontmatter_at_all,
        test_update_vault_note_missing_note_reports_error,
        test_update_vault_note_respects_per_turn_cap,
        test_delete_vault_note_deletes_oni_authored_note,
        test_delete_vault_note_refuses_note_not_authored_by_oni,
        test_delete_vault_note_refuses_note_with_no_frontmatter,
        test_delete_vault_note_missing_note_reports_error,
        test_full_lifecycle_write_read_update_delete,
    ]
    for t in tests:
        t()
        print(f"OK: {t.__name__}")
    print(f"\n{len(tests)} tests passed")
