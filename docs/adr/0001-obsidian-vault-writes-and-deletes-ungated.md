---
status: accepted
---

# Obsidian vault writes and deletes are fully ungated

This project's standing rule requires explicit confirmation before any
side-effectful action — `disk_tools.py`'s own `write_disk_file`/
`delete_disk_file` honor this via `interrupt()`. For the new Obsidian Vault
(`assistant/obsidian_tools.py`, PLAN.md Phase 27), the user explicitly chose
to skip confirmation entirely for `write_vault_note`/`update_vault_note`/
`delete_vault_note`: the Vault is a real, local Obsidian vault they can
audit directly in the app whenever they want, so a per-write approval gate
would just recreate the exact friction the 2026-07-28 memory
re-architecture (STEPS.md 115) already removed for a structurally similar
problem — frequent, low-stakes writes that don't need to block a live
conversation. `delete_vault_note` keeps one narrow backstop instead of a
gate: it refuses to delete any Note lacking an `oni: true` frontmatter
marker, so it can never remove content the user added themselves.

**Consequences:** this is the fourth deliberate weakening of the standing
confirmation rule in this project's history (after `open_url_in_brave` in
Phase 13, the kanban board in Phase 20, and `run_shortcut_on_phone` in
Phase 21) — each justified independently on its own terms, not by citing
the others as precedent alone.
