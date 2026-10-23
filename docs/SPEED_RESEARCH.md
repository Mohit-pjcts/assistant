# Making Oni faster, smarter and cheaper: research findings (2026-10-22)

> Update 2026-10-23: the user chose to stay on Sonnet 5.5, so every Opus option below is dropped. R3 is built (STEPS 206).

Priority order asked for: faster > smarter > cheaper. The only code added is the offline-tested eval harness `evals/stubbed/` (STEPS 203); no Oni behaviour was changed. The decision is in [SPEED_PLAN.md](SPEED_PLAN.md); this file holds the measurements.

**Inputs.** The `launduadhyan` course folder (InnoWing Chatbot Challenge: `submission_repo/bot/*`, `tune.py`, `experiment_log.csv`, slides), Oni's own telemetry (`traces.sqlite` 719 rows, `activity_log.sqlite`, Langfuse 771 generations over 10 days, Stage `runs/*/steps.jsonl` 159 tasks), Anthropic's current docs, and five throwaway benchmarks (scripts in the session scratchpad, no side effects: tools were never executed, the vault was only read).

## 1. Where the time actually goes

**Per-model-call floor.** Langfuse: mean generation 5.0 s, time to first token 2.6 s (52% of the latency is before the first token), decode ~140 tok/s, 4.2 calls per trace (median 2). Every extra LLM hop costs about 2.5 to 5 s and re-reads a 15 to 60k-token context.

**Delegations (traces.sqlite, 10 days).**

| specialist | calls | mean s | inner model turns | model s | tool s | share with <=1 tool call |
|---|---|---|---|---|---|---|
| mac_control_agent | 34 | 7.0 | 1.7 | 5.0 | 1.1 | 91% |
| coding_agent | 42 | 33.3 | 1.3 | 7.2 | 23.4 | 98% |
| life_admin_agent | 14 | 25.8 | 2.8 | 20.1 | 0.5 | 7% |
| backstage (Stage) | 108 | 27.4 | n/a | n/a | n/a | n/a |

A mac_control delegation is 5 s of model time wrapped around a 0.1 to 0.5 s tool (`calendar_create_event`, `open_url_in_brave`, `open_app`). A coding_agent delegation spends ~7 s (22% of 33 s) in a Sonnet wrapper whose only job is to call `run_claude_code`. After each delegation the supervisor makes one more full call (TTFT 2.6 s plus ~340 output tokens) mostly to restate what the specialist said.

**Stage (159 tasks, dev testing included).** Done tasks: median 9.3 s, 3 steps. Per step: observe 0.40 s, decide 0.49 s, act 46 ms median on the fast lane but 1.3 to 1.5 s on the Cua synthetic/foreground channels. `verify` is 213 calls at 1.66 s (11% of all task seconds), `plan` 307 calls (8%). Failed tasks used 70% of all task time (2,291 s of 3,270 s): 38 `stalled` tasks averaged 36.6 s each. Caveat: many of those failures were me and Oni testing Save/Open panels, so the real-use share is lower.

**Money (Langfuse, 771 generations, 10 days).** *Correction to the first draft of this report, which used $3/$15 per M tokens.* Published prices ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)): Sonnet 5.5 is $2 in / $10 out, 5m cache write $2.50, cache read $0.10 (0.05x); Opus 5.5 is $4 / $20; Haiku 5.5 is $0.10 / $0.50. Recomputed: **about $10.1 in 10 days (~$1.0/day)** (Langfuse's own sum is $10.40), of which cache writes 59%, output 25%, cache reads 15%, fresh input under 1%. *A verifier pass found the first recompute of this section read only one of the two usage-key spellings Langfuse returns (138 of 771 generations use `cache_creation_input_tokens`), which understated spend by 18%; this is the corrected figure.* 70 cold-cache calls (9% of calls) cost $3.36 (33% of spend) and account for ~53% of the 2.39M written tokens; 29 turns arrived 5 to 60 minutes after the previous one and rebuilt ~23k tokens each. `read_vault_note` returns a mean 10.8k characters (max 54k) straight into the supervisor's context. At <$1/day, cost is the weakest of the three levers; speed and correctness are where the gains are.

**Where the time inside a model call goes (631 generations with timing).** 52% of generation time is before the first token and 48% is decoding (~140 tok/s). The first-token wait is a floor of about 2.6 s that does not grow with output length, and barely with input size: median 1.8 s at 0 to 10k input tokens, 2.2 s at 10 to 20k, 1.8 s at 20 to 35k, 2.7 s at 35 to 60k. Cold cache writes add only ~0.3 s (3.0 s vs 2.7 s). Calls with <400 output tokens (78% of all calls) take 3 to 4 s of which 2.6 s is the floor. So **only fewer sequential calls and fewer output tokens save real time; shrinking context, swapping models, or lowering effort do not** (this is also what the benchmarks in section 2 and 6 show).

## 2. Measured and rejected (so nobody re-tries them)

| idea | measurement | verdict |
|---|---|---|
| Lower `effort` / `thinking: between_tools` on the supervisor | first-token 1.9 s to 1.5 s, total 3.1 s to 2.5 s at `low`; routing 18/20 vs 18/20 (same two misses) | gain ~0.5 s per call, not worth the intelligence risk alone |
| Same on specialists (15 prompts) | total 2.2 s in every configuration; first tool matched the baseline in 14 to 15 of 15, tool plus arguments in 11 to 13 of 15 at lower effort | **no speed gain: leave at default.** (The argument mismatches are not evidence of drift: a later rerun showed Sonnet agrees with itself on only 19 to 20 of 25, see section 5.) |
| Haiku 5.5 as the supervisor | 2.1 to 2.5 s vs 3.1 s, but it sent "delete my 2pm appointment" straight to `life_admin_agent` instead of the confirmation tool | rejected: it skipped a gate |
| 1-hour prompt cache TTL everywhere | 1h writes cost $4 vs $2.50 per M on all ~2.39M written tokens (+$3.59) to save at most about $1.60 on the 29 idle-gap rebuilds (an estimate) | net loss at this usage. Only worth it for the stable prefix, which `AnthropicPromptCachingMiddleware(ttl=...)` cannot do (whole request) |
| Tool Search tool | supervisor has 25 tools | below the size where it pays |
| Programmatic tool calling | collapses N tool round-trips into one code run | real, but needs the code-execution container and `allowed_callers`; parallel tool calls give most of the win here for far less |

Docs that back the effort result: effort is `output_config.effort`, the default on Sonnet 5.5 is `high`, and changing it between requests invalidates the cache ([effort](https://platform.claude.com/docs/en/build-with-claude/effort), [prompting Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5)).

## 3. Recommendations, ranked

### R1. Remove LLM hops that carry no decision (faster, cheaper; biggest)

Three independent changes, in order of confidence:

1. **Run an approved workflow in code.** After `propose_workflow` is approved, the steps are fixed (action names plus concrete summaries) and the supervisor's only job between steps is to route step i to its owning specialist. A `run_approved_workflow` tool can loop over the steps itself, reuse the existing verbatim forwarding (`_prior_specialist_results_this_turn`) and the approved-vs-executed audit, and stop on the first failure or decline exactly as the prompt says. **Hazard:** on `/resume` LangGraph replays the whole tool function, so an `interrupt()` at step k inside a code loop would re-run steps 1 to k-1 (only email and iMessage have `idempotency_store`). The runner must persist per-step results (e.g. in `workflow_store`) and skip completed steps on replay. The existing helpers read `InjectedState` messages, so they cannot be reused unchanged inside one tool. That removes N-1 supervisor calls (each ~5 s and about half a cent) from every N-step workflow, and makes the chain *more* faithful to Phase 25's goal (no re-typing of values).
2. **Express lane for leaf tools.** Give the supervisor the ungated, single-call tools directly (`open_url_in_brave`, `open_app`, `calendar_list_events`, `oni_calendar_list`, board list/add), keep the specialist for anything multi-step or gated. The supervisor prompt must name each one (the standing routing-blindness lesson). Expected: 3 to 5 s of model time off each such call. Reach is smaller than first stated: 15 of the 34 mac_control delegations were gated `calendar_create_event` (all from one test day), so `open_app`/`open_url_in_brave` cover about 10 of 34 (29%). `run_claude_code` is deliberately NOT moved to the supervisor: it is ungated, rooted at `$HOME` and a named exception to the security model, so it stays behind `coding_agent`. Gated tools (`calendar_create_event`) stay behind their own `interrupt()` either way; moving them is a separate decision.
3. **Relay mode.** Add `relay: bool` to the delegation tools. When true and the specialist succeeded, a middleware returns the specialist's text as the final AIMessage without calling the model, the same synthetic-AIMessage trick `RepeatedToolFailureCircuitBreaker` already uses. The supervisor opts in per call, so multi-step turns still get a real synthesis call. Check against the voice channel (short spoken replies) before enabling there.

### R2. Parallel read-only tool calls, guarded (faster)

`NoParallelSpecialistCalls` exists because `/resume` relays only the first pending interrupt. Real chains such as `search_vault`, then 7x `read_vault_note`, then writes pay a model round trip per read. Set `parallel_tool_calls` back to true and add a middleware `awrap_model_call` that, when the response holds more than one tool call and any of them is a delegation or a gate tool, keeps only the first (and removes the matching `tool_use` block). Use an allowlist, not a blacklist: only pure local reads (`read_vault_note`, `search_vault`, `backstage_look`, `stage_status`) may run alongside other calls; anything else (every delegation, `research_agent` included, and any tool that can interrupt) keeps only the first call. The allowed reads then fan out through ToolNode's `asyncio.gather`. [Parallel tool use docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use); LLMCompiler reports up to 3.7x latency from this pattern, with the planner and final answer limiting the gain ([paper](https://arxiv.org/abs/2312.04511)). Needs a test that proves a truncated gated call is re-issued next turn.

### R3. Vault search from the course folder (smarter, faster, cheaper)

`search_vault` today: whole-query substring (a multi-word question almost never matches), then dense search over each note's title plus first 500 characters only, re-reading and re-hashing every note on every call, with a lazy ~140 s cold / 0.3 s warm model load (a 9.2 s search is in the traces).

What the challenge repo does that Oni does not: heading-aware chunks, BM25 plus dense fused with Reciprocal Rank Fusion (no score calibration), neighbouring chunks added to the best hits, alias normalisation applied to documents and queries, a metadata filter for counting questions, and a cheap recall-only tuning loop (`tune.py`: measure whether the fact is in the retrieved chunks, no chat call, pick the cheapest setting that ties the best).

Benchmark on the real vault (454 notes, 7,982 chunks, notes read only):

| system | keyword-style, n=824: R@1 / R@5 | paraphrase (Haiku-written), n=50: R@1 / R@5 | ms/query |
|---|---|---|---|
| current | 0.04 / 0.10 | 0.18 / 0.30 | 54 |
| BM25 chunks | 0.89 / 0.98 | 0.58 / 0.80 | 5 |
| dense chunks | 0.22 / 0.48 | 0.50 / 0.84 | 5 |
| hybrid RRF 1:1 | 0.48 / 0.74 | 0.62 / 0.80 | 12 |
| hybrid RRF, BM25 x2 | 0.54 / 0.82 | 0.64 / 0.80 | 12 |

Read this honestly: the queries target text beyond the first 500 characters, which is exactly where the current index is blind, and the keyword-style set favours BM25 by construction; the paraphrase set is only 50 queries (about +/-0.07). The direction is not in doubt, the size is. Build chunk embeddings once (13 s for the whole vault, cache by content hash as today), keep the exact-substring path for course codes, add a `query`/`section` argument to `read_vault_note` that returns the best chunks plus neighbours instead of the whole note (mean 10.8k chars, max 54k), and pre-load the model in a background thread at backend start. `conversation_search.py` has the same dense-only shape and gets the same fix.

### R4. Stage engine (faster)

- **Speculative verify.** When the plan is on its last step, start `helper.verify` in parallel with `brain.classify`; if the decision is `done` the verdict is already in hand (saves at most the classify time: decide has a median of 0.44 s over 817 steps, so about 0.45 s, ~5% of a median 9.3 s task. `verify`'s own 1.66 s is its full mean, and it is only hidden on the final step), otherwise discard it (one extra ~$0.0001 jev call). No change to what counts as done.
- **Fail fast: demoted, not recommended unless you accept a small loss.** Stalled tasks average 36.6 s. But the run history shows what the second re-plan buys: of 35 tasks that reached 5+ helper calls, 4 still finished `done` (11%), and the other 31 averaged about 41 s before failing. Cutting them off would trade ~20 s on 31 failures for 4 lost rescues, which breaks the "nothing reduces intelligence" bar. Many of those tasks were development runs, so the real rate may differ. If wanted later, cut only when the screen is provably unchanged.
- Cua `synthetic`/`foreground` actions (1.3 to 1.8 s) are the remaining slow channel; web pages through Cua's DevTools path (as `webform.ts` already does) are the lever, not the loop.

### R5. Context hygiene instead of cache tricks (cheaper)

Cold-start cost scales with conversation size, so shrink the conversation: cap `read_vault_note` output (R3 does this), age out old window pictures (STEPS 199 flagged this), and consider a lower compaction trigger (`TRIGGER_FRACTION = 0.6` of 50k now). Measure with the Langfuse query used here rather than assuming.

### R6. Process: borrow the challenge's measurement loop

**Built (2026-10-23): `evals/stubbed/`, run with `python -m evals.stubbed`; see STEPS.md 203.** 80 decision cases (47 supervisor, 33 specialist) and 10 reply cases, every tool stubbed, a Haiku judge with a known-answer self-test, and `compare` as a pass/fail gate (zero tolerance on gating invariants, margins on routing, arguments and reply quality, pairwise reply judging). The text below is the original proposal.

`experiment_log.csv` plus one change at a time plus a cheap proxy metric is why that project's scores moved 40/48 to 65/71 reliably. Oni has `evals/supervisor_eval.py` (routing and gates) but it executes real specialists and writes to the real board. A tool-stubbed variant like the benchmarks above (supervisor first turn only, tools never run) costs about $0.10 per config and should gate R1 to R3.

## 4. Constrained decoding (asked for specifically)

**What it is on Claude.** Grammar-constrained sampling, GA on Sonnet 5.5 in two forms: `output_config.format` (final text matches a JSON schema) and `strict: true` on a tool (tool arguments match its schema, tool name always valid). The docs state the guarantee is syntactic only, the grammar applies to the output and not the thinking, a first-use schema pays a compile delay (grammars are cached 24 h), the tool set or schema changing invalidates that cache, changing `output_config.format` invalidates the prompt cache, and there are limits (20 strict tools, 24 optional and 16 union parameters per request; no numeric or length constraints; incompatible with citations). The docs claim no speed gain ([structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use)). The engines in the literature (XGrammar, llguidance, Outlines) are for models you host: roughly 40 to 50 us per token of CPU overhead ([XGrammar](https://arxiv.org/pdf/2411.15100), [XGrammar-2 for agents](https://arxiv.org/pdf/2601.04426)), up to 37.5% higher latency at batch 512 in one study.

**Measured on Oni's real supervisor (25 tools, real system prompt, tools never executed, 12 prompts x 2 rounds, `scratchpad/strict_bench.py`).**

| | baseline | strict on 20 of 25 tools |
|---|---|---|
| first request (grammar compile) | 2.9 s to first token, 5.2 s total | **18.1 s to first token, 20.1 s total** |
| warm | 2.0 s, 4.6 s | 3.0 s, 5.3 s (about +0.7 s, one noisy run) |
| first tool chosen, same as baseline | n/a | 12 / 12 |
| schema-invalid arguments | 0 | 0 |

- Strict **is slower, not faster**: a ~15 s compile on the first call after 24 h idle or whenever a tool is added, and about +0.7 s warm.
- It would only add value where arguments are actually invalid, and Oni's schemas are almost all one `str` parameter (25 tools: 0 optional params, 1 union). In 10 days of traces, 5 of ~700 tool calls (0.7%) failed argument validation, all "`content: Field required`" on `write_vault_note`/`update_vault_note` (4) and `render_ui` (1, the max_tokens-truncation incident of STEPS 122, where the call arrives as `{}`). Strict mode does not fix truncation (the docs list `max_tokens` as a failure case), and I could not tell from the traces whether the four vault calls were omissions or truncations.
- It cannot express Oni's real invariants. It guarantees shape, not that `request_gated_action_confirmation` is called before a send; those live in code (`interrupt()` in the wrapper tools) and stay there.
- The "format tax" literature does not apply here, because the grammar excludes thinking and the evidence says recent closed models show near-zero degradation when they reason first ([format tax study](https://arxiv.org/pdf/2604.03616); [Thinking Before Constraining](https://arxiv.org/abs/2601.07525) applies to self-hosted token-level decoding). If anything is ever constrained, leave thinking on.
- Local constrained models (a small model served on the M4 Pro with XGrammar/Outlines) could classify in ~0.2 s instead of the API's 2.6 s floor, but the one cheaper-model test I ran (Haiku 5.5 as supervisor) already skipped a confirmation gate, and a smaller local model would do worse. Stage's `jev` is already this idea done properly: a calibrated classifier with a confidence gate that escalates instead of guessing.

**Verdict.** Do not turn on strict mode globally or build a local constrained router. A narrow, optional use: `strict: true` on only the 3 or 4 large-content tools (`write_vault_note`, `update_vault_note`, `render_form`). That fixes at most the ~0.5% omission case, a small compile hit (untested for a 3-tool set) applies, and nothing is lost. I would not prioritise it.

## 5. Other leads, with what was measured

| lead | evidence | verdict |
|---|---|---|
| **Opus 5.5 fast mode** (`speed: "fast"`, Opus only, up to 2.5x output tokens/s, same model, "no change to intelligence", [docs](https://platform.claude.com/docs/en/build-with-claude/fast-mode)) | supervisor first turn, 20 prompts: Sonnet 5.5 2.7 s total, routing 18/20; Opus 5.5 standard 3.5 s, **20/20**; Opus 5.5 fast **1.9 s, 19/20**, first token 1.0 s. Specialists (25 prompts): 1.7 s vs 2.5 s | faster, and routed as well as or better than Sonnet on the routing set, **but it failed the stubbed gate**: it swapped Apple/Google calendar action names in the confirmation gate on 3 of 3 cases at every repeat (see section 6). The supervisor-only gain is 3.0 s to 1.9 s per turn (~1.1 s; the specialist-inclusive 3.1 to 1.75 s figure is blended), and the two runs were made hours apart, so latency is confounded. Costs 4x Sonnet ($8/$40; cache reads $0.40): all calls on Opus fast would be ~$40 per 10 days (vs $10.1); supervisor-only is +3x the supervisor's spend, roughly +$15 or more (Langfuse has no per-agent split; the supervisor is probably over half of calls). Not "cheaper". Needs `extra_body={"speed": "fast"}` (the installed SDK rejects it as a kwarg), has its own 429 limits, and fallback to standard misses the cache. A user call, not a free win |
| Haiku 5.5 / lower effort for specialists | 25 prompts x 3 Sonnet reruns: Sonnet agrees with *itself* on first tool + arguments only 19 to 20 of 25; Haiku 18 to 19, Opus 17 to 19. First tool matches in 23/25 for every config. Time 1.9 to 2.2 s vs 2.5 s | exact-match cannot separate them at n=25, and the time gain is only the 2.6 s floor. Not worth the unprovable risk |
| [Speculative Actions](https://arxiv.org/pdf/2510.04371) (ICLR 2026): a fast model guesses the next action and runs it in parallel, kept only if it matches | lossless by construction; up to 55% prediction accuracy and up to 20% latency in the paper | the Stage speculative `verify` in R4 is this idea; extend only to read-only tools |
| [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) (server-side tool-result clearing) | clears old tool results, but changes the prefix, so it invalidates cached prefixes; no accuracy data found | rejected: cache writes are 53% of spend and clearing causes more of them; it also removes information the model may need |
| Keep-alive pings to avoid cold rebuilds | a rebuild is $0.06; a ping every 4.5 min is $0.003; saving is at most $1.60 per 10 days and pings during idle hours cost more than they save | not worth it |
| Programmatic tool calling, Tool Search | see section 2 | unchanged |

## 6. Intelligence-preservation gate (the bar: nothing may get dumber)

Each recommendation is re-vetted against "does any decision, argument or answer change?" and given a gate that must pass before it merges. Items that cannot pass are dropped.

| item | can it reduce intelligence? | gate before merging | status |
|---|---|---|---|
| R1.1 workflow runner in code | no decisions move; same steps, same verbatim forwarding, same stop-on-failure. The one change: the supervisor no longer adapts a later step mid-workflow, which `propose_workflow` already forbids (action names fixed at approval) | tests with stubbed specialists: identical call order, arguments and stop behaviour vs the supervisor-driven path; then the two Phase 25 chains live | keep |
| R1.2 express lane (supervisor calls leaf tools directly) | **yes, possible**: specialist prompts carry domain know-how (calendar names, date handling), and 5 more tools make the supervisor's choice harder | tool-stubbed eval, at least 50 prompts, supervisor-direct vs specialist-path: same tool and equivalent arguments (LLM-judge on free text, since exact match is noisy at 19 to 20/25 even Sonnet vs Sonnet). Start with only `open_app` and `open_url_in_brave` | keep, **provisional** |
| R1.3 relay mode | **yes, possible**: loses the supervisor's synthesis (context, memory, tone) | opt-in per call by the supervisor, so a multi-step turn still gets a real synthesis; A/B judge on 30+ stratified replies; voice channel checked separately | keep, **provisional** |
| R2 parallel read-only calls | no, if gated calls are never executed in parallel | unit test: a response with a gated call or delegation plus other calls executes only the first and the rest are re-issued; equal results for pure reads | keep |
| R3 vault search | can only add, not remove: return the union of today's substring+dense hits and the new BM25+dense chunks. `read_vault_note` must not hide content: whole note up to a cap, and above it say how much remains and how to fetch it | recall benchmark (0.10 to 0.98 keyword-style, 0.30 to 0.80 paraphrase at R@5, already measured) plus a regression test that every old hit is still returned | keep |
| R4 speculative verify | no: result discarded unless it matches the real decision | replay a recorded task set, assert identical outcomes | keep |
| R4 fail fast | **yes**: 4 of 35 long tasks were rescued | none passes the bar | **dropped** (see R4) |
| R5 context hygiene | capping `read_vault_note` is covered by R3; ageing out window pictures and lower compaction trigger can lose information | only with an eval that asks questions about earlier turns | partly dropped; R3 portion kept |
| R6 stubbed eval | enables all gates above | `evals/stubbed/` | **built** (STEPS 203) |
| Opus 5.5 fast for the supervisor | **yes, observed**: swapped Apple/Google calendar action names in the confirmation gate; `GATED_ACTIONS[action]` maps the name to the specialist, so a swapped name approves via the wrong specialist | must pass the stubbed gate; fix options untested (a mapping in the gate tool's description, or keep the gate call on Sonnet); cost about +$15 or more per 10 days is the user's call | **fails the gate today**; optional, not cheaper |
| strict tool use, local constrained router, Haiku supervisor/specialists, effort tuning, 1h TTL, context editing | strict: no speed gain; Haiku skipped a gate; effort and model swaps save nothing beyond the 2.6 s floor | rejected above | **dropped** |

## 7. Smarter and cheaper: focused pass (2026-10-23, no paid model calls)

Everything here is read from existing data (Langfuse generations, `traces.sqlite`, Stage runs, the vault's front matter), the code, the course labs and two doc/web checks. Priority is still faster > smarter > cheaper.

### Smarter: where Oni is actually wrong

| lead | evidence | verdict |
|---|---|---|
| **Vault retrieval (R3)** | recall@5 0.10 to 0.98 on keyword-style queries and 0.30 to 0.80 on paraphrases (section 3). The course's Lab 1 principle applies: retrieval success is the ceiling on answer quality, so measure it first | the largest measured "smarter" gain; additive (union with today's results), so nothing that works now is lost. Same fix for `conversation_search.py` |
| **A list/count tool for the vault** | the vault has 454 notes, 453 with front matter, folders (People 162, Semester 3 127, ...) and tags (university 256, people 166, ...). `search_vault` returns the nearest few, so "how many people notes do I have" or "list my Semester 3 notes" cannot be answered, exactly the Lab 5 counting failure | read-only, additive `list_vault_notes(folder, tag)` tool, named in the supervisor prompt. Unmeasured: I have no evidence yet that you ask such questions, so treat it as a capability gap, not a known failure |
| **Stage reliability** | 75 of 159 tasks failed (47%); Brave 52% done (n=94), WhatsApp 47% (n=38), Calculator 90% (n=10). The largest cluster is `stalled: three actions in a row changed nothing` (21 tasks), mostly typing into a message box or choosing a web dropdown. Many were development runs of exactly those hard cases, so the real-use rate is unknown | the biggest correctness gap in Oni, but it is active development (uncommitted `stage/` edits), so I did not touch it. A lead, not a recommendation: web content is where the DOM path (`form_*`) beats pixels and the accessibility tree |
| **Handoff quality** | specialists see only the supervisor's instruction plus the compaction summary and recalled facts. Of 91 delegations, 6 ended by asking a question; 4 are optional follow-up offers and 2 are real: Apple Calendar create asked "which calendar" (it also did so in the eval until the case named one) and a photo export | little headroom. A one-line default calendar name in the mac_control prompt is the only concrete fix, and it must pass the stubbed gate. Anthropic's multi-agent write-up stresses detailed delegation (objective, output format, tool guidance, boundaries) and parallel tool calls, and an LLM-judge style eval; I read it only through secondary summaries, so check the [original](https://www.anthropic.com/engineering/multi-agent-research-system) before quoting |
| Opus 5.5 | routed 20/20 vs 18/20, but the two Sonnet "misses" were my case-authoring errors, and Opus fast swaps Apple/Google action names | not a smartness gain; fails the gate |

Not studied because it cannot be judged cheaply: compaction quality (does the summary keep what a later turn needs) and memory-review quality. Both need paired judged conversations; if you want them, that is the next paid experiment.

### Cheaper: the honest size of the prize

Recomputed on the same 771 generations at published prices ($10.09 over 10 days; the 4 Haiku calls priced at Haiku rates):

| call type | calls | cost | share |
|---|---|---|---|
| cold start (prefix rebuilt) | 70 | $3.36 | 33% |
| small append (0.5 to 5k tokens written) | 331 | $3.41 | 34% |
| warm (<=500 written) | 330 | $1.72 | 17% |
| big append (>5k written, prefix read) | 40 | $1.60 | 16% |

- **No cache bug found.** 18 of 39 cold calls came within 5 minutes of an earlier call in the same session, which looked like a cache miss. Their size (7 to 9k tokens), same-trace timing and the supervisor having a different prefix show these are mostly specialists' first calls (a new, smaller prefix), not broken caching. This is inferred from sizes, not confirmed per call.
- **Biggest context inflator is `read_vault_note`:** 126k of the supervisor's 215k tool-output tokens (59%), mean 3.1k, max 15k. Writing those once and re-reading them is worth roughly $0.4 per 10 days, so the chunked read in R3 saves about 5% of spend. Real, small.
- **Removing a supervisor hop** costs about 0.7 cent (30k cached tokens at $0.10/M plus ~340 output tokens at $10/M). R1.1 only fires on bundled workflows, and `traces.sqlite` shows exactly 2 `propose_workflow` plans in 10 days (one 15-step calendar chain, about 14 hops, roughly $0.10, ~1% of spend). The saving from R1.1 alone is therefore small at current usage; R1.2/R1.3/R2 are what remove hops from ordinary turns, and their count is unmeasured. A projection, no figure claimed.
- **Batch API (50% off)** does not fit: the only background model work is Haiku (compaction, memory review), $0.016 in 10 days.
- **The only big lever is output (31%, mostly thinking), and cutting it is an intelligence risk**, so I recommend leaving it.
- **Ceiling:** without touching thinking, everything above is worth roughly 10 to 15% of about $1.0/day. Cost is the right thing to deprioritise.

## 8. What this research did not establish

- Latencies are single runs of first turns without conversation history; real turns have longer contexts.
- No end-to-end before/after yet: every number in R1 to R4 is a projection from measured components.
- Strict mode and fast mode were each tested on one run of 12 to 25 prompts; differences below ~0.5 s are noise. I did not confirm `usage.speed == "fast"` in the response; the 1.9 s vs 3.5 s timing against Opus standard is the evidence it was applied.
- Exact tool-and-argument matching is too noisy to certify equal intelligence (Sonnet vs Sonnet is only 19 to 20 of 25). The stubbed gate (STEPS 203/204) adds an LLM judge, 80 decision cases and invariants, but its coverage is limited: it checks the first tool call only, has 3 vault cases, and its run files carry no prompt/tool fingerprint (see SPEED_PLAN.md).
- Whether the four `content: Field required` vault failures were truncation or omission is unknown.
- Stage figures include development runs.
- Course repo: I read `answer.py`, `router.py`, `retrieval.py`, `config.py`, `llm.py`, `prompts.py`, `tune.py`, the experiment log and slide text, skimmed `engine.py`, the five lab notebooks' instructions and the header of `build/images.py`. I did not read the code cells of the notebooks, the rest of `build/images.py` (vision pipeline) or the September variant's 787-line `main.py`.
