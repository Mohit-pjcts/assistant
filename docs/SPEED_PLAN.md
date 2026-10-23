# Oni speed plan: final (2026-10-23)

**Progress (STEPS 206):** gate gaps 1 and 2 closed, vault cases added (gap 3), R3 internals built and measured (keyword-style R@5 0.14 to 0.86, paraphrase 0.30 to 0.80, 0 old hits lost). The stubbed gate passed on the new `read_vault_note` schema (STEPS 206.4; not a clean same-code baseline). Still owed for R3: the prompt line after `supervisor.py` is committed. `conversation_search.py` deferred. Stays on Sonnet 5.5.

Companion to [SPEED_RESEARCH.md](SPEED_RESEARCH.md), which holds the measurements and sources. This file is the decision: what to build, in what order, what must pass before each item merges, and what is still a guess. Priority: faster > smarter > cheaper. The bar: nothing may get dumber.

## Status of the evidence

| kind | what it covers |
|---|---|
| **Measured** | where time goes (52% of a model call is before the first token, floor ~2.6 s); delegation shapes (mac_control 91% of calls need <=1 tool); vault retrieval recall (0.10 to 0.98 keyword-style, 0.30 to 0.80 paraphrase at R@5); strict tool use is slower (+15 s compile, +0.7 s warm); Haiku supervisor skipped a gate; Opus fast is ~1.1 s faster per supervisor turn (runs hours apart, so confounded) but swapped Apple/Google calendar action names in the gate (3 of 3 cases, every repeat) |
| **Projected** | every end-to-end saving: R1 (~5 s per removed hop), R2, R4 (at most ~0.45 s per Stage task, ~5%), cost (R1.1 alone ~1% at today's two bundled workflows; chunked reads maybe a few %, only if the cap sits below the 3.1k-token mean). Spend is about $10.1 per 10 days (~$1.0/day), not the $8.5 first reported |
| **Not studied** | compaction and memory-review quality; real-use Stage failure rate; a fresh noise estimate for the final case set (baseline has 2 repeats) |

## The gate (exists, built)

`python -m evals.stubbed` (STEPS 203/204): 80 decision cases and 10 reply cases, tools stubbed and never invoked, Haiku judge (21/21 on its self-test), `compare` as pass/fail. Zero tolerance on gating invariants and on consistent regressions; margins on routing (4 points), arguments (5) and replies (5); pairwise tolerance `max(2, 2*sqrt(decided pairs))`; a run with >2% errors is invalid. Cost: about $1 per variant at 2 repeats. Reference baseline: `evals/stubbed_runs/base-final.json` (gitignored; re-run if prompts or tools change).

**Known gate gaps to close before leaning on it (do these first, all free):**
1. Run files carry no prompt/tool fingerprint, and `capture.py` uses `get_prompt`, which prefers the remote Langfuse prompt. Store a hash of each agent's system prompt and tool schemas in the run JSON and make `compare` warn on mismatch, so "a baseline taken on the same code" is enforced, not hoped for.
2. `routing_ok`/`invariant_ok` inspect `calls[0]` only and no middleware runs, so a parallel response like `[search_vault, delegate-delete]` passes. Add an invariant over all calls (needed for R2).
3. Only 3 vault cases exist; add cases for the new `read_vault_note` arguments before R3 changes the schema.

Anything that changes a prompt, a tool list/schema or a model must pass `compare` against a baseline taken on the same code (a new tool or a schema change counts, so R1.1 and R3 both run it). Changes that touch neither (R4) are gated by their own offline tests.

## Build order

### 1. R3 vault search (smarter, faster, cheaper). Build first.

Why first: the largest measured gain, additive, and its gate is mostly free. It touches `vault_search.py`/`obsidian_tools.py`, but naming new arguments or `list_vault_notes` in the prompt edits uncommitted `supervisor.py` (lines ~498, 516-517, 1717), so land the retrieval internals first and the prompt line after the user commits.

- Heading-aware chunks; BM25 plus dense with RRF (BM25 weighted x2); chunk embeddings cached by content hash (13 s for the whole vault, once).
- **Union with today's results** (substring path kept for course codes; old dense hits still returned), so nothing that works today is lost.
- `read_vault_note(title, query=None, section=None)` (keep today's `title` parameter; any path handling is confined to the vault, no traversal): whole note up to a cap; above the cap return the best chunks plus neighbours and say how much remains and how to fetch it. It must never silently hide content. Set the cap below the 3.1k-token mean tool output or the cost saving does not materialise (today's 200 KB `_MAX_READ_BYTES` already hard-errors above that).
- Background model preload at backend start (removes the 140 s cold load and the 9.2 s search seen in traces).
- Same treatment for `conversation_search.py`.
- Optional, separate small change: read-only `list_vault_notes(folder, tag)`, named in the supervisor prompt and the Langfuse prompt sync. Unmeasured need; build only if the user says they ask counting or listing questions.
- **Gate (offline, no spend, plus one stubbed `compare` because the `read_vault_note` schema changes):** commit the recall benchmark script (currently in the session scratchpad; seeded; skip when the private vault is absent). On the 824 keyword-style queries R@5 must stay at or above the hybrid-x2 number (0.82). That is a deliberate trade: BM25 alone scores 0.98 on keyword-style and dense 0.84 on paraphrases, and hybrid gives up some of each to stay robust to both query styles. Revisit the fusion weights if keyword-style recall matters more; regression test that every hit the old `search_vault` returned on those queries is still returned; a test for the cap message. The paraphrase file is private-derived and stays out of git.
- Prompt edits (if `list_vault_notes`): re-run `scripts/sync_prompts_to_langfuse.py`, then the stubbed gate.

### 2. R1.1 workflow runner in code (faster, cheaper)

- **Blocked on:** the user committing their uncommitted `assistant/supervisor.py` edits. Do not mix.
- After `propose_workflow` is approved, loop over the approved steps in code, reusing `_prior_specialist_results_this_turn` for verbatim forwarding and the approved-vs-executed audit; stop on first failure or decline.
- Removes N-1 supervisor calls per N-step workflow. **Small prize at today's usage:** `traces.sqlite` has 2 bundled plans in 10 days (one 15-step), about 1% of spend; do it for the faithfulness gain (no re-typing of values) and for future workflow use, not for the saving. Needs a prompt line naming the new tool, so it also runs the stubbed gate.
- **Replay hazard:** on `/resume` LangGraph re-runs the whole tool function, so an `interrupt()` at step k inside a code loop would re-run steps 1 to k-1. Persist each completed step's result (e.g. `workflow_store`) and skip done steps on replay; `_prior_specialist_results_this_turn` reads `InjectedState` messages and cannot be reused unchanged inside one tool.
- **Gate:** offline tests with stubbed specialists asserting identical call order, arguments and stop behaviour against the supervisor-driven path; stubbed gate; then the two Phase 25 chains live (needs the user's macOS Automation clicks, an existing open item).

### 3. R2 guarded parallel reads (faster)

- `parallel_tool_calls` true plus a model-call middleware using an **allowlist**: only pure local reads (`read_vault_note`, `search_vault`, `backstage_look`, `stage_status`) may share a response with other calls; any other tool (every delegation including `research_agent`, every gate tool, anything that can interrupt) keeps only the first call, and the matching `tool_use` blocks are removed.
- Also touches `supervisor.py`; sequence it after item 2.
- **Gate:** unit test that a gated call in a multi-call response executes alone and the rest are re-issued next turn; equal results for pure reads; stubbed gate (the setting changes model behaviour, and today's gate cannot see a mixed response until gap 2 is closed).

### 4. R4 Stage speculative verify (faster, lossless)

- Start `helper.verify` in parallel with `brain.classify` on a plan's last step; discard unless the decision is `done`.
- **Blocked on:** the user's uncommitted `stage/` edits (`loop.ts`, `driver.ts`, `server.ts`, others). Do not touch until committed.
- **Gate:** replay of recorded task sets asserting identical outcomes.

### 5. R1.2 and R1.3 (provisional, do not start before 1 to 3 are measured)

- R1.2 express lane: begin with `open_app` and `open_url_in_brave` only (ungated, single-call, no domain know-how). Reach is about 10 of 34 mac_control delegations (29%), 3 to 5 s each; the other 15 were gated `calendar_create_event` from one test day. `run_claude_code` is NOT moved (ungated, `$HOME`-rooted, a named security exception). Name each in the supervisor and specialist prompts. Gate: stubbed eval extended to >=50 prompts for those tools, supervisor-direct vs specialist path, LLM-judged arguments.
- R1.3 relay mode: opt-in per call by the supervisor. Gate: pairwise judge on >=30 stratified replies, voice channel checked separately.
- If R1.1 and R2 already capture most of the saving, skip these. Re-measure first.

### Dropped by the user (2026-10-23): Opus 5.5 fast mode

The user chose to stay on Sonnet 5.5 (Opus is too expensive). Kept below only as the record of what was measured.

#### Record (not planned)

- Measured: supervisor turn 1.9 s vs 3.0 s total (~1.1 s; runs made hours apart), routing 100% on the stubbed set. Costs 4x Sonnet; supervisor-only is roughly +$15 or more per 10 days against ~$10.1 total spend today (Langfuse has no per-agent split; the supervisor is probably over half of calls).
- **It fails the gate today:** it swapped Apple/Google calendar action names in the confirmation gate on 3 of 3 cases at both repeats. This matters: `GATED_ACTIONS[action]` maps the name to the specialist (`supervisor.py:266-272`), so a swapped name runs the approval through the wrong specialist. Names are already listed in the tool description and prompt (`:962`, `:575`) alphabetically, with no Apple-versus-Google mapping. Two untested options: add that mapping to the gate tool's description (edits uncommitted `supervisor.py`), or keep the gate call on Sonnet. Either needs a new `compare` run before adoption.
- Requires `extra_body={"speed": "fast"}`, has separate rate limits, and a fallback to standard misses the cache. `usage.speed` was never read back.

## Dropped, with the number that killed each

| idea | why |
|---|---|
| Strict tool use globally | +15 s grammar compile on first call and after any tool change, +0.7 s warm, 0 invalid-argument errors to fix; shape guarantees do not cover gate ordering |
| Local constrained router | the cheaper-model test already skipped a gate; Stage's `jev` is the right version of this idea |
| Haiku for supervisor or specialists | skipped a confirmation gate; no gain beyond the 2.6 s floor |
| Lower effort | 0.5 s per supervisor call, no gain on specialists |
| 1h cache TTL, keep-alive pings, Batch API | net loss or under $1.60 per 10 days |
| Context editing | invalidates cached prefixes, drops information |
| Stage fail-fast | 4 of 35 long tasks were rescued by the extra re-plan; breaks the bar |

## Risks and what could make this plan wrong

1. **Projected savings.** R1/R2/R4 numbers come from measured components, not an end-to-end run. After each item merges, re-run the Langfuse and `traces.sqlite` queries used in the report and record the actual change in STEPS.md.
2. **Gate sensitivity.** Baseline has only 2 repeats on the final case set; the margins were set from baseline-vs-baseline noise on an earlier set. If a gate run fails by a hair, rerun once before concluding.
3. **Gate coverage.** 80 decision cases do not cover every prompt the real supervisor sees. The gate catches regressions in what it covers; it does not certify equal intelligence overall.
4. **Prompt sync.** Any prompt edit has no effect until `scripts/sync_prompts_to_langfuse.py` runs, and the gate must run against the synced prompt.
5. **Uncommitted work.** `supervisor.py`, `compaction.py`, `stage.py` and the `stage/` tree have the user's uncommitted edits. Items 2 to 4 wait on commits.
6. **Retrieval benchmark bias.** Keyword-style queries favour BM25 by construction; the paraphrase set is 50 queries (about +/-0.07). The direction is solid, the size is not.
7. **Unknowns that could change priorities:** whether the user asks counting or listing questions of the vault; real-use Stage failure rate; compaction and memory-review quality.

## Cost of executing this plan

Gate fixes, item 1 recall tests, item 4: no paid calls. Each prompt, tool-schema or model change needs a fresh same-code baseline plus the candidate (about $1 each at 2 repeats; `GateConfig` wants 3 or more repeats for power, so ~$1.50), and R1.2 needs ~50 new cases. Realistic total for items 1 to 3 plus a fast-mode retest: $8 to $12, not $2 to $5.
