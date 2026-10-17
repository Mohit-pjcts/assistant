"""Tests for assistant.diary_store — daily diary entries in Oni's own
vault (Diary/ subfolder). Real file operations against a tempdir
monkeypatched in as obsidian_tools.VAULT_DIR (diary_store imports that same
binding), same convention as test_obsidian_tools.py.
"""

import tempfile
from contextlib import contextmanager
from datetime import date
from pathlib import Path

import assistant.diary_store as diary_store
import assistant.obsidian_tools as obsidian_tools
import assistant.vault_search as vault_search


@contextmanager
def _temp_vault():
    """Also stubs vault_search.semantic_search for the duration, same
    reason as test_obsidian_tools.py's own fixture: search_vault() always
    calls it, and without a stub that would hit the real embedding model
    (and the real ~/Documents/OniVault binding vault_search.py imports
    separately) instead of staying isolated to this test's tempdir."""
    with tempfile.TemporaryDirectory() as tmp:
        vault = Path(tmp) / "OniVault"
        vault.mkdir()
        original = obsidian_tools.VAULT_DIR
        original_semantic_search = vault_search.semantic_search
        obsidian_tools.VAULT_DIR = vault
        diary_store.VAULT_DIR = vault
        vault_search.semantic_search = lambda query, **kw: []
        try:
            yield vault
        finally:
            obsidian_tools.VAULT_DIR = original
            diary_store.VAULT_DIR = original
            vault_search.semantic_search = original_semantic_search


def test_write_creates_a_new_entry_for_today() -> None:
    with _temp_vault():
        entry = diary_store.write_diary_entry("Had a good day.")
        assert entry.entry_date == date.today().isoformat()
        assert entry.content == "Had a good day."
        assert entry.updated_at is None


def test_write_is_upsert_not_append() -> None:
    with _temp_vault():
        d = date(2026, 9, 28)
        diary_store.write_diary_entry("First draft.", d)
        second = diary_store.write_diary_entry("Final version.", d)
        assert second.content == "Final version."
        fetched = diary_store.get_diary_entry(d)
        assert fetched is not None
        assert fetched.content == "Final version."
        assert "First draft" not in fetched.content
        assert fetched.updated_at is not None


def test_write_preserves_original_created_date_across_edits() -> None:
    with _temp_vault():
        d = date(2026, 9, 1)
        first = diary_store.write_diary_entry("Day one.", d)
        second = diary_store.write_diary_entry("Day one, edited.", d)
        assert second.created_at == first.created_at


def test_get_returns_none_for_a_day_with_no_entry() -> None:
    with _temp_vault():
        assert diary_store.get_diary_entry(date(2020, 1, 1)) is None


def test_list_returns_entries_newest_day_first() -> None:
    with _temp_vault():
        diary_store.write_diary_entry("Earlier.", date(2026, 9, 1))
        diary_store.write_diary_entry("Later.", date(2026, 9, 15))
        entries = diary_store.list_diary_entries()
        assert [e.entry_date for e in entries] == ["2026-09-15", "2026-09-01"]


def test_list_is_empty_when_no_diary_folder_exists_yet() -> None:
    with _temp_vault():
        assert diary_store.list_diary_entries() == []


def test_delete_removes_an_entry() -> None:
    with _temp_vault():
        d = date(2026, 9, 10)
        diary_store.write_diary_entry("To be deleted.", d)
        assert diary_store.delete_diary_entry(d) is True
        assert diary_store.get_diary_entry(d) is None


def test_delete_returns_false_for_a_day_with_no_entry() -> None:
    with _temp_vault():
        assert diary_store.delete_diary_entry(date(2020, 1, 1)) is False


def test_entry_is_never_marked_oni_authored() -> None:
    """The load-bearing security property (module docstring): a diary
    entry must NOT carry `oni: true`, or Oni's own update_vault_note/
    delete_vault_note tools would be able to overwrite or delete the
    user's own writing."""
    with _temp_vault() as vault:
        d = date(2026, 9, 20)
        diary_store.write_diary_entry("Private thoughts.", d)
        raw = (vault / "Diary" / "2026-09-20.md").read_text()
        assert "oni: true" not in raw
        assert "diary: true" in raw


def test_oni_delete_vault_note_refuses_to_touch_a_diary_entry() -> None:
    """End-to-end proof of the same property, through Oni's actual tool
    rather than just inspecting frontmatter — a diary Note gets exactly
    the same protection as any other note the user wrote by hand."""
    with _temp_vault():
        d = date(2026, 9, 21)
        diary_store.write_diary_entry("Do not touch.", d)
        result = obsidian_tools.delete_vault_note.invoke({"title": "2026-09-21"})
        assert "refusing to delete" in result
        assert diary_store.get_diary_entry(d) is not None


def test_search_vault_finds_diary_entries() -> None:
    """Diary/ is just another subfolder under the vault root, so the
    existing whole-tree search already reaches it with no code change."""
    with _temp_vault():
        diary_store.write_diary_entry("Ate a whole watermelon today.", date(2026, 9, 22))
        result = obsidian_tools.search_vault.invoke({"query": "watermelon"})
        assert "2026-09-22" in result
