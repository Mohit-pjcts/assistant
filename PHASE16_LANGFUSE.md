# Phase 16 — Langfuse v2 Integration, then Migration to v3

Status: **Part A (v2) — all three Langfuse pillars implemented and
live-verified. Part B (v3) not started.**
Started 2026-07-16. This document is a standalone narrative of everything done
so far; the canonical, chronological record is `STEPS.md` (entries 79–82) and
`PLAN.md`'s Phase 16 section — this file exists to make that record easy to
read in one pass, including for sharing outside this repo.

## Objective

Wire Langfuse into this project on v2, verify it against real usage, then
migrate to v3 — so the migration itself is a real, demonstrable artifact
(the user's boss is on v2, evaluating v3). Explicitly additive: LangSmith
(already in this project since Phase 3) is untouched and keeps powering the
dashboard's `/cost` panel. Langfuse is a second, parallel observability
platform, not a replacement.

## Scope: all three of Langfuse's pillars are now implemented

Langfuse is three products in one platform: **observability/tracing**,
**prompt management**, and **evaluations**. Work started with tracing only;
the other two were flagged as explicitly out of scope (STEPS.md 81), then
implemented at the user's direction (STEPS.md 82) before moving to Part B.

- **Observability/tracing** — done first, described below under "Where the
  integration lives" through "What the audit found."
- **Prompt management** — done, described below under "Prompt Management."
  6 system/summary prompts now live in Langfuse with mandatory local
  fallbacks; one prompt (`memory_extraction.py`'s `_EXTRACTION_PROMPT`) was
  deliberately excluded for security reasons, not forgotten.
- **Evaluations** — done, described below under "Evaluations." Confirmation-
  gate approve/decline outcomes are logged as Langfuse scores — real
  implicit feedback from this project's own usage, not a synthetic dataset.

## Where the integration lives

One new module — `assistant/observability.py` — wired into exactly one
existing function: `assistant/agent.py`'s `make_thread_config(thread_id)`.
That function already builds the LangGraph invocation config for every real
graph call in the project:

- `assistant/main.py` — the CLI chat loop
- `assistant/voice_daemon.py` — the always-on voice daemon's per-turn pipeline
- `assistant/server.py` — the dashboard backend's `/chat`/`/resume` SSE stream

Because all three already call `make_thread_config()` to build their
`config` dict before invoking the graph, merging Langfuse's tracing config in
at that one point means all three clients get tracing for free — no
per-call-site code needed.

```python
# assistant/agent.py
def make_thread_config(thread_id: str) -> dict[str, Any]:
    config = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}
    config.update(observability.langfuse_run_config(thread_id))
    return config
```

`langfuse_run_config()` returns `{}` when Langfuse isn't configured
(`LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` unset), so `config.update({})`
is a clean no-op — a missing or bad Langfuse config can never break chat on
any client, same defensive posture `server.py` already uses for LangSmith.

## The real blocker: Langfuse v2 doesn't run here out of the box

Before writing any integration code, `langfuse>=2.0,<3.0` was installed and
its actual API checked against reality (this project's own "verify installed
reality before coding against it" discipline). That surfaced a genuine,
hard problem:

- Langfuse v2's real final release is `2.60.10` (September 2025) — **the v2
  line is EOL**, no releases since.
- `from langfuse.callback import CallbackHandler` raised a bare
  `ModuleNotFoundError` against this project's real installed
  `langchain==1.3.12`. v2's LangChain integration hard-imports three legacy
  module paths — `langchain.callbacks.base`, `langchain.schema.agent`,
  `langchain.schema.document` — that LangChain's 1.0 rewrite deleted.
- This is a known, unresolved upstream bug
  ([langfuse/langfuse#9758](https://github.com/langfuse/langfuse/issues/9758)),
  never going to be patched in v2 specifically because v2 stopped receiving
  releases before LangChain 1.0 existed.
- The obvious fix — LangChain's own official backport package,
  `langchain-classic` — was tried and confirmed **not** to work: it installs
  as a separate namespace (`langchain_classic.*`), not a monkeypatch of the
  old `langchain.*` paths.
- Also checked at this point, since it changes the whole premise: Langfuse
  itself has already moved past v3 too. The SDK was rewritten again into v4
  in March 2026; v3's last release was v3.15.0 in May 2026.

This was surfaced to the user directly rather than silently worked around or
silently abandoned. The explicit direction back: still do v2 first, then v3,
as originally scoped — find a real way to make it work, not a way around it.

## The resolution: a verified compatibility shim, not a downgrade or a mock

The three legacy paths v2 needs were themselves, in pre-1.0 LangChain, just
thin re-export shims over `langchain_core` classes — that's exactly the layer
1.0 deleted, not the underlying classes. `observability.py`'s
`_install_langchain_legacy_shim()` restores those three paths in
`sys.modules`, pointing at the real, still-present `langchain_core`
equivalents:

| Legacy path (deleted in 1.0) | Restored as a re-export of |
|---|---|
| `langchain.callbacks.base.BaseCallbackHandler` | `langchain_core.callbacks.base.BaseCallbackHandler` |
| `langchain.schema.agent.{AgentAction,AgentFinish}` | `langchain_core.agents.{AgentAction,AgentFinish}` |
| `langchain.schema.document.Document` | `langchain_core.documents.Document` |

This is not a behavior-changing hack — it restores the exact relationship
LangChain itself shipped for years, using the identical underlying objects
v2 was actually built and tested against. Verified live: with the shim in
place, `langfuse.callback.CallbackHandler` imports and constructs cleanly
against the real installed `langchain==1.3.12`/`langchain-core==1.4.9`.

The shim is explicitly scoped **Part-A-only**. Langfuse v3's
`langfuse.langchain.CallbackHandler` was separately confirmed to import
cleanly against this project's LangChain 1.x with no shim needed at all —
so Part B's migration deletes `_install_langchain_legacy_shim()` and its
call site entirely. That deletion is itself part of the migration diff
worth showing.

## Design: one handler per process, not one per turn

Constructing a `CallbackHandler` allocates a background flush thread (its
constructor exposes `threads`/`flush_at`/`flush_interval` params). Two of
the three clients (`voice_daemon.py`, `server.py`) are long-lived processes
handling many turns — rebuilding the handler on every turn would leak a
thread per turn.

Instead: a single lazily-built handler, cached as a module-level singleton
in `observability.py`. Session identity (which thread a turn belongs to)
is set **per call**, not at construction, via `metadata={"langfuse_session_id":
thread_id}` — verified by reading the real installed source
(`langfuse/callback/langchain.py`) that this metadata key overrides the
handler's own internal `session_id` state on every invocation. So one shared
handler safely serves every thread across the whole process lifetime.

Trace **name** and **tags**, by contrast, turned out to be constructor-bound
in v2 — there is no per-call metadata override for them, unlike session_id.
Without an explicit name, a trace falls back to the triggering LangChain
class's own internal name (e.g. `CompiledStateGraph`), which fails Langfuse's
own "choose good names" guidance (verb-first, stable, not a framework
internal). Since each of the three clients is already its own dedicated,
long-lived, single-purpose process, this was a natural fit rather than a
limitation: `observability.configure_client(name)` is called once at startup
by each entry point —

- `main.py` → `configure_client("cli")` (inside `main()`, not module scope —
  `voice_daemon.py` imports a helper from `main.py` and must not inherit a
  "cli" tag as a side effect of that import)
- `voice_daemon.py` → `configure_client("voice")`
- `server.py` → `configure_client("dashboard")`

— giving every trace the same stable `trace_name="agent-turn"` (identical
operation across all three clients: one user message in, one graph run to
completion or interrupt) and a distinguishing `tags=["client:cli"]` /
`["client:voice"]` / `["client:dashboard"]`.

## Installing and using the official Langfuse skill

The user asked to install the `langfuse/skills` GitHub repo and use it. Per
this project's standing skill-vetting policy (from Phase 11 — no skill
installed without reading it first, community/third-party content gets a
real risk read), the actual raw content of `SKILL.md` and all ten
`references/*.md` files was fetched and read in full before installing
anything — not just a summarized fetch. Findings: published under the
official Langfuse GitHub org, MIT licensed, its `allowed-tools` are narrowly
scoped (`WebFetch` restricted to `langfuse.com`, `curl` restricted to
`langfuse.com` URLs, CLI access restricted to read-only actions —
`__schema`/`--help`/`list`/`get`, no `create`/`update`/`delete`), and it
explicitly instructs agents never to ask users to paste secret keys into
chat. Cleared the vetting bar — same trust category as the already-vetted
Gmail/Calendar MCP servers this project already runs. Installed to
`~/.claude/skills/langfuse/` (this project has no project-scoped
`.claude/skills/` directory; the existing `frontend-design`/`find-skills`
skills already live at the user level, so this matches that layout),
downloaded via direct file fetch for byte-for-byte fidelity.

The skill's `references/instrumentation.md` defines an audit workflow:
assess current state → verify baseline requirements → **run and self-audit
a real trace** (never skip this) → fix every gap found → repeat. That
workflow is what surfaced everything below.

## What the audit found

### 1. Trace scope for gated (confirmation-interrupt) actions — resolved, not a gap

This project's confirmation-gate pattern (`interrupt()`) means a gated
action is two separate LangGraph invocations sharing one checkpoint: a
pre-interrupt `ainvoke()`, then a post-resume `ainvoke()` after the user
approves or declines. Whether that should be one Langfuse trace or two was
an open question from earlier in this phase.

Langfuse's real best-practices doc (fetched fresh, not from memory) answers
this directly: it explicitly lists "your workflow spans multiple requests
with human-in-the-loop steps in between" as a case where **session**-level
grouping is the right model — not forcing everything into one trace. This
project's design (one shared `session_id` per thread, separate traces per
graph invocation) is exactly that pattern. Closed as confirmed-correct, not
fixed.

### 2. Trace naming and tags — fixed

Described above under "Design." Verified live against a real fetched trace:
`name: agent-turn`, `tags: ['client:cli']`, `session_id` matching the real
thread id.

### 3. `LANGFUSE_HOST` vs. `LANGFUSE_BASE_URL` — a real auth bug, fixed

Once the user added real Langfuse credentials to `.env`, `auth_check()`
failed against both US and EU cloud hosts. Root cause: the user's `.env`
used `LANGFUSE_BASE_URL` (the name the `langfuse-cli` skill's own reference
docs use for this setting) for their actual account, which is on **JP
cloud** (`https://jp.cloud.langfuse.com`) — but `observability.py` only read
`LANGFUSE_HOST` (this project's own `.env.example` name), silently falling
back to the wrong default region instead of erroring loudly. Fixed:
`_get_handler()` now accepts either env var name, `LANGFUSE_HOST` taking
precedence if both are set. Re-verified: `auth_check()` now returns `True`.

### 4. Output-token/cost tracking — confirmed broken in v2, deliberately NOT patched

A real end-to-end turn was run through the actual graph (throwaway
checkpointer DB, cleaned up after — this project's "throwaway scripts must
not pollute real state" rule) and the resulting trace fetched back via the
Langfuse Python SDK's `fetch_trace()`. Both real GENERATION observations
(a Haiku memory-extraction call, a Sonnet supervisor call) came back with
`usage.output = 0` and `usage.total = 0`, despite the calls succeeding and
`usage.input` being correct.

Root-caused by reading the real installed source
(`_parse_usage`/`_parse_usage_model` in `langfuse/callback/langchain.py`):
Anthropic's modern usage shape — which this project's calls always produce,
because extended thinking and prompt caching are unconditional, project-wide,
load-bearing decisions — includes fields v2's frozen `UpdateGenerationBody`
pydantic schema doesn't recognize. Every single generation's usage-update
call throws a validation error internally; LangChain's own callback-error
handling catches it so it never crashes a turn, it just silently loses that
one data point.

This was **not patched**. Unlike the import-path shim (which restores
something LangChain itself used to ship, using the same underlying objects),
fixing this would mean monkeypatching Langfuse's own internal validation
logic — a materially different, much less principled kind of intervention,
and not something this project does (see `CLAUDE.md`'s "no
backwards-compatibility hacks" convention). Instead: documented clearly, in
code and here, as a confirmed, live-verified v2 limitation.

**Confirmed fixed in v3 — tested empirically, not assumed (STEPS.md 81).**
The venv was temporarily upgraded to `langfuse>=3.0,<4.0` (Part A's shipped
code, which targets v2, was reverted back afterward and re-confirmed
passing) and two real `ChatAnthropic(thinking={"type": "adaptive"})` calls
were run through v3's `CallbackHandler` against the real account:

1. A trivial question, thinking likely skipped — `usage_metadata`:
   `input_tokens: 30, output_tokens: 3, total_tokens: 33`, plus
   Anthropic's modern cache-related fields. No callback errors. The fetched
   trace showed `usage_details={'input': 30, 'output': 3, 'total': 33}` and
   real non-zero `cost_details` — correct.
2. A genuine multi-step reasoning question that visibly triggered thinking
   content — `usage_metadata` showed `output_tokens: 493`. No callback
   errors. The fetched trace showed `usage_details={'input': 92, 'output':
   493, 'total': 585}` — an exact match, correct.

Both are the same failure mode that broke every generation in v2's Part A
testing. v3 handles it cleanly in both the trivial and thinking-heavy case,
with zero validation errors. **This is real, concrete evidence for the
migration demo** — a bug that's 100%-reproducible on every real turn in v2
is simply gone on v3, verified against the same account.

### Masking sensitive data — considered, deliberately left as a no-op

The audit's baseline checklist includes "is sensitive data masked?" — real
Gmail/Calendar/long-term-memory content flows through this graph, and
`CallbackHandler` supports a `mask` constructor parameter. Not implemented:
LangSmith tracing has shipped full, unmasked conversation content to its
cloud since this project's early phases with no masking layer ever built or
discussed. Building one only for Langfuse would be an arbitrary asymmetry
between the two tracing backends, not a genuine security improvement.
Flagged here for the record; revisit only if the user decides trace-content
sensitivity needs addressing project-wide, across both backends.

## Live verification: tracing

- A real turn through the real graph, real Anthropic API calls, tagged
  `client:cli`, on a throwaway checkpointer DB (cleaned up afterward).
- The resulting trace fetched back from the real Langfuse account and
  inspected directly — not assumed to be correct from the code alone.
  - **Not** via `npx langfuse-cli`: the auto-mode permission classifier
    correctly declined running an unreviewed third-party npm package with
    real secret keys exported into its environment. The already-installed,
    already-read Langfuse Python SDK (`Langfuse(...).fetch_trace(...)`) did
    the exact same job without that exposure.
- Confirmed correct: trace name (`agent-turn`), session_id (matches thread
  id), tags (`['client:cli']`), and full automatic span hierarchy across the
  real multi-agent graph (`supervisor`, `recall_memory`, `extract_memory`,
  `compact_history`, sub-agent `model` nodes) — zero extra code needed for
  hierarchy, exactly as the best-practices doc predicts for framework
  integrations.

**Not yet done:**

- The voice and dashboard call sites haven't individually been driven live
  for TRACING (only the CLI path was exercised directly there). The wiring
  is identical and client-agnostic through `make_thread_config()`, so this
  is expected to work, but hasn't itself been watched land in the Langfuse
  UI yet. (Evaluations scoring below IS wired into all three call sites,
  but was also only live-tested via the CLI-equivalent path.)

## Prompt Management

Migrated 6 system/summary prompts into Langfuse (label `"production"`),
each with its original text kept as a MANDATORY local fallback — Langfuse
is an override source here, never the sole source of truth. A missing,
unreachable, or misconfigured Langfuse account can never prevent an agent
from building: every call site keeps its exact pre-migration prompt text.

| Local constant | Langfuse prompt name | Module |
|---|---|---|
| `SUPERVISOR_SYSTEM_PROMPT_FALLBACK` | `supervisor-system-prompt` | `supervisor.py` |
| `CODING_SYSTEM_PROMPT_FALLBACK` | `coding-agent-system-prompt` | `sub_agents.py` |
| `RESEARCH_SYSTEM_PROMPT_FALLBACK` | `research-agent-system-prompt` | `sub_agents.py` |
| `LIFE_ADMIN_SYSTEM_PROMPT_FALLBACK` | `life-admin-agent-system-prompt` | `sub_agents.py` |
| `MAC_CONTROL_SYSTEM_PROMPT_FALLBACK` | `mac-control-agent-system-prompt` | `sub_agents.py` |
| `_SUMMARY_PROMPT_FALLBACK` | `compaction-summary-prompt` | `compaction.py` (templated: `{{transcript}}`) |

### Deliberately excluded: `memory_extraction.py`'s `_EXTRACTION_PROMPT`

Every prompt migrated above is a normal agent system prompt whose security
properties already depend on the model *choosing* to follow instructions —
a "soft" trust boundary, not categorically different from, say, a
compromised git-write-access scenario touching `sub_agents.py` directly.
The memory-extraction prompt is different in kind: Phase 7 Part B's
source-restriction guarantee is explicitly **structural**, built specifically
NOT to depend on the model being told the right thing, because prompt-level
defenses were judged insufficient for that one channel (a durable memory
write that outlives a single turn — see `CLAUDE.md`'s Load-bearing
decisions). Making that prompt's text fetchable from a third-party account
would add a new prompt-supply-chain trust dependency to the one place in
this project explicitly designed not to need it. `CLAUDE.md`'s "do not
weaken without discussion" standing note on that module applies — it stays
a local-only constant, unmigrated, on purpose, documented in
`assistant/prompts.py`'s own module docstring, not silently dropped.

### Design (`assistant/prompts.py`, new)

```python
def get_prompt(name: str, fallback: str, /, **variables: str) -> str:
    client = observability.get_client()
    if client is None:
        return _compile_local(fallback, **variables)
    try:
        prompt = client.get_prompt(name, label="production", fallback=fallback)
        return prompt.compile(**variables)
    except Exception:
        return _compile_local(fallback, **variables)
```

- Reuses `observability.get_client()` — the SAME lazily-built `Langfuse`
  client the `CallbackHandler` already owns (same credentials, no second
  client/connection).
- Uses the SDK's own native `fallback=` kwarg on `get_prompt()` (verified
  against the real installed source: this returns a real, `.compile()`-able
  prompt client wrapping the fallback text on any fetch error — not just a
  bare string) rather than relying only on a hand-rolled try/except.
- `_compile_local()` mirrors Langfuse's own simple `{{var}}` substitution
  (no conditionals/loops, matching Langfuse's own documented templating
  limits) so the fallback path behaves identically to a real hosted prompt
  whether or not a client exists at all.

### A real bug, caught by the test suite itself

The original signature was `get_prompt(name, fallback, **variables)`. A
prompt containing a `{{name}}` template variable could never compile:
`variables["name"]` collided with the function's own `name` parameter,
raising `TypeError: get_prompt() got multiple values for argument 'name'`.
Caught by `tests/test_prompts.py`'s own coverage before it could bite a
real prompt. Fixed by making `name`/`fallback` (and `_compile_local`'s
`template`) **positional-only** (Python's `/` syntax) — none of this
project's current prompts happen to use those exact words as variables, but
the API shouldn't silently break the day one does.

### Migration script

`scripts/sync_prompts_to_langfuse.py` — manual, repeatable, NOT run
automatically at app startup. Imports each module's `*_FALLBACK` constant
and pushes it via `create_prompt(..., labels=["production"])`.
`create_prompt()` creates a new version each time, and `"production"`
always points at the latest push — so re-running this after a genuine local
prompt-text change is exactly how you push the update.

```
python scripts/sync_prompts_to_langfuse.py
```

### Live verification: prompt management

- **Before the sync:** all 5 non-templated prompts correctly fell back to
  local text — real 404s from Langfuse (visible as the SDK's own logged
  warnings), caught and handled, never a crash.
- **After the sync (real account):** all 5 fetch successfully with ZERO
  fallback triggered, and the resolved text is **byte-for-byte identical**
  to the original local fallback — confirmed via direct equality checks,
  not eyeballed. Nothing corrupted in the push/fetch/compile round trip.
- The templated `compaction-summary-prompt` was separately verified:
  fetches from Langfuse, `{{transcript}}` correctly substituted with real
  content, no leftover placeholder in the output.

## Evaluations

Confirmation-gate approve/decline outcomes are logged as Langfuse
**scores** — real implicit feedback from this project's own usage pattern
(an approved or declined write action), rather than a synthetic dataset or
experiment.

### Design (`observability.score_gate_outcome()`, new)

Fired as `asyncio.create_task(...)` at all three resume points — never
awaited inline anywhere, since scoring is best-effort enrichment and must
never add latency to a confirm/decline round trip a user is actively
waiting on, nor ever raise into the caller:

- `main.py`'s CLI interrupt loop, right after `Command(resume=approved)`.
- `voice_daemon.py`'s `_process_turn`, both branches — the normal
  spoken-confirmation path and the auto-decline-by-voice-restriction path
  (Phase 7 Part B's memory-write gate, which never asks by voice).
- `server.py`'s `/resume` endpoint, via a new `_stream_turn(...,
  gate_outcome=(approved, action))` parameter — scored only once the resume
  fully resolves (the "message" terminal frame, not a further chained
  "interrupt").

The score itself: `name="gate_outcome"`, `data_type="BOOLEAN"`,
`value=int(approved)`, `comment=<the gated tool's action name>` (e.g.
`"send_test_notification"`, or `write_tools.py`'s `"send_email"`/
`"create_calendar_event"`/etc. — read from the interrupt payload's own
`action` field, which every gated tool in this project already sets).

### A real concurrency/attribution bug, found live and fixed

A gated action is **two traces sharing one session** (pre-interrupt, then
the resume — confirmed as the intended Langfuse pattern in Finding 1 of the
tracing audit above). The first version of `score_gate_outcome()` queried
`trace.list(session_id=..., order_by="timestamp.desc")[0]`, trusting the
ordering.

**Live-tested using the existing `send_test_notification` dummy gated
tool** (no real side effects — perfect for this) and caught it red-handed:
the score attached to the WRONG (older, pre-interrupt) trace. Root cause:
Langfuse indexes traces asynchronously and **not necessarily in creation
order** — at query time, only the older trace had finished indexing, making
it the only, and therefore wrongly "most recent," result.

Fixed with a `from_timestamp` filter: any trace older than a cutoff is
structurally excluded regardless of indexing order, so an incomplete result
set can no longer be misattributed the way "the only trace found so far"
was.

A first fix attempt used a tight 10-second cutoff and immediately surfaced
a **second** real, live-caught bug: it undershot and matched nothing at
all, even though the correct trace existed — a real, measured gap between
local wall-clock time and Langfuse's own recorded trace timestamp was wider
than 10 seconds. Rather than chase an exact number (which is really
measuring client/server clock alignment, not the actual property the
filter needs), the cutoff was widened to a generous 2 minutes — since this
only ever runs as a detached background task, a wider window costs nothing
user-facing, and 2 minutes still reliably separates "this gate's own resume
trace" from a genuinely distinct, much older interaction in the same
long-lived session. The retry budget was also increased (3×1.5s → 9×2s,
~18s total) after the first live test showed real indexing lag exceeding
the original budget.

### Live verification: evaluations

A real gated call through the real graph (the dummy notification tool),
scored, then fetched back and inspected directly:

- `gate_outcome = 1.0` (`BOOLEAN`) ✓
- `comment = 'send_test_notification'` ✓
- Attached to the **correct** (newer, resume) trace ✓
- The older, pre-interrupt trace in the same session carries **no score** ✓

## Test coverage

- `tests/test_observability.py` — 9 tests, no mocking (real `CallbackHandler`
  construction with throwaway keys; construction doesn't authenticate
  synchronously, verified by hand, so this is safe without a live account):
  1. The legacy-path shim lets v2's `CallbackHandler` import at all.
  2. `langfuse_run_config()` is a clean no-op without keys configured.
  3. `langfuse_run_config()` builds a real handler and merges session
     metadata when keys are configured.
  4. `configure_client()` correctly sets `trace_name`/`tags` on the handler.
  5. `get_client()` returns `None` without keys configured.
  6. `get_client()` reuses the handler's own client (no second connection).
  7. `score_gate_outcome()` is a clean no-op without a client — no
     exception, no hang.
  8. `make_thread_config()`'s pre-existing `configurable` contract survives
     the merge unchanged.
  9. `make_thread_config()` correctly merges in the Langfuse keys when
     configured.
- `tests/test_prompts.py` — 5 tests, no mocking:
  1–3. `_compile_local()`'s `{{var}}` substitution: basic case, no-variable
     no-op, and an unmatched placeholder left untouched (mirrors Langfuse's
     own behavior).
  4. `get_prompt()` returns the fallback, unchanged, with no client
     configured.
  5. `get_prompt()` compiles the fallback's own `{{var}}`s correctly when no
     client exists.

The real round-trip checks (a prompt actually fetched from Langfuse
matching its local text byte-for-byte; a score actually landing on the
correct trace) are live, by-hand verifications against the real account —
this project's no-mocking convention doesn't extend to standing up prompt/
score fixtures in a real cloud account inside a test run — recorded above
and in STEPS.md, not reproduced as automated tests.

Full project suite: **174/174 passing**. `ruff check`: clean.

## Files touched in Part A so far

- `assistant/observability.py` — the shim, the singleton handler,
  `configure_client()`, `langfuse_run_config()`, `get_client()`,
  `score_gate_outcome()`.
- `assistant/prompts.py` — new. `get_prompt()`, `_compile_local()`.
- `assistant/agent.py` — `make_thread_config()` merges in the Langfuse
  config.
- `assistant/supervisor.py`, `assistant/sub_agents.py` — the 5 agent system
  prompts each route through `prompts.get_prompt()`, original text
  preserved as `*_FALLBACK`.
- `assistant/compaction.py` — the summary prompt routes through
  `prompts.get_prompt()` with `{{transcript}}` substitution.
- `assistant/main.py`, `assistant/voice_daemon.py`, `assistant/server.py` —
  each calls `observability.configure_client(...)` at startup, and each
  fires `observability.score_gate_outcome(...)` after a resume resolves.
- `scripts/sync_prompts_to_langfuse.py` — new. The manual, repeatable
  prompt-migration script.
- `requirements.txt`, `pyproject.toml` — `langfuse>=2.0,<3.0` added.
- `.env.example` — `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/
  `LANGFUSE_HOST` documented, including the `LANGFUSE_BASE_URL` alias.
- `tests/test_observability.py` — 9 tests. `tests/test_prompts.py` — new,
  5 tests.
- `~/.claude/skills/langfuse/` — the installed skill (user-level, outside
  this repo).

## What's next (Part B — not started)

1. ~~Verify the real v3 API before writing anything~~ — **partially done
   already (STEPS.md 81), ahead of Part B formally starting.** Confirmed
   live: `from langfuse.langchain import CallbackHandler` imports with no
   shim needed; the real pattern is a global client (`from langfuse import
   get_client; langfuse = get_client()`) plus a no-constructor-arg
   `CallbackHandler()`, not v2's keys-in-the-constructor style. Also found,
   as a side effect of the usage-tracking test: `metadata=
   {"langfuse_session_id": ...}` — the same per-call key v2 uses — worked
   correctly to set session_id in v3 too (confirmed via a fetched trace
   showing the right `session_id`), suggesting the migration may be
   simpler than expected on that front. Still to verify before Part B's
   own migration: `trace_name`/`tags` equivalents in v3 (v2's were
   constructor-bound; v3's session/user pattern differing from v2's could
   mean naming/tags work differently too — not yet checked), and how
   `auth_check()`/credentials are supplied (the test above relied on
   `get_client()` picking up env vars implicitly, not explicit
   public_key/secret_key args).
2. Migrate `observability.py`: delete the legacy-shim function and its call
   site; rebuild the handler-construction logic against the verified v3
   shape above.
3. Deliberately demonstrate the OTEL auto-instrumentation double-tracing
   problem (turn it on, observe duplicate spans against calls already
   traced via the LangChain callback handler, then fix it with
   `blocked_instrumentation_scopes`) — this is the actual "shows how the
   migration plays out" artifact for the demo.
4. Handle the streaming-callback/cancellation risk on `server.py`'s SSE
   path (`/chat/stop` cancels an in-flight `astream_events()` call; verify
   this leaves a Langfuse v3 span cleanly ended rather than stuck
   "in progress").
5. Re-run the same three real-call-site smoke tests as Part A, on v3.
6. ~~Check — does v3 fix the output-token/cost tracking bug found in Part
   A?~~ — **DONE (STEPS.md 81): yes, confirmed.** Two real calls (trivial
   and thinking-heavy) through v3's `CallbackHandler` against the real
   account both recorded correct `usage.output`/`usage.total`/real
   `cost_details`, with zero validation errors — see the "Output-token/
   cost tracking" section above for the full detail. Concrete, verified
   evidence for the migration demo.
7. Review the v2→v3 diff itself as the deliverable: should read as a small,
   legible change (helped by the fact that Part A's shim already isolates
   all v2-specific code inside `observability.py`), not a rewrite.

Full step-by-step detail for both parts lives in `PLAN.md`'s Phase 16
section; the chronological build log is `STEPS.md` entries 79–82.
