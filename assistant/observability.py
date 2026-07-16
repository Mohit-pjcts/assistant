"""Phase 16 Part A: Langfuse v2 tracing for the three real graph-invocation
call sites (main.py's CLI loop, voice_daemon.py's per-turn pipeline,
server.py's SSE stream). Additive to LangSmith (Phase 3) — this does not
replace or touch server.py's /cost panel, which stays on LangSmith.

Wired in at exactly one point: `agent.make_thread_config()` merges this
module's `langfuse_run_config(thread_id)` into every invocation config it
builds, so all three call sites get tracing for free with zero per-call-site
code — consistent with CLAUDE.md's "never build invocation config dicts by
hand" rule. A single shared `CallbackHandler` is constructed once per
process (lazily, on first use) rather than once per turn: constructing it
allocates a background flush thread (see its `threads`/`flush_at`/
`flush_interval` constructor params), and voice_daemon.py/server.py are
long-lived processes handling many turns — rebuilding it per call would leak
a thread per turn. Session identity is instead set PER CALL via
`metadata={"langfuse_session_id": thread_id}` (verified against the real
installed source, `langfuse/callback/langchain.py`: `metadata.get(
"langfuse_session_id")` overrides the handler's own `self.session_id` on
every invocation) — this maps Langfuse's "session" concept onto this
project's thread_store threads for free, with no per-thread handler churn.

**Load-bearing shim, Part-A-only, deleted at the Part B (v3) migration:**
Langfuse's actual final v2 release (2.60.10, its last ever — the v2 line is
EOL, no releases since Sept 2025) hard-imports three legacy LangChain module
paths — `langchain.callbacks.base`, `langchain.schema.agent`,
`langchain.schema.document` — that this project's LangChain 1.x (the
Load-bearing "LangChain 1.x line" decision in CLAUDE.md) deleted in its 1.0
rewrite. Confirmed live: `from langfuse.callback import CallbackHandler`
raises a bare `ModuleNotFoundError` on this project's real installed
`langchain==1.3.12`; the official `langchain-classic` backport package does
NOT fix it either (it's a separate namespace, not a monkeypatch of the old
paths — confirmed by installing it and re-testing the exact same import).
This is an open, unresolved upstream bug (langfuse/langfuse#9758) that will
never be patched in v2 specifically because v2 itself stopped receiving
releases before LangChain 1.0 existed.

`_install_langchain_legacy_shim()` below restores exactly those three
paths as thin re-exports of their real `langchain_core` equivalents —
NOT stand-ins or approximations: pre-1.0 LangChain's own
`langchain.callbacks.base`/`langchain.schema.agent`/`langchain.schema.
document` were THEMSELVES already just re-export shims over these same
`langchain_core` classes, so this restores the exact relationship LangChain
shipped for years, using the identical underlying objects v2 was actually
built and tested against — not a compatibility hack that changes behavior,
just an import path 1.0 deleted. Verified live: with the shim installed,
`langfuse.callback.CallbackHandler` imports and constructs cleanly against
the real installed `langchain==1.3.12`/`langchain-core==1.4.9`.

Langfuse v3 does not need this shim (`langfuse.langchain.CallbackHandler`
imports cleanly against LangChain 1.x on its own, verified live) — Part B's
migration deletes `_install_langchain_legacy_shim()` and its call site
entirely, which is itself part of the migration diff worth showing.

**Trace naming and tags (audited against Langfuse's real, freshly-fetched
best-practices doc via the `langfuse` skill — not assumed):** grepped the
real installed source (`langfuse/callback/langchain.py`) and confirmed
`trace_name`/`tags` are constructor-bound, NOT overridable per call the way
`langfuse_session_id` is — the code falls back to the triggering LangChain
class's own name (e.g. `CompiledStateGraph`) when `trace_name` is unset,
which fails the best-practices doc's "choose good names" guidance (verb
first, stable, not the framework's internal class name). Fixed via
`configure_client(name)`: each of the three call sites is already its own
long-lived, single-purpose process (main.py = CLI only, voice_daemon.py =
voice only, server.py = dashboard only), so a per-process handler
constructed once with `trace_name="agent-turn"` (stable across all three —
they're the same fundamental operation: one user message, one graph run to
completion or interrupt) and `tags=[f"client:{name}"]` is a natural fit,
not a workaround — this is exactly the "how does X differ between our
web/api users" tagging pattern the best-practices doc describes, applied to
this project's three clients instead. Each entry point calls
`configure_client()` once at startup, before the first `make_thread_config()`
call (same ordering convention as `load_dotenv()`).

**Masking sensitive data — a deliberate no-op, not an oversight:** the
best-practices audit flagged that this graph reads real Gmail/Calendar/
long-term-memory content into context, and `CallbackHandler` supports a
`mask` constructor param for exactly this. Not implemented: LangSmith
tracing (Phase 3) has shipped full, unmasked conversation content to its
cloud since this project's early phases with no masking layer ever built or
discussed — building one only for Langfuse would be an arbitrary asymmetry
between the two tracing backends, not a genuine security improvement.
Flagged here for the record rather than silently skipped; revisit only if
the user decides trace-content sensitivity needs addressing project-wide
(both backends), not as a Langfuse-specific patch.

**Known, confirmed-live v2 limitation — NOT fixed, documented instead
(STEPS.md 80):** real end-to-end verification (a real graph turn, real
Anthropic calls, real trace fetched back from Langfuse) found that
GENERATION observations' output-token/cost data silently fails to record —
`usage.output` and `usage.total` come back `0` even though the call itself
succeeded and `usage.input` is correct. Root cause, confirmed by reading the
real installed source (`langfuse/callback/langchain.py`'s `_parse_usage*`
helpers): Anthropic's modern usage shape (via extended thinking + prompt
caching — both load-bearing, project-wide decisions, see CLAUDE.md) includes
fields v2's fixed pydantic schema for `UpdateGenerationBody` doesn't
recognize, so validation throws internally on every single generation's
usage update. This is systemic, not occasional — it will happen on every
real turn while extended thinking/caching stay enabled, which is
unconditional in this project. Deliberately NOT patched here: unlike the
import-path shim above (restoring something LangChain itself used to ship),
this would mean monkeypatching Langfuse's own internal validation logic —
a materially different, much less principled kind of intervention. Left as
a documented, confirmed v2 limitation and a concrete Part B verification
target (does v3 handle modern Anthropic usage shapes correctly?) rather than
worked around. **Update (STEPS.md 81):** confirmed live that Langfuse v3
DOES fix this — two real calls through v3's CallbackHandler (trivial and
thinking-heavy) both recorded correct output tokens/cost with zero
validation errors.

**Prompt management and evaluations (STEPS.md 82) — `get_client()` below is
the shared seam both use.** Rather than each own a separate `Langfuse`
client/connection, `assistant/prompts.py` (prompt fetching) and
`score_gate_outcome()` below (evaluations) both call `get_client()`, which
reuses the handler's own already-built `Langfuse` client — same
credentials, same lazy-singleton lifecycle, no second client.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import types
from datetime import UTC, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)


def _install_langchain_legacy_shim() -> None:
    """Idempotent: registers the three legacy module paths in sys.modules
    if they aren't already importable, so `langfuse.callback`'s v2 import
    succeeds. See this module's docstring for why this is safe rather than
    a behavior-changing hack. Safe to call multiple times/from multiple
    call sites (only this module calls it, but defensive regardless)."""
    if "langchain.callbacks.base" in sys.modules:
        return

    from langchain_core.agents import AgentAction, AgentFinish
    from langchain_core.callbacks.base import BaseCallbackHandler
    from langchain_core.documents import Document

    callbacks_base = types.ModuleType("langchain.callbacks.base")
    callbacks_base.BaseCallbackHandler = BaseCallbackHandler
    callbacks_pkg = types.ModuleType("langchain.callbacks")
    callbacks_pkg.base = callbacks_base

    schema_agent = types.ModuleType("langchain.schema.agent")
    schema_agent.AgentAction = AgentAction
    schema_agent.AgentFinish = AgentFinish
    schema_document = types.ModuleType("langchain.schema.document")
    schema_document.Document = Document
    schema_pkg = types.ModuleType("langchain.schema")
    schema_pkg.agent = schema_agent
    schema_pkg.document = schema_document

    sys.modules["langchain.callbacks"] = callbacks_pkg
    sys.modules["langchain.callbacks.base"] = callbacks_base
    sys.modules["langchain.schema"] = schema_pkg
    sys.modules["langchain.schema.agent"] = schema_agent
    sys.modules["langchain.schema.document"] = schema_document


_install_langchain_legacy_shim()

from langfuse.callback import CallbackHandler  # noqa: E402

_handler: CallbackHandler | None = None
_handler_attempted = False
_client_name: str | None = None

# Stable, verb-ish, deliberately the SAME across all three clients per the
# best-practices doc's "keep dynamic values out of names" / "treat names
# like an API" guidance — the operation is identical everywhere (one user
# message in, one graph run to completion or interrupt). What varies by
# client goes in tags instead (see configure_client()).
TRACE_NAME = "agent-turn"


def configure_client(name: str) -> None:
    """Call once at process startup, before the first `make_thread_config()`
    call — main.py/voice_daemon.py/server.py each call this with their own
    identity ("cli"/"voice"/"dashboard"). Must run before the handler is
    first constructed: `tags` is constructor-bound in v2, not per-call
    overridable (see module docstring), so this has no effect if the lazy
    singleton was already built."""
    global _client_name
    _client_name = name


def _get_handler() -> CallbackHandler | None:
    """Lazily construct the single process-lifetime handler. Returns None
    (defensively, like server.py's LangSmithClient pattern) if
    LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY aren't set, so a missing/bad
    Langfuse config doesn't break chat on any client. `_handler_attempted`
    guards against retrying construction (and re-logging) on every single
    turn once we know it's unconfigured or failed."""
    global _handler, _handler_attempted
    if _handler is not None or _handler_attempted:
        return _handler
    _handler_attempted = True

    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY")
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY")
    if not public_key or not secret_key:
        return None

    # LANGFUSE_HOST is this project's own name (.env.example); LANGFUSE_BASE_URL
    # is the name the langfuse-cli skill's own docs use for the same setting —
    # verified live (STEPS.md 80) that a real account on JP cloud
    # (https://jp.cloud.langfuse.com) silently 401'd when only
    # LANGFUSE_BASE_URL was set, because this used to read LANGFUSE_HOST only
    # and fell back to the US default instead. Accept either name rather than
    # require the user to pick the "right" one.
    host = os.environ.get("LANGFUSE_HOST") or os.environ.get(
        "LANGFUSE_BASE_URL", "https://us.cloud.langfuse.com"
    )
    tags = [f"client:{_client_name}"] if _client_name else None
    try:
        _handler = CallbackHandler(
            public_key=public_key,
            secret_key=secret_key,
            host=host,
            trace_name=TRACE_NAME,
            tags=tags,
        )
    except Exception:
        _handler = None
    return _handler


def langfuse_run_config(thread_id: str) -> dict[str, Any]:
    """Extra RunnableConfig keys to merge into `agent.make_thread_config()`'s
    return value: the shared callback handler plus per-call session routing
    via the `langfuse_session_id` metadata key (see module docstring — this
    overrides the handler's own state on every call, so one handler safely
    serves every thread/turn). Returns {} when Langfuse isn't configured,
    so `config.update({})` at the call site is a clean no-op."""
    handler = _get_handler()
    if handler is None:
        return {}
    return {"callbacks": [handler], "metadata": {"langfuse_session_id": thread_id}}


def get_client() -> Any:
    """The underlying plain `Langfuse` client (for prompt fetching and
    scoring — anything that isn't the LangChain callback handler itself),
    reusing the SAME lazily-built singleton `_get_handler()` already owns
    rather than constructing a second client/connection with the same
    credentials. Returns None under the identical conditions
    `langfuse_run_config()` does (unconfigured or failed construction)."""
    handler = _get_handler()
    return handler.langfuse if handler is not None else None


async def score_gate_outcome(thread_id: str, approved: bool, action: str | None = None) -> None:
    """Evaluations pillar: log a confirmation-gate's real approve/decline
    outcome as a Langfuse score — implicit user feedback on this project's
    own real usage (an approved/declined write action), rather than a
    synthetic dataset. Callers should `asyncio.create_task()` this, never
    `await` it inline: it's best-effort enrichment and must never add
    latency to a confirm/decline round trip a user is actively waiting on,
    nor ever raise into the caller.

    Deliberately does NOT use `CallbackHandler.get_trace_id()` — the
    library's OWN docstring calls that method "deprecated... not
    concurrency-safe" (it reads mutable state off the one shared
    per-process handler, a real risk in server.py where different threads'
    /resume calls can genuinely run concurrently). Instead: after flushing,
    look up the most recent trace for THIS thread's own session_id — safe
    under cross-thread concurrency because the lookup is scoped to one
    thread's session, not shared process state.

    **A real bug found and fixed here, live (STEPS.md 82):** a gated action
    is TWO traces in one session (pre-interrupt, then this resume) — and
    Langfuse's backend indexes them asynchronously, not necessarily in
    creation order. An early version of this function picked
    `trace.list(..., order_by="timestamp.desc")[0]` trusting that ordering,
    and caught it live scoring the WRONG (older, pre-interrupt) trace: at
    query time only the older trace had finished indexing yet, so it was
    the only — and therefore "most recent" — result, even though the newer
    resume trace existed and would appear moments later. Fixed with a
    `from_timestamp` filter: any trace older than the cutoff is
    structurally excluded regardless of indexing order, so "the only trace
    in the window" can't be misattributed the way "the only trace found so
    far" was.

    A first attempt used a tight 10-second cutoff and immediately caught a
    SECOND real bug, live: it undershot and matched nothing at all, even
    though the correct trace existed. Root cause, also observed directly
    (not assumed): Langfuse's recorded trace `timestamp` doesn't line up
    tightly with local wall-clock "now" at the moment this function starts
    running — a gap wide enough that a 10s margin clipped the real trace
    out. Rather than chase an exact number that's really measuring client/
    server clock alignment (fragile, and not the actual property this
    filter needs), the cutoff is now generous (2 minutes) — since a gated
    action's pre-interrupt and resume traces are typically only seconds
    apart, a 2-minute window still reliably separates "this gate's own
    resume trace" from a genuinely distinct, much older interaction in the
    same long-lived session, without depending on tight clock precision. A
    retry loop still absorbs the indexing lag itself (up to ~18s) — since
    this only ever runs as a detached background task, a longer wait costs
    nothing user-facing.
    """
    client = get_client()
    if client is None:
        return
    not_before = datetime.now(UTC) - timedelta(minutes=2)
    try:
        client.flush()
        for _ in range(9):
            traces = client.api.trace.list(
                session_id=thread_id, limit=1, order_by="timestamp.desc", from_timestamp=not_before
            )
            if traces.data:
                break
            await asyncio.sleep(2.0)
        else:
            logger.warning("No trace found to score for session %r after retries", thread_id)
            return

        client.score(
            trace_id=traces.data[0].id,
            name="gate_outcome",
            value=int(approved),
            data_type="BOOLEAN",
            comment=action,
        )
    except Exception:
        logger.warning("Failed to score gate outcome for session %r", thread_id, exc_info=True)
