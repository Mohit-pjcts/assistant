---
status: accepted
---

# Oni writes Vault Notes on its own judgment, not only on request

Phase 27 gives `research_agent`/`life_admin_agent` a Vault explicitly framed
by the user as a "second brain" — somewhere to keep information that
doesn't need to be in context every run but might be useful later. The
lower-risk default would have been request-only writes ("save this to my
notes"), matching this same scoping session's own instinct to start narrow
(mirrored in Phase 27's tool-ownership call — `research_agent`/
`life_admin_agent` only, not all four specialists, to prove the narrow case
first). The user explicitly chose the wider shape instead: Oni decides for
itself, during ordinary conversation, when something is worth saving — no
explicit ask required.

**Consequences:** this is a new autonomy category for the project. Every
other unattended or ungated action to date still requires either an
explicit user request in the same turn, or a pre-registered automation
(Phase 24's pre-approved automations). Vault writes now happen as a side
effect of any conversation, with zero request and zero gate. The per-turn
cap of 3 combined `write_vault_note`/`update_vault_note` calls (PLAN.md
Phase 27) is the only backstop against this becoming a runaway-cost or
runaway-noise loop, and should not be relaxed without revisiting this
decision.
