"""Phase 16 Part B: Langfuse v3 tracing for the three real graph-invocation
call sites (main.py's CLI loop, voice_daemon.py's per-turn pipeline,
server.py's SSE stream). Additive to LangSmith (Phase 3) — this does not
replace or touch server.py's /cost panel, which stays on LangSmith.

**Migrated from Part A's v2 integration — this is the actual migration
diff worth showing.** Two real, structural differences from v2, not just a
version bump:

1. **No compatibility shim needed.** v2's final release (2.60.10, EOL since
   Sept 2025) required a `sys.modules` shim restoring legacy LangChain
   import paths (`langchain.callbacks.base` etc.) that this project's
   LangChain 1.x deleted — see STEPS.md 79/85 for the full story. Verified
   live before writing this: `from langfuse.langchain import
   CallbackHandler` imports cleanly against this project's real installed
   `langchain==1.3.12` with NO shim at all. That whole file section —
   `_install_langchain_legacy_shim()` and its call site — is gone. Its
   deletion IS part of the migration diff.

2. **Session/tags/trace-name propagation moved from constructor-time +
   per-call-metadata (v2's split, awkward model) to a single, uniform
   per-call context manager.** v2 forced an asymmetry: `langfuse_session_id`
   was overridable per call via metadata, but `trace_name`/`tags` were
   constructor-bound — which is *why* Part A needed `configure_client()`
   and hit the real import-ordering bug in `fa_service.py` (STEPS.md 84).
   v3's `langfuse.propagate_attributes()` sets session_id/tags/trace_name
   ALL per-call, uniformly, as a context manager wrapping the actual graph
   invocation — verified live (this file's own migration testing) that it
   sets all three correctly on a real fetched trace. This is a genuine
   architectural improvement, not just new syntax: it eliminates the whole
   "which attribute is constructor-bound vs. per-call" class of bug v2 had.
   The real cost: each of the three call sites now needs to wrap its own
   `ainvoke()`/`astream_events()` call in `with observability.
   tracing_context(thread_id):` — a small, real, unavoidable change,
   since a context manager has to physically wrap the call it scopes,
   unlike v2's model where everything could be smuggled into a config dict
   `agent.make_thread_config()` built centrally. `make_thread_config()`
   still centralizes the callback handler itself (see below) — only the
   session/tags/trace-name propagation moved to the call sites, and each
   does it identically (a one-line `with` block), so there's still exactly
   one pattern to get right, not three different ones.

`get_client()`'s own singleton pattern is now much simpler than v2's: v3's
own client library already treats `Langfuse(...)`/`get_client()` as a
process-wide singleton internally, so this module's `_client` global is
just a thin cache of the credentials-resolution step (still needed to
support the `LANGFUSE_HOST`/`LANGFUSE_BASE_URL` dual-naming fix from
STEPS.md 80 — v3's own env-var resolution wasn't re-verified to handle
both names, so this project keeps doing it explicitly rather than assume).

**Known v2 limitation, confirmed fixed here (STEPS.md 81, re-confirmed
during this migration):** v2's frozen usage-tracking schema silently
dropped output-token/cost data under extended thinking/prompt caching
(both unconditional in this project). Verified live during this migration
(a real `ChatAnthropic` call through `propagate_attributes()` +
`CallbackHandler()`): `usage.output`/`usage.total` come back correct, not
zero. This is the concrete, demonstrable payoff of the migration.

Prompt management (`assistant/prompts.py`) and evaluations
(`score_gate_outcome()` below) both call `get_client()` — verified during
this migration that the underlying REST-API-level methods they depend on
(`get_prompt`, `create_prompt`, `api.trace.list`/`.get`, `flush`, `score`)
are essentially UNCHANGED between v2 and v3, so neither module needed any
logic changes, only this module's client/handler construction did.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import os
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

from langfuse import Langfuse, propagate_attributes
from langfuse.langchain import CallbackHandler
from opentelemetry import context as otel_context
from opentelemetry import propagate

logger = logging.getLogger(__name__)

_client: Langfuse | None = None
_client_attempted = False
_handler: CallbackHandler | None = None
_client_name: str | None = None

# Stable, verb-ish, deliberately the SAME across all three clients — the
# operation is identical everywhere (one user message in, one graph run to
# completion or interrupt). What varies by client goes in tags instead.
TRACE_NAME = "agent-turn"


def configure_client(name: str) -> None:
    """Call once at process startup — main.py/voice_daemon.py/server.py
    each call this with their own identity ("cli"/"voice"/"dashboard").
    Unlike v2, this has no import-ordering hazard to dodge: `tags` is read
    fresh by `tracing_context()` on every call, not baked into a handler
    at construction time — so this can even be called AFTER the handler
    is first built, though every call site still does it at startup for
    clarity."""
    global _client_name
    _client_name = name


def _get_client_internal() -> Langfuse | None:
    """Lazily construct the single process-lifetime client. Returns None
    (defensively, like server.py's LangSmithClient pattern) if
    LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY aren't set, so a missing/bad
    Langfuse config doesn't break chat on any client."""
    global _client, _client_attempted
    if _client is not None or _client_attempted:
        return _client
    _client_attempted = True

    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY")
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY")
    if not public_key or not secret_key:
        return None

    # Same dual-naming fix as v2 (STEPS.md 80) — LANGFUSE_HOST is this
    # project's own name; LANGFUSE_BASE_URL is the langfuse-cli skill's own
    # name for the same setting. Resolved explicitly rather than assumed:
    # a real /code-review max pass (STEPS.md 91) caught that passing this
    # as `host=` doesn't actually win — the installed SDK's own
    # `_base_url` resolution (`_client/client.py`) checks `base_url` kwarg,
    # then the raw `LANGFUSE_BASE_URL` env var, THEN `host=`, so a real
    # `LANGFUSE_BASE_URL` env var would silently override this project's
    # intended `LANGFUSE_HOST` priority. Passing our resolved value as
    # `base_url=` instead of `host=` forces it to win regardless of
    # environment state, live-confirmed against the installed SDK source.
    host = os.environ.get("LANGFUSE_HOST") or os.environ.get(
        "LANGFUSE_BASE_URL", "https://us.cloud.langfuse.com"
    )
    try:
        _client = Langfuse(public_key=public_key, secret_key=secret_key, base_url=host)
    except Exception:
        _client = None
    return _client


def get_client() -> Langfuse | None:
    """The underlying `Langfuse` client — used directly by
    `assistant/prompts.py` and `score_gate_outcome()` below for prompt
    fetching/scoring, and internally by `_get_handler()`/`tracing_context()`
    for tracing. Same public name/contract as v2's version, so no caller
    needed to change."""
    return _get_client_internal()


def _get_handler() -> CallbackHandler | None:
    """Lazily construct the single process-lifetime LangChain callback
    handler. Unlike v2, this handler carries NO session/tags/trace_name
    state at all — those are set per-call by `tracing_context()` via
    `propagate_attributes()` instead, so this handler is genuinely
    identity-less and safe to share across every thread/client with zero
    per-call configuration needed here.

    `CallbackHandler()` construction is guarded the same way
    `_get_client_internal()`'s `Langfuse(...)` call is (STEPS.md 91's
    review caught this asymmetry) — a real, live-verified misconfiguration
    couldn't be found (`CallbackHandler()` just does a guarded singleton
    lookup reusing the already-validated client), but nothing here should
    depend on that staying true forever, and it costs nothing to match the
    sibling function's own defensive posture."""
    global _handler
    if _handler is not None:
        return _handler
    if _get_client_internal() is None:
        return None
    try:
        _handler = CallbackHandler()
    except Exception:
        _handler = None
    return _handler


def langfuse_callbacks() -> list[Any]:
    """The `callbacks` list for `agent.make_thread_config()` to merge in —
    just the shared, identity-less handler. Returns `[]` when Langfuse
    isn't configured, so `config["callbacks"] = langfuse_callbacks()` is a
    clean no-op either way."""
    handler = _get_handler()
    return [handler] if handler is not None else []


@contextmanager
def tracing_context(thread_id: str) -> Iterator[Any]:
    """Wrap a graph invocation (`ainvoke()`/`astream_events()`) in this to
    get v3's per-call session_id/tags/trace_name propagation — the direct
    replacement for v2's `langfuse_run_config()`-returned metadata dict,
    since v3 sets these via `propagate_attributes()`, a context manager
    that has to physically wrap the call it scopes rather than ride along
    in a config dict. Each of the three call sites (`main.py`,
    `voice_daemon.py`, `server.py`) uses this identically:

    ```python
    with observability.tracing_context(thread_id) as span:
        if span is not None:
            span.update(input=user_input)
        result = await graph.ainvoke(..., config=config)
        while "__interrupt__" in result:
            ...
            result = await graph.ainvoke(Command(resume=approved), config=config)
        if span is not None:
            span.update(output=final_text)
    ```

    Also opens an explicit `start_as_current_observation()` span (name =
    TRACE_NAME) around the whole scope, YIELDING it — this is what makes a
    gated action's resume loop nest as ONE tree instead of two. A gated
    tool's `interrupt()` forces the caller to make a SEPARATE top-level
    `ainvoke()` call to resume (LangGraph cannot resume mid-call — control
    must return to the human first), and the LangChain CallbackHandler
    gives each top-level `ainvoke()`/`astream_events()` call its own root
    run. Without an explicit ambient parent span, that's genuinely two
    sibling root spans in the same trace — confirmed live by pulling a real
    interrupt/resume trace's raw observations via the Langfuse API and
    finding exactly that shape. Langfuse's own docs name this exact
    scenario and give `start_as_current_observation` as the fix.

    **Why callers must update the YIELDED SPAN OBJECT, never
    `client.update_current_trace()`:** live-caught, not assumed — this
    module's first version of the input/output fix used
    `update_current_trace()`, which reads whatever the SDK currently
    considers "the current observation." That silently breaks the moment a
    real LangChain call happens inside this scope: a minimal spike (two
    `update_current_trace()` calls around one plain `ChatAnthropic.ainvoke()`,
    no LangGraph involved) showed `get_current_observation_id()` drifting
    to the model call's own (by-then-closed) span after it returns, instead
    of restoring to this function's wrapping span — so the SECOND
    `update_current_trace()` call (output, always issued after real model/
    tool work happens) silently updates nothing, while the FIRST one
    (input, called before any nested work) still worked, which is exactly
    the "input showed up, output stayed empty" symptom a user reported
    live. Calling `.update()` directly on the span OBJECT this function
    yields sidesteps that "current observation" drift entirely — confirmed
    with the same spike, updating a held reference instead, both before AND
    after the nested model call.

    No-ops cleanly (yields `None`, no Langfuse call at all) when Langfuse
    isn't configured — verified this doesn't require a configured client
    at all to be a safe no-op; every caller checks `is not None` first."""
    client = _get_client_internal()
    if client is None:
        yield None
        return
    tags = [f"client:{_client_name}"] if _client_name else None
    with propagate_attributes(session_id=thread_id, tags=tags, trace_name=TRACE_NAME):
        with client.start_as_current_observation(as_type="span", name=TRACE_NAME) as span:
            yield span


def inject_trace_headers() -> dict[str, str]:
    """Standard W3C Trace Context propagation, the caller side (Phase 16
    Part B's OTEL migration of the Part A.5 spike's v2-only trace-linking,
    STEPS.md 89/91) — a pure read of whatever OTEL span is ambient in the
    calling coroutine (the LangChain CallbackHandler's own span for the
    currently-executing node, via the same contextvars mechanism
    `propagate_attributes()` relies on), serialized into a plain headers
    dict any HTTP client can send. Centralized here rather than each
    HTTP-proxied sub-agent calling `opentelemetry.propagate.inject()`
    directly (a real /code-review max finding, STEPS.md 91) so there's one
    implementation for any future cross-process hop to reuse, matching
    `attached_parent_context()` below on the receiving side."""
    headers: dict[str, str] = {}
    propagate.inject(headers)
    return headers


@contextmanager
def attached_parent_context(headers: Mapping[str, str], thread_id: str) -> Iterator[None]:
    """The receiving side of `inject_trace_headers()` — for any HTTP-proxied
    sub-agent process (like `fa_service.py`) handling an incoming request.
    Extracts a `traceparent` header (if present) and attaches it as the
    ambient OTEL context, so every span this process creates during the
    `with` block becomes a real, standard-OTEL child of the caller's own
    span — then layers this process's own `tracing_context(thread_id)`
    inside that attached context, and detaches cleanly on the way out
    (`finally`, safe under cancellation — OTEL's own `context.detach()` is
    itself defensively guarded against a wrong-Context token, verified
    live, STEPS.md 91). One indivisible context manager instead of the
    extract+attach+tracing_context+detach boilerplate duplicated at every
    call site (a real /code-review max finding, STEPS.md 91 — this
    replaces what used to be `_extract_parent_context()` plus manual
    attach/detach hand-written at each of `fa_service.py`'s two endpoints).
    A request with no `traceparent` header (no active span on the caller's
    side, or a caller not doing distributed tracing at all) extracts to an
    empty context unchanged — this process then just opens its own new
    root trace, the same graceful fallback the code this replaces had."""
    ctx = propagate.extract(dict(headers))
    token = otel_context.attach(ctx)
    try:
        with tracing_context(thread_id):
            yield
    finally:
        otel_context.detach(token)


@contextmanager
def resumed_tracing_context(headers: Mapping[str, str], thread_id: str) -> Iterator[Any]:
    """server.py's `/resume`-only counterpart to `attached_parent_context()`
    — reattaches the SAME trace a `/chat` call's turn suspended under, as a
    real child span named "resume" (not a second "agent-turn" — that was
    this function's first version, which produced a real but confusing
    duplicate root-looking label one level deep; caught checking the actual
    resulting trace after the first cross-request test).

    YIELDS that span (or `None` if Langfuse isn't configured) — callers
    must call `.update(output=...)` on it directly once the resumed turn's
    real final answer is known, the SAME reason `tracing_context()`'s own
    docstring gives for why a captured object, not
    `client.update_current_trace()`, is what actually sticks after real
    LangChain work happens in between. This is also, concretely, why this
    function opens a span at all rather than staying a bare context-attach
    like its first version: without one, there is no reliable object left
    to call `.update()` on for the resume's own output once `/resume`'s own
    `astream_events()` call has run — `update_current_trace()`'s "current
    observation" would have already drifted by then, same failure mode.

    **Known, disclosed limitation, not fixable from this side:** the
    TRACE-level `output` (what the Sessions list shows) still won't reflect
    a resumed turn's answer, only THIS "resume" span's own output. Root
    cause confirmed by reading the SDK's own `LangfuseSpan.update()`
    source: it starts with `if not self._otel_span.is_recording(): return
    self` — a plain OTEL rule, not a Langfuse quirk. `/chat`'s own
    `agent-turn` span already ended (its HTTP response already returned)
    by the time `/resume` runs, so it is no longer "recording" and no
    update can reach it — not from a held reference (never had one across
    the request boundary anyway), not via `update_current_trace()`
    (already shown unreliable once ANY nested call happens, see
    `tracing_context()`), not by any means: an ended OTEL span cannot be
    reopened. The real final answer is still fully visible — one click
    into the trace, on this "resume" span — just not mirrored onto the
    trace's own top-level Output field for this specific path. Closing this
    fully would need NOT returning `/chat`'s HTTP response until the whole
    turn resolves, defeating the entire point of surfacing the interrupt to
    the client immediately; not attempted here.

    No-ops the same way `tracing_context()` does when Langfuse isn't
    configured — the attach/detach still happens either way (cheap, and
    correctness-neutral with no active span), matching this module's
    existing defensive posture elsewhere."""
    ctx = propagate.extract(dict(headers))
    token = otel_context.attach(ctx)
    try:
        client = _get_client_internal()
        if client is None:
            yield None
            return
        tags = [f"client:{_client_name}"] if _client_name else None
        with propagate_attributes(session_id=thread_id, tags=tags, trace_name=TRACE_NAME):
            with client.start_as_current_observation(as_type="span", name="resume") as span:
                yield span
    finally:
        otel_context.detach(token)


async def score_gate_outcome(thread_id: str, approved: bool, action: str | None = None) -> None:
    """Evaluations pillar: log a confirmation-gate's real approve/decline
    outcome as a Langfuse score — implicit user feedback on this project's
    own real usage (an approved/declined write action), rather than a
    synthetic dataset. Callers should `asyncio.create_task()` this, never
    `await` it inline: it's best-effort enrichment and must never add
    latency to a confirm/decline round trip a user is actively waiting on,
    nor ever raise into the caller.

    Mostly unchanged from v2 (STEPS.md 82) except the client construction
    this calls into and one real, live-caught rename: v2's `client.score()`
    became v3's `client.create_score()` — a genuine API rename, not a typo
    on this project's side, confirmed by checking `hasattr(client, 'score')`
    directly (False) after a live call raised `AttributeError: 'Langfuse'
    object has no attribute 'score'`. An earlier `inspect.signature()` check
    during this same migration had actually already surfaced this (its
    printed signature belonged to `create_score`, with a literal "no score"
    on the very next line) but was misread as confirming `.score()` instead
    — corrected once the live call caught it for real. `client.api.trace.
    list()`/`.get()` and `client.flush()` are unchanged, so the rest of this
    function's own logic (including the `from_timestamp`-filtered lookup
    that fixed a real trace-misattribution race in v2, STEPS.md 82) needed
    no changes.

    Deliberately does NOT use any deprecated trace-id-off-the-handler
    shortcut — looks up the most recent trace for THIS thread's own
    session_id instead, safe under cross-thread concurrency because the
    lookup is scoped to one thread's session, not shared process state. A
    gated action is TWO traces in one session (pre-interrupt, then this
    resume) and Langfuse's backend indexes them asynchronously, not
    necessarily in creation order — the `from_timestamp` filter (a
    generous 2-minute cutoff, not a tight one — see STEPS.md 82 for why an
    earlier tight cutoff undershot) structurally excludes older traces so
    an incomplete result set can't be misattributed.
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

        client.create_score(
            trace_id=traces.data[0].id,
            name="gate_outcome",
            value=int(approved),
            data_type="BOOLEAN",
            comment=action,
        )
    except Exception:
        # ERROR, not WARNING (STEPS.md 91's review caught the old level as
        # too easy to miss) — this branch means a real API-shape break (the
        # exact class of bug the score()->create_score() rename already
        # was), not just "no trace indexed yet" (that expected case returns
        # above via its own explicit `logger.warning`, never reaches here).
        # Still never raises into the caller — this remains best-effort
        # enrichment, per this function's own docstring.
        logger.error("Failed to score gate outcome for session %r", thread_id, exc_info=True)


def fire_score_gate_outcome(thread_id: str, approved: bool, action: str | None = None) -> None:
    """The one correct way for a call site to schedule `score_gate_outcome()`
    — `asyncio.create_task(score_gate_outcome(...))` directly (what all
    three call sites did before this helper existed) copies whatever OTEL
    context is ambient at the call site, including a still-open
    `propagate_attributes()` scope from an enclosing `tracing_context()`
    block (STEPS.md 91's review: main.py/voice_daemon.py/server.py all fire
    this from inside that block, since the interrupt/resume loop that needs
    it is itself inside the `with`). `score_gate_outcome()` doesn't create
    any spans of its own — it only calls plain REST-style client methods
    (`flush`/`api.trace.list`/`create_score`) — so no concretely observed
    bug traced back to this, but there's no reason a fire-and-forget
    background task should run in a borrowed, possibly-already-closed
    tracing scope at all. `context=contextvars.Context()` gives it a
    genuinely empty context instead, independent of whatever scope was
    active at the call site."""
    asyncio.create_task(
        score_gate_outcome(thread_id, approved, action), context=contextvars.Context()
    )
