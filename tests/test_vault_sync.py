"""Tests for assistant.vault_sync — the iPhone app's Vault sync API
(PLAN.md Phase 30 Stage 1, docs/adr/0004-*).

Real files in a tempdir monkeypatched in as the vault and a temp token file
(never the real ~/Documents/OniVault or the real .vault_token). The router is
mounted on its own tiny FastAPI app for most tests; one test goes through the
real `server.app` to prove the wiring and that the token is enforced there.
"""

from __future__ import annotations

import hashlib
import os
import stat
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from assistant import calendar_store, obsidian_tools, vault_search, vault_sync

TOKEN = "test-token-abc"


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@pytest.fixture
def vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "OniVault"
    root.mkdir()
    monkeypatch.setattr(obsidian_tools, "VAULT_DIR", root)
    monkeypatch.setattr(vault_search, "VAULT_DIR", root)
    token_path = tmp_path / "vault_token"
    token_path.write_text(TOKEN + "\n")
    monkeypatch.setattr(vault_sync, "TOKEN_PATH", token_path)
    return root


@pytest.fixture
def client(vault: Path) -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(vault_sync.router)
    c = TestClient(app)
    c.headers.update({"Authorization": f"Bearer {TOKEN}"})
    yield c


def _write(vault: Path, rel: str, text: str) -> Path:
    p = vault / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    return p


# --- Token ------------------------------------------------------------------


def test_every_vault_route_requires_the_token(vault: Path) -> None:
    app = FastAPI()
    app.include_router(vault_sync.router)
    bare = TestClient(app)
    routes = [r for r in vault_sync.router.routes if hasattr(r, "methods")]
    assert len(routes) >= 10  # guards against the loop silently checking nothing
    for route in routes:
        for method in route.methods - {"HEAD", "OPTIONS"}:
            path = route.path.replace("{", "").replace("}", "")
            resp = bare.request(method, path, json={} if method in {"POST", "PUT"} else None)
            assert resp.status_code == 401, f"{method} {route.path} answered {resp.status_code}"


@pytest.mark.parametrize(
    "header",
    [None, "", "Bearer", "Bearer ", "Bearer wrong", f"Basic {TOKEN}", TOKEN, f"Bearer  {TOKEN}x"],
)
def test_bad_or_missing_credentials_are_401(vault: Path, header: str | None) -> None:
    app = FastAPI()
    app.include_router(vault_sync.router)
    headers = {} if header is None else {"Authorization": header}
    resp = TestClient(app).get("/vault/ping", headers=headers)
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"] == "Bearer"


def test_correct_token_is_accepted(client: TestClient) -> None:
    assert client.get("/vault/ping").status_code == 200


def test_token_is_created_on_first_use_with_private_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "new_token"
    monkeypatch.setattr(vault_sync, "TOKEN_PATH", path)
    token = vault_sync.load_or_create_token()
    assert token and path.read_text().strip() == token
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert vault_sync.load_or_create_token() == token  # stable across calls


def test_rotating_replaces_the_token_and_the_old_one_stops_working(vault: Path) -> None:
    app = FastAPI()
    app.include_router(vault_sync.router)
    c = TestClient(app)
    new = vault_sync.load_or_create_token(rotate=True)
    assert new != TOKEN
    assert stat.S_IMODE(os.stat(vault_sync.TOKEN_PATH).st_mode) == 0o600
    assert c.get("/vault/ping", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 401
    assert c.get("/vault/ping", headers={"Authorization": f"Bearer {new}"}).status_code == 200


def test_an_empty_token_file_is_replaced_not_accepted(vault: Path) -> None:
    vault_sync.TOKEN_PATH.write_text("")
    app = FastAPI()
    app.include_router(vault_sync.router)
    c = TestClient(app)
    # An empty `Bearer ` must NOT authenticate against an empty token file.
    assert c.get("/vault/ping", headers={"Authorization": "Bearer "}).status_code == 401
    assert vault_sync.TOKEN_PATH.read_text().strip() != ""


def test_server_app_mounts_the_vault_api_behind_the_token(vault: Path) -> None:
    from assistant import server

    c = TestClient(server.app)  # no `with`: the lifespan (real graph) is not started
    assert c.get("/vault/ping").status_code == 401
    ok = c.get("/vault/ping", headers={"Authorization": f"Bearer {TOKEN}"})
    assert ok.status_code == 200 and ok.json()["ok"] is True


# --- Manifest ---------------------------------------------------------------


def test_manifest_lists_markdown_notes_with_hashes(client: TestClient, vault: Path) -> None:
    _write(vault, "A.md", "alpha")
    _write(vault, "People/B.md", "beta")
    notes = {n["path"]: n for n in client.get("/vault/manifest").json()["notes"]}
    assert set(notes) == {"A.md", "People/B.md"}
    assert notes["A.md"]["sha256"] == sha("alpha")
    assert notes["People/B.md"]["size"] == 4


def test_manifest_excludes_everything_that_is_not_a_syncable_note(
    client: TestClient, vault: Path
) -> None:
    _write(vault, "Keep.md", "x")
    _write(vault, ".obsidian/workspace.json", "{}")
    _write(vault, ".obsidian/notes.md", "hidden folder")
    _write(vault, ".trash/gone.md", "obsidian's own trash")
    _write(vault, "_conflicts/Keep (phone 2026-10-18 120000).md", "c")
    _write(vault, "_trash/Old.md", "t")
    _write(vault, "diagram.png", "not markdown")
    _write(vault, ".DS_Store", "")
    paths = {n["path"] for n in client.get("/vault/manifest").json()["notes"]}
    assert paths == {"Keep.md"}


def test_manifest_skips_symlinks(client: TestClient, vault: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside.md"
    outside.write_text("secret")
    (vault / "Link.md").symlink_to(outside)
    _write(vault, "Real.md", "x")
    assert {n["path"] for n in client.get("/vault/manifest").json()["notes"]} == {"Real.md"}


def test_ping_counts_notes(client: TestClient, vault: Path) -> None:
    _write(vault, "A.md", "x")
    body = client.get("/vault/ping").json()
    assert body["notes"] == 1 and body["vault"] == "OniVault"


# --- Reading a note ---------------------------------------------------------


def test_get_note_returns_text_and_hash(client: TestClient, vault: Path) -> None:
    _write(vault, "People/Ana — Notes.md", "héllo — world\n")
    body = client.get("/vault/note", params={"path": "People/Ana — Notes.md"}).json()
    assert body["content"] == "héllo — world\n"
    assert body["sha256"] == sha("héllo — world\n")


def test_get_note_missing_is_404(client: TestClient) -> None:
    assert client.get("/vault/note", params={"path": "Nope.md"}).status_code == 404


def test_get_note_can_read_reserved_folders(client: TestClient, vault: Path) -> None:
    _write(vault, "_trash/Old.md", "trashed")
    resp = client.get("/vault/note", params={"path": "_trash/Old.md"})
    assert resp.status_code == 200 and resp.json()["content"] == "trashed"


@pytest.mark.parametrize(
    "path",
    [
        "../outside.md",
        "People/../../outside.md",
        "/etc/passwd.md",
        "a//b.md",
        "./a.md",
        "a/./b.md",
        "dir/",
        "back\\slash.md",
        "nul\x00.md",
        "",
        ".obsidian/app.md",
        "People/.hidden.md",
        "notes.txt",
        ".obsidian/app.json",
        "Folder",
    ],
)
def test_unsafe_or_unsupported_paths_are_rejected_everywhere(
    client: TestClient, vault: Path, path: str
) -> None:
    assert client.get("/vault/note", params={"path": path}).status_code in {400, 422}
    assert client.put("/vault/note", json={"path": path, "content": "x"}).status_code in {400, 422}
    assert (
        client.delete("/vault/note", params={"path": path, "base_sha256": "0"}).status_code
        in {400, 422}
    )


def test_a_symlink_pointing_outside_the_vault_cannot_be_read_or_written(
    client: TestClient, vault: Path, tmp_path: Path
) -> None:
    outside = tmp_path / "outside.md"
    outside.write_text("secret")
    (vault / "Link.md").symlink_to(outside)
    assert client.get("/vault/note", params={"path": "Link.md"}).status_code == 400
    assert (
        client.put(
            "/vault/note", json={"path": "Link.md", "content": "pwned", "base_sha256": sha("secret")}
        ).status_code
        == 400
    )
    assert outside.read_text() == "secret"


# --- Writing a note ---------------------------------------------------------


def test_put_creates_a_new_note_including_new_folders(client: TestClient, vault: Path) -> None:
    resp = client.put("/vault/note", json={"path": "New Folder/Fresh.md", "content": "hello\n"})
    assert resp.status_code == 200
    assert resp.json()["sha256"] == sha("hello\n") and resp.json()["recreated"] is False
    assert (vault / "New Folder" / "Fresh.md").read_text() == "hello\n"


def test_put_preserves_exact_content(client: TestClient, vault: Path) -> None:
    text = "---\noni: true\n---\n\n# Title — ünïcode\n\n- [[Link]]\n\ttabbed\n\n"
    client.put("/vault/note", json={"path": "Exact.md", "content": text})
    assert (vault / "Exact.md").read_bytes() == text.encode("utf-8")


def test_put_with_matching_base_hash_updates(client: TestClient, vault: Path) -> None:
    _write(vault, "N.md", "v1")
    resp = client.put("/vault/note", json={"path": "N.md", "content": "v2", "base_sha256": sha("v1")})
    assert resp.status_code == 200
    assert (vault / "N.md").read_text() == "v2"


def test_put_with_stale_base_hash_is_a_409_and_changes_nothing(
    client: TestClient, vault: Path
) -> None:
    _write(vault, "N.md", "mac edited this")
    resp = client.put(
        "/vault/note", json={"path": "N.md", "content": "phone edit", "base_sha256": sha("old")}
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"code": "stale", "current_sha256": sha("mac edited this")}
    assert (vault / "N.md").read_text() == "mac edited this"


def test_put_creating_over_an_existing_note_is_a_409(client: TestClient, vault: Path) -> None:
    _write(vault, "N.md", "already here")
    resp = client.put("/vault/note", json={"path": "N.md", "content": "different"})
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "exists"
    assert (vault / "N.md").read_text() == "already here"


def test_put_is_idempotent_so_an_offline_queue_can_replay(client: TestClient, vault: Path) -> None:
    body = {"path": "N.md", "content": "v2", "base_sha256": sha("v1")}
    _write(vault, "N.md", "v1")
    assert client.put("/vault/note", json=body).status_code == 200
    # The response was lost; the phone replays the same write.
    assert client.put("/vault/note", json=body).status_code == 200
    assert (vault / "N.md").read_text() == "v2"


def test_an_edit_beats_a_delete_on_put(client: TestClient, vault: Path) -> None:
    # Phone edited a Note the Mac has since deleted (base hash, no file).
    resp = client.put(
        "/vault/note", json={"path": "Gone.md", "content": "phone's edit", "base_sha256": sha("old")}
    )
    assert resp.status_code == 200 and resp.json()["recreated"] is True
    assert (vault / "Gone.md").read_text() == "phone's edit"


@pytest.mark.parametrize("path", ["_conflicts/X.md", "_trash/X.md", "_trash/Sub/X.md"])
def test_notes_cannot_be_written_or_deleted_inside_reserved_folders(
    client: TestClient, vault: Path, path: str
) -> None:
    assert client.put("/vault/note", json={"path": path, "content": "x"}).status_code == 403
    assert (
        client.delete("/vault/note", params={"path": path, "base_sha256": "0"}).status_code == 403
    )
    assert not (vault / path).exists()


def test_oversized_note_is_413(client: TestClient, vault: Path) -> None:
    big = "x" * (vault_sync.MAX_NOTE_BYTES + 1)
    assert client.put("/vault/note", json={"path": "Big.md", "content": big}).status_code == 413
    assert not (vault / "Big.md").exists()


def test_no_temp_files_are_left_behind(client: TestClient, vault: Path) -> None:
    client.put("/vault/note", json={"path": "A.md", "content": "x"})
    assert [p.name for p in vault.iterdir()] == ["A.md"]


def test_the_user_may_edit_a_note_oni_did_not_write(client: TestClient, vault: Path) -> None:
    # The oni:true guard belongs to Oni's tools; this API is the user acting.
    _write(vault, "Mine.md", "no frontmatter at all")
    resp = client.put(
        "/vault/note",
        json={"path": "Mine.md", "content": "edited", "base_sha256": sha("no frontmatter at all")},
    )
    assert resp.status_code == 200


# --- Soft delete ------------------------------------------------------------


def test_delete_moves_the_note_to_trash_keeping_its_path(client: TestClient, vault: Path) -> None:
    _write(vault, "People/Ana.md", "content")
    resp = client.delete("/vault/note", params={"path": "People/Ana.md", "base_sha256": sha("content")})
    assert resp.status_code == 200
    assert not (vault / "People" / "Ana.md").exists()
    assert (vault / "_trash" / "People" / "Ana.md").read_text() == "content"
    assert resp.json()["trashed_as"] == "_trash/People/Ana.md"


def test_an_edit_on_the_mac_beats_a_phone_delete(client: TestClient, vault: Path) -> None:
    _write(vault, "N.md", "edited on the mac since the phone synced")
    resp = client.delete("/vault/note", params={"path": "N.md", "base_sha256": sha("old")})
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "stale"
    assert (vault / "N.md").exists()
    assert not (vault / "_trash").exists()


def test_delete_of_a_missing_note_is_404(client: TestClient) -> None:
    resp = client.delete("/vault/note", params={"path": "Nope.md", "base_sha256": "0"})
    assert resp.status_code == 404


def test_delete_requires_a_base_hash(client: TestClient, vault: Path) -> None:
    _write(vault, "N.md", "x")
    assert client.delete("/vault/note", params={"path": "N.md"}).status_code == 422
    assert (vault / "N.md").exists()


def test_deleting_the_same_name_twice_does_not_overwrite_the_first_trash_copy(
    client: TestClient, vault: Path
) -> None:
    _write(vault, "N.md", "first")
    client.delete("/vault/note", params={"path": "N.md", "base_sha256": sha("first")})
    _write(vault, "N.md", "second")
    client.delete("/vault/note", params={"path": "N.md", "base_sha256": sha("second")})
    contents = sorted(p.read_text() for p in (vault / "_trash").glob("*.md"))
    assert contents == ["first", "second"]


# --- Conflict copies --------------------------------------------------------


def test_conflict_upload_stores_the_phone_version_in_conflicts(
    client: TestClient, vault: Path
) -> None:
    _write(vault, "People/Ana.md", "mac version")
    resp = client.post("/vault/conflicts", json={"path": "People/Ana.md", "content": "phone version"})
    assert resp.status_code == 200
    stored = vault / resp.json()["path"]
    assert resp.json()["path"].startswith("_conflicts/People/Ana (phone ")
    assert stored.read_text() == "phone version"
    assert (vault / "People" / "Ana.md").read_text() == "mac version"  # untouched


def test_conflict_upload_is_idempotent_for_identical_content(
    client: TestClient, vault: Path
) -> None:
    body = {"path": "Ana.md", "content": "phone version"}
    first = client.post("/vault/conflicts", json=body).json()
    second = client.post("/vault/conflicts", json=body).json()
    assert first["path"] == second["path"]
    assert len(list((vault / "_conflicts").rglob("*.md"))) == 1


def test_different_phone_content_makes_a_second_conflict_copy(
    client: TestClient, vault: Path
) -> None:
    client.post("/vault/conflicts", json={"path": "Ana.md", "content": "one"})
    client.post("/vault/conflicts", json={"path": "Ana.md", "content": "two"})
    assert len(list((vault / "_conflicts").rglob("*.md"))) == 2


def test_conflicts_are_listed_with_their_original_path_and_can_be_resolved(
    client: TestClient, vault: Path
) -> None:
    created = client.post("/vault/conflicts", json={"path": "People/Ana.md", "content": "p"}).json()
    listed = client.get("/vault/conflicts").json()["conflicts"]
    assert [c["path"] for c in listed] == [created["path"]]
    assert listed[0]["original_path"] == "People/Ana.md"
    resp = client.delete("/vault/conflicts", params={"path": created["path"]})
    assert resp.status_code == 200
    assert client.get("/vault/conflicts").json()["conflicts"] == []


def test_resolving_only_works_inside_conflicts(client: TestClient, vault: Path) -> None:
    _write(vault, "Real.md", "keep")
    _write(vault, "_trash/Old.md", "keep")
    for path in ["Real.md", "_trash/Old.md", "_conflicts"]:
        assert client.delete("/vault/conflicts", params={"path": path}).status_code in {400, 403}
    assert (vault / "Real.md").exists() and (vault / "_trash" / "Old.md").exists()


def test_conflict_upload_cannot_target_a_reserved_or_unsafe_path(
    client: TestClient, vault: Path
) -> None:
    for path in ["_trash/X.md", "_conflicts/X.md", "../x.md", ".obsidian/x.md", "x.txt"]:
        resp = client.post("/vault/conflicts", json={"path": path, "content": "x"})
        assert resp.status_code in {400, 403}, path
    assert not (vault / "_conflicts").exists()


# --- Trash ------------------------------------------------------------------


def test_trash_lists_restores_and_never_overwrites(client: TestClient, vault: Path) -> None:
    _write(vault, "People/Ana.md", "content")
    client.delete("/vault/note", params={"path": "People/Ana.md", "base_sha256": sha("content")})
    listed = client.get("/vault/trash").json()["trash"]
    assert [t["original_path"] for t in listed] == ["People/Ana.md"]

    resp = client.post("/vault/trash/restore", json={"path": "_trash/People/Ana.md"})
    assert resp.status_code == 200 and resp.json()["path"] == "People/Ana.md"
    assert (vault / "People" / "Ana.md").read_text() == "content"
    assert client.get("/vault/trash").json()["trash"] == []


def test_restore_refuses_to_overwrite_something_that_is_now_there(
    client: TestClient, vault: Path
) -> None:
    _write(vault, "_trash/N.md", "trashed")
    _write(vault, "N.md", "new note with the same name")
    resp = client.post("/vault/trash/restore", json={"path": "_trash/N.md"})
    assert resp.status_code == 409
    assert (vault / "N.md").read_text() == "new note with the same name"
    assert (vault / "_trash" / "N.md").exists()


def test_restore_strips_the_deleted_marker_from_a_collision_name(
    client: TestClient, vault: Path
) -> None:
    _write(vault, "_trash/N (deleted 2026-10-18 120000).md", "older copy")
    resp = client.post("/vault/trash/restore", json={"path": "_trash/N (deleted 2026-10-18 120000).md"})
    assert resp.status_code == 200 and resp.json()["path"] == "N.md"


def test_restore_only_accepts_trash_paths(client: TestClient, vault: Path) -> None:
    _write(vault, "Real.md", "x")
    assert client.post("/vault/trash/restore", json={"path": "Real.md"}).status_code == 403


def test_emptying_the_trash_requires_confirm_and_removes_only_the_trash(
    client: TestClient, vault: Path
) -> None:
    _write(vault, "Keep.md", "keep")
    _write(vault, "_trash/A.md", "a")
    _write(vault, "_trash/Sub/B.md", "b")
    _write(vault, "_conflicts/C (phone 2026-10-18 120000).md", "c")
    assert client.delete("/vault/trash").status_code == 400
    assert (vault / "_trash" / "A.md").exists()

    resp = client.delete("/vault/trash", params={"confirm": "true"})
    assert resp.json()["removed"] == 2
    assert not list((vault / "_trash").rglob("*.md"))
    assert (vault / "Keep.md").exists()
    assert list((vault / "_conflicts").rglob("*.md"))  # conflicts are not trash


# --- Semantic search --------------------------------------------------------


def test_search_maps_titles_to_paths_and_drops_unknown_ones(
    client: TestClient, vault: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(vault, "People/Ana.md", "x")
    _write(vault, "_trash/Ghost.md", "x")
    monkeypatch.setattr(
        vault_search, "semantic_search", lambda q, **kw: [("Ana", 0.71234), ("Ghost", 0.5)]
    )
    hits = client.get("/vault/search", params={"q": "someone"}).json()["hits"]
    assert hits == [{"title": "Ana", "path": "People/Ana.md", "score": 0.7123}]


def test_search_validates_the_query(client: TestClient) -> None:
    assert client.get("/vault/search", params={"q": ""}).status_code == 422
    assert client.get("/vault/search", params={"q": "x" * 501}).status_code == 422


# --- Oni's own side: the reserved folders are invisible ---------------------


def test_oni_never_sees_conflict_copies_or_trash(vault: Path) -> None:
    _write(vault, "Real Note.md", "---\noni: true\n---\n\nneedle in a real note\n")
    _write(vault, "_conflicts/Real Note (phone 2026-10-18 120000).md", "needle in a conflict")
    _write(vault, "_trash/Trashed Note.md", "---\noni: true\n---\n\nneedle in the trash\n")

    result = obsidian_tools.search_vault.invoke({"query": "needle"})
    assert "[[Real Note]]" in result
    assert "conflict" not in result.lower() and "Trashed Note" not in result

    assert obsidian_tools.read_vault_note.invoke({"title": "Trashed Note"}).startswith("Error:")
    assert [p.name for p in obsidian_tools._iter_notes()] == ["Real Note.md"]
    assert [p.name for p in vault_search._current_notes()] == ["Real Note.md"]


def test_oni_can_create_a_note_with_the_title_of_a_trashed_one(vault: Path) -> None:
    _write(vault, "_trash/Reused.md", "---\noni: true\n---\n\nold\n")
    result = obsidian_tools.write_vault_note.invoke({"title": "Reused", "content": "new"})
    assert result.startswith("Created")
    assert (vault / "Reused.md").exists()


def test_oni_cannot_update_or_delete_what_is_in_the_trash(vault: Path) -> None:
    _write(vault, "_trash/Old.md", "---\noni: true\n---\n\nbody\n")
    assert obsidian_tools.update_vault_note.invoke({"title": "Old", "content": "x"}).startswith(
        "Error:"
    )
    assert obsidian_tools.delete_vault_note.invoke({"title": "Old"}).startswith("Error:")
    assert (vault / "_trash" / "Old.md").read_text().endswith("body\n")


def test_oni_delete_moves_to_trash_and_keeps_the_authorship_guard(vault: Path) -> None:
    _write(vault, "Mine.md", "---\noni: true\n---\n\nbody\n")
    _write(vault, "Users.md", "the user's own note")
    assert obsidian_tools.delete_vault_note.invoke({"title": "Mine"}).startswith("Deleted")
    assert not (vault / "Mine.md").exists()
    assert (vault / "_trash" / "Mine.md").read_text().endswith("body\n")
    assert "refusing" in obsidian_tools.delete_vault_note.invoke({"title": "Users"}).lower()
    assert (vault / "Users.md").exists()


def test_calendar_parser_ignores_a_semester_note_conflict_copy(vault: Path) -> None:
    _write(vault, "Semester 3 (2026-27)/Semester 3 — Timetable.md", "x")
    _write(vault, "_conflicts/Semester 3 — Timetable (phone 2026-10-18 120000).md", "x")
    _write(vault, "_trash/Semester 1 — Old.md", "x")
    found = calendar_store._find_notes(".md")
    assert [p.name for p in found] == ["Semester 3 — Timetable.md"]
