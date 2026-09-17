---
status: accepted
---

# The per-turn Vault write cap is removed, not fixed

ADR 0002 named the per-turn cap of 3 combined `write_vault_note`/
`update_vault_note` calls as "the only backstop" against Oni's autonomous
Vault-writing turning into a runaway-cost or runaway-noise loop, and said
it "should not be relaxed without revisiting this decision." That
revisiting happened during a bug-fix grilling session: the cap was also
found to be scoped incorrectly (it resets on every fresh specialist
`ainvoke()`, so Phase 25 workflow chaining could already exceed 3 writes
in one real user turn despite the cap's own framing as a per-turn limit —
`assistant/obsidian_tools.py`'s `_count_prior_writes_this_turn` only sees
one specialist delegation's own messages). Offered the choice between
fixing the cap's scope (threading a true turn-scoped counter through
`call_specialist`) or removing it outright, the user chose removal.

**Consequences:** ADR 0002's "should not be relaxed without revisiting"
condition is satisfied by this decision — it supersedes that specific
consequence, not the rest of ADR 0002 (Oni still writes autonomously,
unchanged). Vault writes now have no per-turn ceiling of any kind; the
only remaining backstop against runaway Vault writes in a single turn is
whatever general judgment the model exercises on its own. Revisit if
this produces an observed runaway-writing incident, the same way Phase
27's own `oni: true` mislabeling incident (STEPS.md 127) prompted a real
fix rather than staying theoretical.
