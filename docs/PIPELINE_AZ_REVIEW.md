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

### FIXED (two designs): per-turn write cap had silently narrowed to per-delegation

`write_tools.MAX_WRITES_PER_TURN` (3) counts this turn's gated writes.
Under agents-as-tools each delegation's state is a fresh isolated list, so
a compound turn delegating to life_admin_agent twice could execute up to
2x the cap. supervisor.py's docstring disclosed this as a known
limitation. It is a confirmation-fatigue/runaway guard gap, **not** a
gate bypass — every write still interrupts for confirmation.

**Design A (929745b, branch `pipeline-az-improvements`, independently
reviewed):** delegation ToolMessages carry a supervisor-written count of
executed gated writes; the next delegation sums this turn's markers and
threads the total into the specialist's state. No new storage. Two
residual undercount edges: mid-turn compaction can delete the markers,
and a delegation that executes writes and THEN errors leaves no
ToolMessage to stamp. Both fail open toward one extra
individually-confirmed write, never toward skipping a confirmation.

**Design B (this follow-up branch, `pipeline-write-cap-durable`):** a
durable counter (`write_cap_store.py`, sync sqlite, idempotency_store
precedent) keyed (thread_id, turn_id, tool_call_id). Every gated write
records itself at execution time; the cap check reads the counter.
`call_specialist` threads a stable per-turn id (genuine-human-message id,
else content hash + position — identical user texts in different turns
cannot collide, test-pinned) into `GatedAgentState.write_cap_turn_id`.
Bare invocations fall back to the legacy message scan.

What B solves over A: compaction-proof, error-after-execution-proof.
What B adds as obligations (each tested or reasoned, not "by
construction"):

- **Corrupt/unavailable DB:** cap check falls back to the legacy scan and
  the gate still interrupts (test); recording is swallowed (best-effort,
  same failure direction as A).
- **Check-then-record race:** deliberately not atomic. Safe because
  same-turn gated writes are structurally sequential — life_admin's model
  has parallel_tool_calls disabled and GuardedParallelReads trims any
  multi-call response to one non-read call (invariant test-pinned).
- **Crash between side effect and record:** residual undercount window
  (fails open toward one extra confirmed write). Recording BEFORE
  execution was considered and rejected: a crash or refusal mid-window
  would then consume cap without a write and could refuse an
  already-approved write on resume.
- **Resume/retry double-count:** INSERT OR IGNORE on tool_call_id, stable
  across any LangGraph replay (test).
- **Privacy:** the store persists thread/turn/call ids, tool name,
  timestamp only — no payload, recipients, or content (schema test).

Both designs preserve every confirmation gate. Which to merge is the
user's call: A is smaller and stateless; B closes A's two residual
edges at the cost of one more sqlite store.

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

## Dependency reproducibility finding (fresh installs broken)

`requirements.txt` pins `langchain-mcp-adapters==0.3.0` but leaves `mcp`
unpinned. Probed on 2026-10-25 (uv venv, Python 3.12): adapters 0.3.0's
`sessions.py` imports `streamable_http_client` (present only in mcp >=
2.0.0) while its `callbacks.py` imports `RequestContext` from
`mcp.shared.context` (present only in mcp 1.x; removed by 2.0.0). Every
version probed — mcp 1.8.1, 1.9.2, 1.9.4, 1.10.1, 1.11.0, 1.12.4,
1.13.0, 1.14.1, 1.15.0, 1.16.0, 1.17.0, 1.18.0-1.22.0 (newest 1.x), and
2.0.0-2.3.0 (newest overall) — failed one of the two imports; no probed
version satisfied both. adapters 0.3.2 has the same conflict (and adds
mcp<2). Consequence: a fresh `pip install -r requirements.txt` today
resolves mcp 2.3.0 and the backend crashes at import. Sources:
https://pypi.org/pypi/langchain-mcp-adapters/json (0.3.0 released
2026-06-10, `Requires-Dist: mcp>=1.9.2`, no upper bound),
https://pypi.org/pypi/mcp/json (2.3.0 current). Reproduce:

    uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python \
        langchain-mcp-adapters==0.3.0 mcp==2.3.0
    .venv/bin/python -c "from langchain_mcp_adapters.client import MultiServerMCPClient"
    # ImportError: cannot import name 'RequestContext' from 'mcp.shared.context'

The user's working install presumably predates this (resolved when an
mcp version existed that satisfied both, or differs from the pin).
Recommended: pin BOTH packages in requirements.txt to the versions on
the working machine (`pip show mcp langchain-mcp-adapters`); not changed
on this branch because the correct values depend on that environment.
This sandbox ran the suite with adapters 0.3.0 + mcp 1.22.0 + a local
two-line alias shim (uncommitted).

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
