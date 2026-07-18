# Spike: distributed cross-process trace nesting (before the v3 migration)

**For:** Mohit
**Why this exists:** Your Langfuse v2 work is solid. But before you migrate to
v3 and call it a reference for Nova, there's one thing your project can't
currently demonstrate — and it happens to be the *hardest* part of Nova's own
migration. This spike closes that gap.

---

## The gap, in one paragraph

Your assistant runs the supervisor and all four sub-agents **in one process**.
Trace nesting is therefore automatic and free: every node shares the same
in-memory `CallbackHandler` (v2) / OTEL context (v3), so the research agent's
spans nest under the supervisor turn without any work from you. That's why
your traces look clean.

Nova is **distributed**: the superagent calls each functional agent (FA) over
**HTTP, in a separate process/container**. In-memory trace context does not
cross a process boundary — the FA process starts with an empty context and
opens a **brand-new root trace**, so the FA's logs show up detached instead of
nested under the superagent. Nova compensates with hand-rolled v2 plumbing
(`trace_id` + `parent_observation_id` passed in the request body, then
`CallbackHandler(stateful_client=...)` on the far side). v3 replaces all of
that with OTEL `traceparent` header propagation — and **nobody has proven the
v3 version works for Nova's shape yet.** You can be the one who proves it.

## What you're building

Turn **one** sub-agent (`research_agent`) into a separate HTTP service, so your
project reproduces Nova's superagent→FA hop in miniature. Then show trace
nesting break, fix it the v2 way (mirroring Nova exactly), and finally fix it
the v3 way (OTEL) as part of your migration. Minimal changes — this is a spike,
not a rearchitecture.

## Guardrails

- **Only touch `research_agent`.** Leave the other three sub-agents in-process.
- **Don't change the security model, memory, or the confirmation gate.**
  research is read-only (web search) — no gated actions involved, deliberately.
- Keep the new service tiny. Reuse `build_research_agent()` as-is; don't
  reimplement the agent.
- This can live on a branch and be reverted. It's a demonstrator.

---

## Steps

### Step 0 — Baseline: prove the current (working) nesting
Run a research query through the normal graph with Langfuse configured. In the
Langfuse UI, confirm you see **one** trace (`agent-turn`) with the research
agent's `model` spans nested under the supervisor. Screenshot it.
**This is your "single-process nesting is free" reference.**

### Step 1 — Stand up `research_agent` as a separate process
- New file `assistant/fa_service.py`: a minimal FastAPI app (model it on
  `assistant/server.py`). One endpoint, e.g. `POST /research`, that:
  - accepts the current message list (JSON),
  - builds the research agent via `build_research_agent()` (from
    `sub_agents.py`),
  - runs it (`ainvoke`) and returns the resulting messages.
- Give the FA its **own** Langfuse identity: call
  `observability.configure_client("research-fa")` at startup so its traces are
  attributable and it builds its own handler.
- Run it as its own uvicorn process on a different port
  (e.g. `uvicorn assistant.fa_service:app --port 8100`). It is now a separate
  process, exactly like a Nova FA.

### Step 2 — Replace the in-process node with an HTTP proxy
- In `supervisor.py`'s `build_graph()`, line 367:
  `builder.add_node("research_agent", build_research_agent())`
  → swap `build_research_agent()` for a new **proxy node** (call it
  `research_agent_proxy`) that:
  - takes the outer graph's current `messages`,
  - makes an HTTP `POST` to the FA service from Step 1 (httpx),
  - merges the returned messages back into state,
  - routes onward exactly as before (to `route_after_specialist`).
- Everything else about the graph — the `transfer_to_research_agent` handoff
  tool, the loop-back — stays identical. Only *where the research agent runs*
  changes.

### Step 3 — Observe the breakage (the "before")
Run the same query from Step 0. In the Langfuse UI you should now see **two
disconnected traces**:
1. the supervisor `agent-turn`, which now stops at the HTTP call, and
2. a separate root trace from the `research-fa` process.

Screenshot this. **This is Nova's exact problem, reproduced.** Write a
sentence on *why* (the process boundary — in-memory context didn't cross the
HTTP call).

### Step 4 — Fix nesting the v2 way (mirror Nova)
This is a faithful copy of what Nova does today. Two halves:

**Caller side (proxy node):** get the current trace id + the current
observation id for the handoff, and pass them in the POST body as
`langfuse_trace_id` and `langfuse_parent_observation_id`.
> Note: grabbing the current observation id from a shared v2 `CallbackHandler`
> is the fiddly bit — read it out of the handler's internal `.runs` dict
> (keyed by run id; take the current run's span and use its `.id`).

**FA side (`fa_service.py`):** if those fields are present, rebuild the parent
and nest under it:
```python
trace = client.trace(id=langfuse_trace_id)
parent_span = trace.span(parent_observation_id=langfuse_parent_observation_id, name="research-fa")
config["callbacks"] = [CallbackHandler(stateful_client=parent_span)]
```

**Verify:** one trace tree again, research-fa spans nested under the
supervisor's handoff span. Screenshot. **This is your v2 "after."** You have
now reproduced Nova's current implementation *and* its fix.

### Step 5 — Fix it the v3 way (this is the actual migration payoff)
When you do the v3 migration, replace the manual plumbing with OTEL context
propagation:
- **Caller:** inject the W3C `traceparent` header onto the HTTP request
  (v3/OTEL gives you the current context; serialize it into the header).
- **FA:** extract `traceparent` on the way in so its spans automatically
  continue the same trace — no `parent_observation_id`, no `.runs`, no
  `stateful_client`.
- **Delete** the Step-4 v2 plumbing. That deletion *is* the migration diff
  worth showing.

**Verify:** the same correctly-nested tree as Step 4, but achieved via OTEL,
with the v2 mechanisms gone. Screenshot side-by-side with Step 4.

---

## Acceptance criteria (the go-ahead bar)

Show all of these, live in the Langfuse UI (screenshots):
1. **v2:** research-fa spans correctly nested under the supervisor turn across
   the process boundary (Step 4).
2. **v3:** the same correct nesting via OTEL `traceparent`, with
   `.runs`/`parent_observation_id`/`stateful_client` code deleted (Step 5).
3. **Streaming survives the hop:** hitting your `/chat/stop` mid-run leaves the
   distributed span cleanly *ended*, not stuck "in progress." (Maps to Nova's
   streaming `agent_stream.py`.)
4. **Token/cost across the hop:** the research-fa's thinking-tier output tokens
   show up **non-zero** in v3 (the usage bug you already found — now proven to
   survive a process boundary).

## How this maps to Nova (so you know why each step matters)

| Your spike                                          | Nova equivalent                                     |
| --------------------------------------------------- | --------------------------------------------------- |
| supervisor → HTTP → research-fa                     | superagent → HTTP → functional agent                |
| Step 4 caller `.runs` read                          | how the superagent grabs its parent observation id  |
| Step 4 FA `trace()/span()/stateful_client`          | how a functional agent nests under the parent trace |
| `langfuse_trace_id`/`parent_observation_id` in body | Nova's FA protocol fields                           |
| Step 5 OTEL `traceparent`                           | the v3 target Nova hasn't proven yet                |
