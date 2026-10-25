# Pipeline A-Z review (2026-10-25, branch `pipeline-az-improvements`)

A-Z review of Oni's request-to-result pipeline — everything outside `stage/`
(which had its own A-Z on `backstage-az-improvements`). Offline only: no paid
model/API calls. Baseline: `main` @ e824e8e.

## How the pipeline actually runs today (traced in code)

1. **Entry.** `server.py` `/chat` (SSE; dashboard/CLI/phone) or a detached
   phone turn. One user message enters the outer graph with the thread's
   checkpointed history. `/resume` re-enters with `Command(resume=...)` for
   confirmation gates.
2. **compact_history** (`compaction.py`): summarizes the oldest turns once
   history crosses 30k tokens (self-imposed 50k budget), keeps a 15k-token
   tail. Must be a plain top-level node — RemoveMessage ops do not cross
   subgraph boundaries (verified by spike, STEPS.md).
3. **recall_memory** (`memory_extraction.py`): injects curated durable facts
   at most once per thread.
4. **supervisor** (`supervisor.py`, Sonnet 5.5 + adaptive thinking): a
   `create_agent` ReAct loop. Specialists are **tools**, not graph nodes —
   each delegation is a fresh, isolated `ainvoke()` of the specialist's
   checkpointer-less graph (the Phase 16 agents-as-tools rewrite). This is
   also what current LangChain guidance recommends for most cases: "Use
   single agent with middleware for most handoffs use cases… Only use
   multiple agent subgraphs when you need bespoke agent implementations"
   (docs.langchain.com/oss/python/langchain/multi-agent/handoffs, fetched
   2026-10-25). The rewrite additionally fixed the flat Langfuse trace shape
   and made the STEPS.md 48 cross-turn leakage class structurally impossible.
5. **Specialists** (`sub_agents.py`): coding / research / life_admin /
   mac_control / phone, each a `create_agent` graph with its own tool list,
   prompt caching, thinking-repair, circuit breaker, tool tracing. Results
   return as one ToolMessage; surfaces/phone-actions/executed-actions are
   collected before the isolated message list is discarded.
6. **Gates.** Side effects pause via real `interrupt()` (write_tools local
   wrappers — raw MCP write tools never reach a model; read-back before
   update/delete gates; verbatim payloads; TOCTOU note documented).
   `request_gated_action_confirmation` / `propose_workflow` pre-clear a
   CLOSED action list (GATED_ACTIONS) per delegation.
7. **Guard rails.** GuardedParallelReads (parallel pure reads only; gated/
   delegation calls execute alone because /resume relays only the first
   pending interrupt), RepeatedToolFailureCircuitBreaker (stops identical-
   failure retry storms — the 43-retry incident), workflow approved-vs-
   executed audit, idempotency store for email/iMessage replays.
8. **Exit.** Final AIMessage streams via SSE; extract happens nightly in
   batch (memory_review_agent), not per turn.

## Measured state (from the repo's own telemetry, not re-measured here)

`docs/SPEED_RESEARCH.md` (2026-10-22, 10 days of Langfuse/traces.sqlite):
per-model-call floor ~2.6 s TTFT (52% of call time); ~4.2 calls/trace;
delegation overheads (mac_control 5 s model around 0.1-0.5 s tools; coding
~7 s Sonnet wrapper around run_claude_code); spend ~$1.0/day with cache
writes 59%. R2 (parallel reads) and R3 (vault retrieval) are already built;
R1.1/R1.2/R1.3 were deliberately deferred with stated reasons — this review
does not relitigate them.

## Findings and what changed on this branch

### FIXED: per-turn write cap had silently narrowed to per-delegation

`write_tools.MAX_WRITES_PER_TURN` (3) counts this turn's gated-write
ToolMessages via InjectedState. Under agents-as-tools each delegation's
state is a fresh isolated list, so a compound turn delegating to
life_admin_agent twice could execute up to 2x the cap. supervisor.py's
docstring disclosed this as a known limitation ("revisit if this turns out
to matter"). It is a confirmation-fatigue/runaway guard gap, **not** a
gate bypass — every write still interrupts for confirmation — but the guard
now matches its documented per-turn scope again:

- `call_specialist` stamps its delegation ToolMessage with
  `_EXECUTED_GATED_WRITES_KEY` = the number of write_tools actions that
  delegation actually executed (from the existing
  `_extract_gated_action_executions`; declined/errored/no-op don't count).
- Before the next delegation, `_prior_executed_gated_writes_this_turn`
  sums this turn's markers (same genuine-human-turn boundary as the
  existing counters) and threads the total into the specialist's
  `GatedAgentState.prior_gated_writes_this_turn`.
- `write_tools._writes_so_far_this_turn` adds the offset before the
  interrupt, so a capped-out call still refuses before asking.

Robustness properties (test-backed, `tests/test_write_cap_per_turn.py`, 9
tests): the marker is written only by supervisor code from structured
extraction — specialist result text cannot forge it (test included); the
count scopes to the current genuine turn (test); parallel delegations
can't race the count because GuardedParallelReads structurally serializes
non-read calls (unchanged invariant); the full chain marker → prior → real
gated tool refusal is exercised end-to-end (test). Known, accepted edge:
if outer history is compacted mid-turn or a delegation errors AFTER
executing writes but BEFORE returning, the count can be understated —
this fails open toward one extra individually-confirmed write, never
toward skipping a confirmation. Chosen over a persisted per-turn store
(supervisor.py's earlier estimate of the fix) because the checkpointed
delegation ToolMessages already carry everything needed.

### Reviewed and left as-is (with reasons)

- **Specialist error propagation**: a crashed specialist logs OUTCOME_ERROR
  and re-raises into the ToolNode, which converts it to an error ToolMessage
  ("tool errors are data") — the supervisor sees and reports the failure.
  Correct as designed.
- **Interrupts through nested ainvoke**: load-bearing that specialists stay
  checkpointer-less; covered by existing tests and the pre-rewrite spike.
- **R1.1 workflow runner**: replay hazard on /resume is real (only email/
  iMessage have idempotency guards); the SPEED_PLAN deferral stands.
- **Compaction/memory-review quality**: flagged in SPEED_RESEARCH as "not
  studied" because judging it needs paired conversations (paid). Offline
  review found no structural defect; quality judgment remains open.

## External grounding (fetched 2026-10-25)

- docs.langchain.com/oss/python/langchain/multi-agent/handoffs —
  single-agent-with-middleware recommended for most handoffs; validates
  the agents-as-tools direction.
- docs.langchain.com/oss/python/langchain/multi-agent/subagents and
  docs.langchain.com/oss/python/langgraph/use-subgraphs — context
  engineering between agents; matches `_context_prefix_messages` /
  `_prior_specialist_results_this_turn`'s explicit-forwarding design.
- platform.claude.com/docs/en/managed-agents/multiagent-orchestration,
  anthropic.com/engineering/building-effective-agents — orchestrator-
  worker pattern; Oni's supervisor-with-tools is this pattern.

## Environment caveats for this branch's test runs

Sandbox ran Python 3.12 via uv with pinned `mcp==1.17.0` +
`pydantic==2.11.7` and a sandbox-local sitecustomize alias
(`streamable_http_client` = `streamablehttp_client`; NOT committed).
Repo's pinned `langchain-mcp-adapters==0.3.0` imports names no single
current mcp release exports together — worth a requirements pin on the
user's side. Full suite here: 1029 passed, 31 failed — the 31 are
byte-identical to the pre-change baseline on the same sandbox and are
environment-dependent (Langfuse remote prompt fetch, localhost binding,
MCP server paths, macOS-only voice); none are caused by this branch.
