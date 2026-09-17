"""Phase 9 backend wrapper: a thin local HTTP server the dashboard app talks
to instead of `langgraph dev` (STEPS.md 54's scoping checkpoint).

Deliberately NOT `assistant/studio.py`'s `make_graph()` path: that one
compiles with `checkpointer=None` because the LangGraph API server manages
its own (ephemeral, `.langgraph_api/`-backed) persistence in local_dev
mode — a separate store from `conversation_memory.sqlite`. This module
instead builds the graph exactly like `main.py` does: a real
`AsyncSqliteSaver` over `conversation_memory.sqlite`, keyed by the SAME
fixed `THREAD_ID` main.py and voice_daemon.py already use. That is what
makes the dashboard app a genuine peer of the CLI/voice daemon — one shared
conversation, not a fork — and what makes the /history endpoint meaningful
(main.py's own thread has real data; the dev server's would not).

Interrupt payloads (CLAUDE.md's standing confirmation-gate rule) are relayed
to the client UNMODIFIED — never re-rendered or re-summarized. This is
load-bearing for Phase 7's memory-write gate specifically: the `fact` field
must reach the UI verbatim so it can be shown exactly as approved, per the
red-team requirement `voice_daemon.py` already enforces by declining to
speak it at all.

Phase 15: thread routing. `/chat` and `/resume` accept an optional
`thread_id`; when omitted, both fall back to `thread_store`'s active
pointer (preserves every pre-Phase-15 client's behavior exactly — this is
what makes the change backward compatible). This explicit-thread_id-with-
pointer-fallback model is the actual fix for the STEPS.md 66 collision: one
client can now target a specific thread via an explicit id without
mutating the global pointer other concurrent clients still read by
default. `/threads` (list/create/switch) and `PATCH /threads/{id}` (rename)
manage the registry itself; switching or creating a thread changes the
pointer, which is a deliberately GLOBAL, shared effect — same as it always
implicitly was when there was only one thread, just now an explicit action
instead of a hardcoded constant.

Phase 14 streaming: `/chat` and `/resume` now return `text/event-stream`
(Server-Sent Events) instead of a single JSON body, via
`graph.astream_events()` instead of `graph.ainvoke()` — see `_stream_turn`'s
own docstring for the full design, verified live against the real graph
before being written (not assumed): interrupts do NOT appear as a stream
event, so detection moved to a post-stream `graph.aget_state()` check;
cancelling the underlying asyncio.Task (`POST /chat/stop`) leaves the
checkpointer clean (an in-flight, uncompleted graph step is simply never
persisted). The interrupt-payload-relayed-verbatim guarantee above is
unchanged — only its transport changed, from one JSON object to the
terminal SSE frame of a stream.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import tempfile
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path
from typing import Any, Literal

from dotenv import load_dotenv

# Loaded before any other project import — same ordering reasoning as
# main.py: assistant.sub_agents/assistant.supervisor construct ChatAnthropic
# instances at module import time, so the environment must be populated
# first.
load_dotenv()

from fastapi import FastAPI, File, HTTPException, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from langchain_core.messages import BaseMessage, HumanMessage  # noqa: E402
from langfuse import Langfuse  # noqa: E402
from langfuse.api.core.api_error import ApiError  # noqa: E402
from langgraph.types import Command  # noqa: E402
from PIL import Image  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from assistant import (  # noqa: E402
    active_turns,
    automation_store,
    board_store,
    claude_code_sessions,
    cost_cache,
    memory_review_agent,
    memory_store,
    observability,
    phone_store,
    thread_store,
    workflow_store,
)
from assistant.a2ui import A2UI_SURFACE_KEY  # noqa: E402
from assistant.agent import make_thread_config  # noqa: E402
from assistant.compaction import is_compaction_summary, is_genuine_human_turn  # noqa: E402
from assistant.interrupts import send_test_notification  # noqa: E402
from assistant.mcp_tools import load_mcp_tools  # noqa: E402
from assistant.memory import get_checkpointer  # noqa: E402
from assistant.phone_tools import PHONE_ACTION_KEY  # noqa: E402
from assistant.sub_agents import build_life_admin_agent, build_mac_control_agent  # noqa: E402
from assistant.supervisor import GATED_ACTIONS, _invoke_agent_graph, build_graph  # noqa: E402
from assistant.tools import _resolve_in_workspace  # noqa: E402

# Historically had to run before observability's lazy handler was first
# constructed, since tags were constructor-bound in Langfuse v2. No longer
# a hard ordering requirement as of the v3 migration (STEPS.md 86) — tags
# are read fresh per-call now. See observability.py's configure_client().
observability.configure_client("dashboard")

# Overridable so tests/throwaway runs can redirect to a temp copy instead of
# the real conversation_memory.sqlite (CLAUDE.md's verification-discipline
# rule: throwaway scripts must not pollute real state). Read at import time,
# same "env before code runs" ordering as tools.py's TAVILY_API_KEY.
CONVERSATION_DB_PATH = os.environ.get("ASSISTANT_CONVERSATION_DB_PATH", "conversation_memory.sqlite")

# iPhone-access feature: serving the dashboard's OWN build as static files
# from this same server (see the mount at the bottom of this file) is what
# lets a phone browser reach it same-origin — no CORS entries needed for
# it, unlike the Tauri app's cross-origin dev/webview requests above.
# Relative to cwd, same convention as CONVERSATION_DB_PATH — both Tauri's
# spawn_backend (current_dir=project root) and a by-hand launch from the
# project root satisfy that.
DASHBOARD_DIST_PATH = Path("dashboard/dist")

# Same redirect story for the long-term facts DB — monkeypatches
# memory_store.DEFAULT_DB_PATH exactly the way memory_store's own tests
# already do (its docstring: a parameter default would bind too early to
# catch a later override, so it's resolved inside each function body).
if "ASSISTANT_MEMORY_DB_PATH" in os.environ:
    memory_store.DEFAULT_DB_PATH = os.environ["ASSISTANT_MEMORY_DB_PATH"]

# Same redirect story again, for Phase 15's thread registry/pointer DB.
if "ASSISTANT_THREADS_DB_PATH" in os.environ:
    thread_store.DEFAULT_DB_PATH = os.environ["ASSISTANT_THREADS_DB_PATH"]

# Same redirect story again, for the kanban board DB.
if "ASSISTANT_BOARD_DB_PATH" in os.environ:
    board_store.DEFAULT_DB_PATH = os.environ["ASSISTANT_BOARD_DB_PATH"]

# Same redirect story again, for Phase 21's phone-data-sync DB.
if "ASSISTANT_PHONE_DB_PATH" in os.environ:
    phone_store.DEFAULT_DB_PATH = os.environ["ASSISTANT_PHONE_DB_PATH"]

# Same redirect story again, for Phase 24's automation-registry DB.
if "ASSISTANT_AUTOMATIONS_DB_PATH" in os.environ:
    automation_store.DEFAULT_DB_PATH = os.environ["ASSISTANT_AUTOMATIONS_DB_PATH"]

# Same redirect story again, for Phase 25's workflow-run DB.
if "ASSISTANT_WORKFLOWS_DB_PATH" in os.environ:
    workflow_store.DEFAULT_DB_PATH = os.environ["ASSISTANT_WORKFLOWS_DB_PATH"]

# PLAN.md Phase 24: which GATED_ACTIONS an automation may be pre-approved
# for — a deliberate NARROWING of the full GATED_ACTIONS set, not full
# generality. The phase's own concrete example (and the grilling
# session's own scoping) is messaging-shaped ("arrival/departure text to
# a specific person") — letting an unattended, geofence-fired automation
# silently pre-approve something like delete_disk_file or run_shortcut
# was never actually discussed and would be a real, unrequested scope
# expansion of an already-accepted risk, not a neutral default. Revisit
# only with the user, same standing as every other security-model
# decision in this project.
AUTOMATION_ELIGIBLE_ACTIONS = {"send_imessage", "send_email"}

# A real gap found in review, not part of the phase's original scope: a
# flaky geofence (GPS jitter bouncing across the boundary) is a known
# Shortcuts failure mode and could refire the same automation many times
# in a few minutes, each one a real unattended message send + API spend.
# Only counts a previous run whose outcome was actually "fired" — a stale
# "skipped" (e.g. from being disabled) or "error" run must never block the
# next real attempt, so re-enabling a disabled automation isn't stuck
# behind an old skip.
AUTOMATION_FIRE_COOLDOWN = timedelta(minutes=5)

_COST_WINDOWS: dict[str, timedelta | None] = {
    "today": timedelta(hours=24),
    "week": timedelta(days=7),
    "all_time": None,
}

# "all_time" needs a concrete lower bound — Langfuse's metrics API requires
# fromTimestamp, unlike LangSmith's get_run_stats(start_time=None). Anchored
# well before this project's Langfuse integration existed at all (Phase 16,
# 2026-07-16), so it's guaranteed to cover every real trace regardless of
# exactly when the account/project actually started.
_ALL_TIME_START = datetime(2020, 1, 1, tzinfo=UTC)

# Swapped from LangSmith to Langfuse (2026-07-25) — see /cost's own
# docstring for why. Queries the "observations" view (each observation is
# one model call), v2's replacement for v1's now-deprecated "traces" view —
# confirmed live that v2 rejects view="traces" outright
# (invalid_value: must be one of observations/scores-numeric/
# scores-categorical/scores-boolean). uniq(traceId) recovers the same
# "one turn" count v1's trace-level `count` measure gave: cross-checked
# live against the real project, both returned the identical number (611)
# for the same 30-day window, as did sum(totalCost)/sum(totalTokens)
# against v1's trace-level totalCost/totalTokens (also identical to the
# fraction-of-a-cent) — confirms observation-level sums already equal the
# trace-level rollup, so there's no double-counting from nested
# spans/generations within one turn.
_COST_METRICS_QUERY = [
    {"measure": "traceId", "aggregation": "uniq"},
    {"measure": "inputTokens", "aggregation": "sum"},
    {"measure": "outputTokens", "aggregation": "sum"},
    {"measure": "totalTokens", "aggregation": "sum"},
    {"measure": "inputCost", "aggregation": "sum"},
    {"measure": "outputCost", "aggregation": "sum"},
    {"measure": "totalCost", "aggregation": "sum"},
]


def _query_langfuse_cost_sync(client: Langfuse, start: datetime, end: datetime) -> dict[str, Any]:
    """Blocking call (Langfuse's `api.metrics_v_2.metrics()` makes a
    synchronous HTTP request) — always run via asyncio.to_thread, same
    caution the LangSmith call this replaces used to need, or it stalls
    every other concurrent request on this server for however long the
    three windows' calls take.

    A zero-data window still returns one row, but a sum measure with no
    matching data comes back `None` (not `0`) — live-confirmed against a
    deliberately empty 1-minute window — so `_summarize_langfuse_row` below
    coalesces explicitly rather than relying on `dict.get`'s default."""
    query = {
        "view": "observations",
        "metrics": _COST_METRICS_QUERY,
        "fromTimestamp": start.isoformat(),
        "toTimestamp": end.isoformat(),
    }
    rows = client.api.metrics_v_2.metrics(query=json.dumps(query)).data
    return rows[0] if rows else {}


def _summarize_langfuse_row(row: dict[str, Any]) -> dict[str, Any]:
    def _num(key: str) -> float:
        return row.get(key) or 0

    return {
        "run_count": int(_num("uniq_traceId")),
        "total_tokens": int(_num("sum_totalTokens")),
        "prompt_tokens": int(_num("sum_inputTokens")),
        "completion_tokens": int(_num("sum_outputTokens")),
        "total_cost": float(_num("sum_totalCost")),
        "prompt_cost": float(_num("sum_inputCost")),
        "completion_cost": float(_num("sum_outputCost")),
    }


def _render_content(content: object) -> str:
    """Render a message's content as plain text. Mirrors main.py's
    `_render_content` (kept as a separate copy rather than a shared import —
    this module and main.py are two independent entry points, same as
    voice_daemon.py already duplicating its own small rendering helper)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "\n".join(part for part in parts if part)
    return str(content)


def _message_role(message: BaseMessage) -> str:
    """Map a LangChain message's class to a plain role string for the
    dashboard's history panel."""
    return {
        "human": "user",
        "ai": "assistant",
        "tool": "tool",
        "system": "system",
    }.get(message.type, message.type)


def _is_synthetic(message: BaseMessage) -> bool:
    """True only for a HumanMessage the graph itself inserted rather than
    the real user — the Phase 6 routing bridge, Phase 7 Part B's
    recalled-facts injection (both: `not is_genuine_human_turn`), or the
    compaction summary (`is_compaction_summary`, a separate check —
    deliberately NOT covered by `is_genuine_human_turn`, see that
    function's own docstring). Every non-human message type is never
    "synthetic" in this sense — `is_genuine_human_turn` returns False for
    those too (they're simply not a human turn at all), so this function
    must not treat that as "synthetic" or every AI/tool message would be
    wrongly flagged. Found live (STEPS.md 57): a real `/history` response
    from a multi-hop turn included the routing-bridge text verbatim as a
    `role: "user"` entry — naive role/content rendering would show it as if
    the user typed it. Flagged here (not silently dropped) so /history
    stays a complete, honest record; the client decides whether to hide it
    (the chat panel does) or show it (a future debug/history view might
    not)."""
    if message.type != "human":
        return False
    return (not is_genuine_human_turn(message)) or is_compaction_summary(message)


def _sse_event(payload: dict[str, Any]) -> bytes:
    """One Server-Sent-Events frame. `\n\n` is the SSE frame terminator —
    both newlines are required, not stylistic."""
    return f"data: {json.dumps(payload)}\n\n".encode()


def _extract_token_text(content: object) -> str:
    """Pull the text delta out of one `on_chat_model_stream` chunk's
    `.content` — verified against the REAL installed Anthropic integration
    (langgraph 1.2.8) before writing this, not assumed: a content delta is
    a list of blocks shaped like `{"type": "text", "text": "..."}` for
    actual prose, but ALSO `{"type": "tool_use", ...}` /
    `{"type": "input_json_delta", ...}` while a tool call is being
    constructed — those must never reach the client as visible "typing"
    text. Deliberately NOT `_render_content` here: that helper joins
    multiple blocks with `\\n`, correct for rendering one COMPLETE final
    message, wrong for concatenating a stream of small deltas of the same
    running text (would inject spurious newlines between fragments)."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "".join(parts)


async def _stream_turn(
    graph: Any,
    thread_id: str,
    input_or_command: Any,
    gate_outcome: tuple[bool, str | None] | None = None,
    *,
    is_resume: bool = False,
) -> AsyncIterator[bytes]:
    """Stream one turn (a fresh message OR a Command(resume=...)) as SSE
    frames: zero or more `{"type": "token", "text": ...}` deltas, zero or
    more `{"type": "a2ui", "surface": ...}` frames (Phase 17 — ephemeral,
    render-only, never terminal), and zero or more `{"type": "activity",
    "phase": "tool_start"|"tool_end", "agent": ..., "tool": ...}` frames
    (Phase 19 — supervisor/specialist tool-call activity, also ephemeral,
    never terminal, never persisted), followed by exactly one terminal
    frame — `{"type": "interrupt", "payload": ...}`
    or `{"type": "message", "content": ...}`.

    `gate_outcome` (STEPS.md 82, evaluations pillar): when this call is a
    `/resume`, the caller passes `(request.approved, action)` — scored as a
    Langfuse score ONLY once this specific resume fully resolves (the
    "message" branch below, not another chained "interrupt"), as a
    background task that never blocks the SSE response the client is
    actively streaming.

    Interrupt detection is the load-bearing part (CLAUDE.md's standing
    confirmation-gate rule) and does NOT work the way the old
    `ainvoke()`-based code did: verified live before writing this
    (astream_events over a real gated-tool call) that a pending
    `interrupt()` does NOT appear as an event in the stream at all — the
    event stream simply ends once the graph suspends. The only reliable
    way to detect it is `graph.aget_state()` AFTER the stream is
    exhausted, checking `state.tasks[*].interrupts` — exactly what this
    function does below. `pending[0]` mirrors the old
    `result["__interrupt__"][0]` — taking the first is safe, never lossy,
    because `NoParallelWrites`/`NoParallelHandoffs`/`NoParallelMacWrites`
    already guarantee at most one gated call is ever pending at once.

    `is_resume` (passed by the `/resume` endpoint only): consumes any stored
    `app.state.pending_trace_headers[thread_id]` — the W3C traceparent
    captured from the span active when THIS thread's turn last suspended on
    interrupt() — and reattaches it via `observability.attached_parent_
    context()` instead of opening a fresh `tracing_context()` root. This is
    what makes a gated action's `/chat` → (human looks at the card for
    however long) → `/resume` round trip nest as one tree in Langfuse
    instead of two sibling roots, mirroring the fix already verified for
    main.py's/voice_daemon.py's single-process while-loop case — the
    dashboard needs its own mechanism because `/chat` and `/resume` are
    separate HTTP requests with no shared Python scope to wrap.

    Registers itself in `app.state.active_tasks[thread_id]` so `/chat/stop`
    can cancel it — verified live that an external `task.cancel()` here
    leaves the checkpointer in a clean state (the in-flight graph step
    simply never completes and is never persisted; `state.next` reverts to
    empty, same as if the turn had never been started at all), so stopping
    mid-run cannot leave a corrupted or half-written checkpoint. The one
    narrower, accepted risk — cancelling while a gated tool's OWN
    side-effecting code is actually mid-flight, after its confirmation
    check but before the real API call returns — is the same class of
    tradeoff any agentic tool's "stop mid-tool-call" already accepts; nothing
    about this design makes it worse than that baseline.
    """
    task = asyncio.current_task()
    if task is not None:
        app.state.active_tasks[thread_id] = task
    active_turns.start_turn(thread_id, channel="dashboard")
    outcome: active_turns.Outcome = "completed"
    try:
        config = make_thread_config(thread_id)
        # Phase 16 Part B (v3 migration): wraps the actual graph streaming
        # in Langfuse v3's per-call session/tags/trace-name propagation —
        # observability.py's module docstring has the full why this
        # replaced v2's config-dict-based metadata approach. Scoped tightly
        # around the streaming/state-read work, not the DB touch below,
        # since that isn't a traced operation.
        #
        # `/resume` only: reattach the traceparent captured when this
        # thread's turn last suspended, instead of opening a fresh root —
        # see this function's own docstring for the full why.
        # `resumed_tracing_context()`, not `attached_parent_context()` —
        # the latter is fa_service.py's cross-PROCESS helper and
        # deliberately opens its own nested span for the FA's contribution;
        # reusing it here for a same-process resume produced a real but
        # purely cosmetic redundant "agent-turn" span one level deeper than
        # the original (caught live checking the actual resulting trace).
        # Falls back to a fresh tracing_context() if nothing was stored
        # (Langfuse wasn't configured when the interrupt fired, or this is
        # somehow the first call on this thread), same as any defensive
        # lookup miss.
        stored_headers = app.state.pending_trace_headers.pop(thread_id, None) if is_resume else None
        tracing_scope = (
            observability.resumed_tracing_context(stored_headers, thread_id)
            if stored_headers
            else observability.tracing_context(thread_id)
        )
        with tracing_scope as span:
            # Trace-level input/output — see tracing_context()'s docstring
            # for the real regression this fixes and why it must be set on
            # the yielded SPAN OBJECT, never via client.update_current_trace()
            # (silently drops the update once a real LangChain call happens
            # in between, live-caught). Only set input on a genuinely fresh
            # turn, never on /resume — a resume's own input_or_command is a
            # bare Command(resume=...), not the user's real message, and
            # would overwrite the trace's real input with that if set
            # unconditionally here.
            if span is not None and not is_resume:
                span.update(input=input_or_command)
            async for event in graph.astream_events(input_or_command, config=config, version="v2"):
                if event.get("event") == "on_chat_model_stream":
                    text = _extract_token_text(event["data"]["chunk"].content)
                    if text:
                        yield _sse_event({"type": "token", "text": text})
                elif (
                    event.get("event") == "on_custom_event"
                    and event.get("name") == "research_fa_token"
                ):
                    # Phase 16 Part A.5 (the mentor's distributed-tracing
                    # spike): supervisor.py's research_agent_proxy()
                    # re-dispatches tokens it streams from the FA process
                    # via adispatch_custom_event(), since that's the one
                    # mechanism verified live to actually surface through
                    # astream_events() as a real event — LangGraph's own
                    # get_stream_writer() custom channel does NOT (checked
                    # empirically, not assumed). Forwarded identically to a
                    # normal token frame; the dashboard client can't tell
                    # the difference, same as the whole point of the spike
                    # being invisible to callers.
                    text = event["data"].get("text", "")
                    if text:
                        yield _sse_event({"type": "token", "text": text})
                elif event.get("event") == "on_custom_event" and event.get("name") == "agent_activity":
                    # PLAN.md Phase 19: supervisor.py's _AgentActivityRelay
                    # (a specialist's own inner tool calls) and
                    # call_specialist (the supervisor->specialist boundary
                    # itself) both dispatch this via the identical
                    # adispatch_custom_event mechanism research_fa_token/
                    # a2ui_surface already proved crosses the nested-
                    # ainvoke() specialist boundary. Purely additive,
                    # non-terminal, like a2ui below — the dashboard's
                    # right-rail activity graph/tool-call timeline/status
                    # pill consume this; nothing here changes the terminal
                    # frame or what /history persists.
                    yield _sse_event({"type": "activity", **event["data"]})
                elif event.get("event") == "on_custom_event" and event.get("name") == "a2ui_surface":
                    # Phase 17 (PLAN.md): assistant/a2ui.py's render_ui tool
                    # dispatches a validated A2UI component tree the same
                    # way — re-uses the identical custom-event mechanism
                    # research_fa_token proved above, just a distinct event
                    # name. Ephemeral by design (this session's Part A
                    # decision): forwarded live to whichever client is
                    # streaming this turn, never persisted to the
                    # checkpointer — render_ui's own return value (a short
                    # text summary) is what ends up in the real message
                    # history and survives reload/History, not this frame.
                    yield _sse_event({"type": "a2ui", "surface": event["data"]})

            state = await graph.aget_state(config)
            pending = [i for t in state.tasks for i in t.interrupts]
            if pending:
                # Captured from INSIDE tracing_scope, so this is the span
                # this turn actually suspended under — a later /resume picks
                # it up via app.state.pending_trace_headers above. Naturally
                # self-refreshes on each further interrupt within the same
                # multi-gated-action turn; no explicit clearing needed on
                # the completed-turn path below, since that path is only
                # ever reached once nothing is left pending.
                app.state.pending_trace_headers[thread_id] = observability.inject_trace_headers()
                yield _sse_event({"type": "interrupt", "payload": pending[0].value})
            else:
                final_message = state.values["messages"][-1]
                final_content = _render_content(final_message.content)
                if span is not None:
                    span.update(output=final_content)
                yield _sse_event({"type": "message", "content": final_content})
                if gate_outcome is not None:
                    approved, action = gate_outcome
                    observability.fire_score_gate_outcome(thread_id, approved, action)
        await thread_store.touch_thread(thread_id, db_path=thread_store.DEFAULT_DB_PATH)
    except asyncio.CancelledError:
        # /chat/stop already told its caller "stopped: true" — nothing left
        # to signal here; letting this propagate closes the SSE connection,
        # which is exactly what the client sees as "the stream stopped."
        outcome = "cancelled"
        raise
    except Exception as exc:  # network errors, rate limits, etc. — data, not a crash
        outcome = "error"
        yield _sse_event({"type": "error", "detail": f"{type(exc).__name__}: {exc}"})
    finally:
        app.state.active_tasks.pop(thread_id, None)
        active_turns.finish_turn(thread_id, outcome=outcome)


async def _run_turn(
    graph: Any,
    thread_id: str,
    input_or_command: Any,
    gate_outcome: tuple[bool, str | None] | None = None,
    *,
    is_resume: bool = False,
) -> dict[str, Any]:
    """Non-streaming sibling of `_stream_turn`, for PLAN.md Phase 21's
    phone-initiated-turn channel (`/phone/turn`/`/phone/resume`) — Shortcuts'
    `Get Contents of URL` action can't consume an SSE stream, so this
    collapses a turn to a single JSON response instead of a token stream.
    Same interrupt-detection/trace-linking/gate-scoring contract as
    `_stream_turn` (`aget_state`... no — here `graph.ainvoke()`'s own
    return dict carries `__interrupt__` directly, the same shape
    `voice_daemon.py`'s `_process_turn` already reads, since there's no
    token stream here to make that detection unreliable the way it is for
    `astream_events`).

    One behavior this function has that `_stream_turn` does NOT: a
    `voice_approvable: False` gate is auto-declined and the turn continues
    silently, exactly like `voice_daemon.py`'s own loop — this channel has
    no screen to show free-text gate content on, so it never surfaces a
    text-only gate to Speak/Dictate at all (CLAUDE.md's standing rule: those
    gates are text-only, never voice-approvable, on every existing voice
    surface). Only a `voice_approvable: True` gate is returned to the
    client as a real `{"type": "interrupt", ...}` response, for
    `/phone/resume` to answer via its own Speak-then-Dictate round trip —
    unlike `voice_daemon.py`, which owns the mic continuously and can ask
    inline, this is a stateless HTTP channel: the client has to hang up and
    call back once it has an answer.

    Also collects PLAN.md Phase 21's `phone_action` marker
    (`phone_tools.PHONE_ACTION_KEY`) — the mechanism `open_app_on_phone`/
    `open_url_on_phone` use to describe a structured action for the
    calling Shortcut to carry out locally after the reply (see
    `phone_tools.py`'s own docstring for why nothing here can execute
    anything on the phone directly). This must be scoped to messages added
    DURING this call only — `result["messages"]` is the full, ever-growing
    checkpointed thread history, and naively scanning all of it would
    resurface a stale phone_action from an earlier turn on every
    subsequent call. `graph.aget_state()` is read once up front purely to
    capture that starting message count as a slice boundary.
    """
    config = make_thread_config(thread_id)
    stored_headers = app.state.pending_trace_headers.pop(thread_id, None) if is_resume else None
    tracing_scope = (
        observability.resumed_tracing_context(stored_headers, thread_id)
        if stored_headers
        else observability.tracing_context(thread_id)
    )
    active_turns.start_turn(thread_id, channel="phone")
    outcome: active_turns.Outcome = "completed"
    try:
        with tracing_scope as span:
            if span is not None and not is_resume:
                span.update(input=input_or_command)

            state_before = await graph.aget_state(config)
            seen = len(state_before.values.get("messages", []))
            phone_actions: list[dict[str, Any]] = []

            def _collect_phone_actions(messages: list[Any]) -> None:
                for m in messages:
                    phone_actions.extend(
                        getattr(m, "additional_kwargs", {}).get(PHONE_ACTION_KEY) or []
                    )

            result = await graph.ainvoke(input_or_command, config=config)
            _collect_phone_actions(result["messages"][seen:])
            seen = len(result["messages"])

            response: dict[str, Any] | None = None
            while "__interrupt__" in result:
                payload = result["__interrupt__"][0].value
                auto_action = payload.get("action") if isinstance(payload, dict) else None
                if isinstance(payload, dict) and payload.get("voice_approvable") is False:
                    result = await graph.ainvoke(Command(resume=False), config=config)
                    _collect_phone_actions(result["messages"][seen:])
                    seen = len(result["messages"])
                    observability.fire_score_gate_outcome(thread_id, False, auto_action)
                    if auto_action == "propose_workflow":
                        # PLAN.md Phase 25, decision D8: a multi-step workflow
                        # plan can only be approved on the dashboard (its own
                        # card needs to show every step verbatim, which this
                        # channel has no way to do) — auto-declining silently,
                        # like every other text-only gate here, would let the
                        # phone falsely imply nothing was even attempted.
                        # Return a deterministic message instead of letting
                        # the model's own follow-up text (after its own
                        # decline instruction) stand in for one.
                        response = {
                            "type": "message",
                            "content": (
                                "This needs a multi-step confirmation, which only works "
                                "from the dashboard — open Oni there to review and "
                                "approve the plan."
                            ),
                        }
                        break
                    continue
                app.state.pending_trace_headers[thread_id] = observability.inject_trace_headers()
                response = {"type": "interrupt", "payload": payload}
                break

            if response is None:
                final_content = _render_content(result["messages"][-1].content)
                if span is not None:
                    span.update(output=final_content)
                if gate_outcome is not None:
                    approved, action = gate_outcome
                    observability.fire_score_gate_outcome(thread_id, approved, action)
                response = {"type": "message", "content": final_content}
                if phone_actions:
                    response["phone_actions"] = phone_actions
        await thread_store.touch_thread(thread_id, db_path=thread_store.DEFAULT_DB_PATH)
        return response
    except asyncio.CancelledError:
        outcome = "cancelled"
        raise
    except Exception as exc:  # data, not a crash — same convention as _stream_turn's error frame
        outcome = "error"
        return {"type": "error", "detail": f"{type(exc).__name__}: {exc}"}
    finally:
        active_turns.finish_turn(thread_id, outcome=outcome)


# --- File/photo upload (dashboard chat composer) --------------------------
#
# Uploading your own file is user input, not an agent-initiated side effect —
# symmetric with typing a message, so this deliberately does NOT go through
# the interrupt/confirmation gate (CLAUDE.md's standing rule only gates
# agent-authored actions). Two invariants this must never violate:
#   1. /uploads writes only through _resolve_in_workspace (tools.py) — the
#      existing sandboxed-directory boundary every file tool already uses.
#      The filename is server-generated (uuid4, never the raw client name),
#      but it's still routed through that same containment check rather
#      than trusted "because we generated it" — one implementation of the
#      boundary, not a second bespoke one for uploads.
#   2. Content read back via read_file is ordinary untrusted tool output,
#      already covered by the existing threat model (assistant/tools.py's
#      module docstring). No new mitigation category.
MAX_IMAGE_BYTES = 3_500_000  # raw; ~4.7MB base64, under Claude's 10MB cap w/ headroom
MAX_DOCUMENT_BYTES = 20_000_000
# Exactly Claude's supported image set (Anthropic vision docs) — HEIC (the
# default from iPhone/Photos.app) is deliberately NOT accepted; rejected with
# a clear error rather than silently mishandled or transcoded (no HEIC
# decoder dependency in v1).
ALLOWED_IMAGE_MIME = {"image/jpeg", "image/png", "image/gif", "image/webp"}
ALLOWED_DOCUMENT_EXT = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml",
    ".log", ".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".css", ".sql", ".sh",
}
# claude-sonnet-5 is in Anthropic's high-resolution vision tier: an
# unresized 4K screenshot costs ~4784 visual tokens; downsampling to this
# long edge first cuts that to ~1560 (~3x) for negligible quality loss in
# chat use — CLAUDE.md's standing cost-consciousness rule.
IMAGE_MAX_LONG_EDGE = 1568

# iPhone-access feature: a browser-recorded utterance (webm/opus or mp4/aac,
# whatever the client's MediaRecorder produces) shouldn't run more than a
# couple minutes for a single chat turn — generous headroom over that, not
# tuned tight, since unlike images there's no per-byte cost signal to guard
# against (STT cost is local/free, per voice_io.py's own module docstring).
MAX_VOICE_UPLOAD_BYTES = 25_000_000


def _sanitize_upload_filename(filename: str) -> str:
    """Server-generated-safe stem + real extension — never the raw client
    name verbatim (collisions, path-shaped names). Routed through
    _resolve_in_workspace below regardless; this only keeps the on-disk
    name readable."""
    stem, _, ext = filename.rpartition(".")
    stem = stem or filename
    safe_stem = "".join(c if c.isalnum() or c in "-_" else "_" for c in stem)[:64] or "file"
    safe_ext = "".join(c for c in ext if c.isalnum())[:10]
    return f"{safe_stem}.{safe_ext}" if safe_ext else safe_stem


class Attachment(BaseModel):
    """What /uploads returned, echoed back on the /chat call that uses it.
    The client is telling us a path — _build_user_content re-resolves it
    server-side via _resolve_in_workspace rather than trusting it."""

    path: str  # workspace-relative
    mime_type: str
    kind: Literal["image", "document"]
    filename: str


def _build_user_content(message: str, attachments: list[Attachment]) -> str | list[dict[str, Any]]:
    """Plain string when there are no attachments — byte-identical to the
    pre-upload shape, so every existing caller (CLI, voice daemon, every
    test that predates this feature) is completely unaffected. Only
    attachment-bearing turns get the multimodal content-block list."""
    if not attachments:
        return message

    blocks: list[dict[str, Any]] = []
    doc_lines: list[str] = []
    for att in attachments:
        resolved = _resolve_in_workspace(att.path)  # raises ValueError on escape/dotfile
        if not resolved.is_file():
            raise HTTPException(status_code=400, detail=f"unknown attachment: {att.path}")
        if att.kind == "image":
            blocks.append(
                {
                    "type": "image",
                    "source_type": "base64",
                    "mime_type": att.mime_type,
                    "data": base64.b64encode(resolved.read_bytes()).decode(),
                }
            )
        else:
            doc_lines.append(f"- {att.filename} -> {att.path}")

    text = message
    if doc_lines:
        text += (
            "\n\n[The user attached these files to the workspace. "
            "Use read_file with the path shown to read one.]\n" + "\n".join(doc_lines)
        )
    # Images before text, matching Anthropic's own documented ordering guidance.
    blocks.append({"type": "text", "text": text})
    return blocks


class ChatRequest(BaseModel):
    message: str
    # Optional (Phase 15): a client that manages its own conversation can
    # target a specific thread without touching the shared active pointer —
    # the actual fix for STEPS.md 66's collision. Omitted means "whatever
    # the active pointer currently says", preserving every pre-Phase-15
    # client's behavior exactly.
    thread_id: str | None = None
    # File/photo upload feature: paths returned by POST /uploads. Default
    # empty list keeps every pre-existing caller byte-compatible.
    attachments: list[Attachment] = []


class ResumeRequest(BaseModel):
    approved: bool
    # Must match whichever thread_id the /chat call that produced the
    # pending interrupt used — same fallback-to-active-pointer default.
    thread_id: str | None = None


class StopRequest(BaseModel):
    thread_id: str | None = None


class PhoneTurnRequest(BaseModel):
    """PLAN.md Phase 21: what the Action Button / Share Sheet Shortcut
    posts to `/phone/turn`. Mirrors ChatRequest's shape (message/
    thread_id/attachments — reusing the exact same `_resolve_thread_id`/
    `_build_user_content` helpers /chat already uses, not a second
    implementation) plus `location`. `location` is free text the Shortcut
    itself attaches (e.g. via `Get Current Location` formatted to an
    address or "lat,lon") — the backend never fetches it independently;
    the project's governing "the backend can never push a request to the
    phone" platform constraint (see PLAN.md's Phase 21 entry) means it
    can't ask the phone for its location out of band either, only receive
    whatever the Shortcut chose to include on THIS turn."""

    message: str
    thread_id: str | None = None
    attachments: list[Attachment] = []
    location: str | None = None


class PhoneResumeRequest(BaseModel):
    approved: bool
    thread_id: str | None = None


class PhoneHealthSyncRequest(BaseModel):
    """PLAN.md Phase 21: what the health-sync Shortcut posts — a free-text
    (or JSON-as-text) summary the Shortcut itself assembled from the
    Health app's own data via its `Find Health Samples` action(s). This
    server never talks to HealthKit directly (no such access exists
    off-device) — it only ever stores whatever the phone already gathered
    and chose to push, per PLAN.md Phase 21's "user-triggered push only"
    decision."""

    content: str


class A2UIActionRequest(BaseModel):
    """Phase 17 Part B: what an interactive A2UI Button reports back —
    assistant/a2ui.py's module docstring has the full design. `context` is
    whatever path -> value pairs the renderer collected from that surface's
    TextField/CheckBox/ChoicePicker components at submit time; an open dict
    since the fields are surface-specific, same reasoning InterruptPayload
    (api.ts) is an open record."""

    surface_id: str
    name: str
    context: dict[str, Any] = {}
    thread_id: str | None = None


class CreateThreadRequest(BaseModel):
    title: str | None = None


class SetActiveThreadRequest(BaseModel):
    thread_id: str


class RenameThreadRequest(BaseModel):
    title: str


class CreateProjectRequest(BaseModel):
    name: str


class RenameProjectRequest(BaseModel):
    name: str


class AssignThreadProjectRequest(BaseModel):
    # None clears a thread's project (Phase 28 Decision 2 — nullable,
    # not just "some other project"). A plain `str | None` field (rather
    # than an Optional-with-sentinel dance) is enough since this endpoint
    # has no other fields that could be confused with an omitted one.
    project_id: str | None


async def _resolve_thread_id(explicit: str | None) -> str:
    """Explicit-thread_id-with-pointer-fallback (PLAN.md Phase 15 step 1):
    no thread_id means "the active pointer"; an explicit one must already
    be a real, registered thread — an unrecognized id is a client bug
    (typo'd/stale id), not something to silently paper over by creating a
    thread nobody asked to create."""
    if explicit is None:
        return await thread_store.get_active_thread_id(db_path=thread_store.DEFAULT_DB_PATH)
    thread = await thread_store.get_thread(explicit, db_path=thread_store.DEFAULT_DB_PATH)
    if thread is None:
        raise HTTPException(status_code=404, detail=f"No thread with id {explicit}")
    return explicit


def _serialize_thread(thread: thread_store.Thread) -> dict[str, Any]:
    return {
        "id": thread.id,
        "title": thread.title,
        "created_at": thread.created_at,
        "last_active_at": thread.last_active_at,
        "project_id": thread.project_id,
    }


def _serialize_project(project: thread_store.Project) -> dict[str, Any]:
    return {
        "id": project.id,
        "name": project.name,
        "color": project.color,
        "created_at": project.created_at,
    }


async def _memory_review_loop() -> None:
    """Runs forever: sleeps until the next local midnight, then runs one
    memory_review_agent pass. Local time (this Mac's own clock), not UTC —
    the user's own known timezone fact is IST, and "00:00" means midnight
    where they actually are. Exceptions inside a single pass are caught and
    logged rather than left to propagate, so one bad run (e.g. a transient
    Anthropic API error) doesn't kill the loop for the rest of the server
    process's lifetime — the same "tool errors are data, not exceptions"
    posture this project applies everywhere else, applied here to an
    unattended background task instead of a tool call."""
    while True:
        now = datetime.now()
        next_midnight = (now + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        await asyncio.sleep((next_midnight - now).total_seconds())
        try:
            queued = await memory_review_agent.run_nightly_review(conversation_db_path=CONVERSATION_DB_PATH)
            print(f"[memory-review] queued {queued} pending fact proposal(s)")
        except Exception as exc:  # noqa: BLE001 - see docstring
            print(f"[memory-review] nightly run failed: {exc}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Own the checkpointer for the server's process lifetime, same
    contract main.py's `async with get_checkpointer()` block has — opened
    once, not per-request."""
    try:
        mcp_tools = await load_mcp_tools()
    except Exception:  # e.g. GMAIL_MCP_SERVER_PATH unset, server not built
        mcp_tools = []

    async with get_checkpointer(CONVERSATION_DB_PATH) as checkpointer:
        graph = build_graph(checkpointer, [send_test_notification], mcp_tools)
        app.state.graph = graph
        # PLAN.md Phase 24: separate, checkpointer-less specialist graphs
        # for the automation-fire endpoint to invoke directly via
        # _invoke_agent_graph — deliberately NOT reused from build_graph()'s
        # own internal ones (it doesn't expose them), so this is a second,
        # independent construction. Cheap (no I/O beyond model client
        # setup, same reasoning every build_*_agent() call already is) and
        # scoped only to AUTOMATION_ELIGIBLE_ACTIONS' specialists — not all
        # five, since only messaging-shaped actions are automation-eligible.
        app.state.automation_specialist_graphs = {
            "mac_control_agent": build_mac_control_agent(),
            "life_admin_agent": build_life_admin_agent(mcp_tools),
        }
        # No longer a single fixed config (Phase 15) — every endpoint below
        # resolves its own thread_id per-request instead, since which
        # thread is "active" can now change between requests (a switch, a
        # new thread) within the same server process lifetime.
        # Phase 14 streaming: one in-flight asyncio.Task per thread_id, so
        # /chat/stop can find and cancel it. A plain dict is safe here —
        # this server is single-process (uvicorn, no worker pool).
        app.state.active_tasks = {}
        # Cross-request trace linking for gated actions: /chat and /resume
        # are separate HTTP requests, potentially minutes apart while a
        # human looks at the confirmation card — unlike main.py/voice_daemon
        # .py's single Python while-loop, there's no one function scope to
        # wrap both calls in. `_stream_turn` stores the W3C traceparent for
        # the span active when a turn suspends on interrupt(), keyed by
        # thread_id; `/resume` reattaches it (observability.
        # attached_parent_context(), the same technique fa_service.py
        # already uses for its own cross-process trace nesting) so the
        # resume's trace becomes a real child of the original call's span
        # instead of a new sibling root. A plain dict, same reasoning as
        # active_tasks above.
        app.state.pending_trace_headers = {}
        review_task = asyncio.create_task(_memory_review_loop())
        try:
            yield
        finally:
            review_task.cancel()


app = FastAPI(lifespan=lifespan)

# Explicit origin allowlist, NOT "*" — this server can trigger real
# side-effect-capable tool calls (behind the interrupt gate, but even the
# read/reasoning path isn't something an arbitrary web page should be able
# to poke at). A wildcard would let any site the user visits in their
# regular browser issue cross-origin POSTs to a server listening on
# localhost. Only the dashboard's own known origins are allowed: the Vite
# dev server (STEPS.md 56's `npm run tauri dev`) and Tauri's production
# webview origins (macOS: tauri://localhost; Windows, listed defensively
# even though Windows isn't this project's target platform: http://tauri.localhost).
DASHBOARD_ORIGINS = [
    "http://localhost:1420",
    "tauri://localhost",
    "http://tauri.localhost",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=DASHBOARD_ORIGINS,
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type"],
)


@app.post("/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    # Thread resolution happens BEFORE the stream starts, not inside the
    # generator — an unknown explicit thread_id must still be a normal 404
    # response (SSE only starts once we've already committed to a 200,
    # since HTTP headers/status can't change after the body starts).
    thread_id = await _resolve_thread_id(request.thread_id)
    input_ = {"messages": [("user", _build_user_content(request.message, request.attachments))]}
    return StreamingResponse(
        _stream_turn(app.state.graph, thread_id, input_), media_type="text/event-stream"
    )


@app.post("/uploads")
async def upload_file(file: UploadFile = File(...)) -> dict[str, Any]:
    """Accepts one file, validates it, and stores it under workspace/uploads/
    — see the upload security-model comment above ChatRequest for the two
    invariants this must preserve. Returns a reference the client echoes
    back on /chat as an Attachment; nothing here touches the graph."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="missing filename")

    ext = ("." + file.filename.rsplit(".", 1)[-1].lower()) if "." in file.filename else ""
    is_image = (file.content_type or "") in ALLOWED_IMAGE_MIME
    is_document = ext in ALLOWED_DOCUMENT_EXT

    if not is_image and not is_document:
        if (file.content_type or "").startswith("image/"):
            raise HTTPException(
                status_code=415,
                detail=(
                    f"unsupported image type '{file.content_type}' — Claude accepts "
                    f"{sorted(ALLOWED_IMAGE_MIME)} only. Convert to JPEG or PNG first "
                    "(HEIC photos need converting)."
                ),
            )
        raise HTTPException(
            status_code=415,
            detail=f"unsupported file type '{ext or file.content_type}'",
        )

    max_bytes = MAX_IMAGE_BYTES if is_image else MAX_DOCUMENT_BYTES
    # Streamed in chunks and aborted at the cap rather than trusting
    # Content-Length (a lying header can't fill the disk).
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(1_048_576):
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"file exceeds {max_bytes} byte limit for {'images' if is_image else 'documents'}",
            )
        chunks.append(chunk)
    raw = b"".join(chunks)
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")

    if is_image:
        # Downsample to IMAGE_MAX_LONG_EDGE before storing — see the
        # constant's own comment for the cost rationale. Re-encoded to the
        # original format so mime_type stays accurate.
        with Image.open(BytesIO(raw)) as img:
            img.load()
            long_edge = max(img.size)
            if long_edge > IMAGE_MAX_LONG_EDGE:
                scale = IMAGE_MAX_LONG_EDGE / long_edge
                img = img.resize(
                    (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
                    Image.LANCZOS,
                )
            buf = BytesIO()
            fmt = {"image/jpeg": "JPEG", "image/png": "PNG", "image/gif": "GIF", "image/webp": "WEBP"}[
                file.content_type
            ]
            img.save(buf, format=fmt)
            raw = buf.getvalue()

    today = datetime.now(UTC).strftime("%Y-%m-%d")
    safe_name = _sanitize_upload_filename(file.filename)
    rel_path = f"uploads/{today}/{uuid.uuid4().hex[:8]}_{safe_name}"
    resolved = _resolve_in_workspace(rel_path)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_bytes(raw)

    return {
        "id": resolved.stem,
        "path": rel_path,
        "filename": file.filename,
        "mime_type": file.content_type or "application/octet-stream",
        "size": len(raw),
        "kind": "image" if is_image else "document",
    }


@app.post("/voice/transcribe")
async def voice_transcribe(file: UploadFile = File(...)) -> dict[str, str]:
    """iPhone-access feature: the phone's browser records via the Web
    Audio/MediaRecorder API (whatever format Safari produces — webm/opus
    or mp4/aac) and uploads the blob here. Reuses the exact same
    mlx-whisper model the Mac's own voice daemon uses (voice_io.py's
    `transcribe_file`, a sibling of `transcribe()` that accepts a file path
    instead of an already-decoded buffer) — not a second STT pipeline, one
    model reached two ways. The transcript is returned as plain text; the
    client sends it through the normal /chat path exactly like a typed
    message, so nothing downstream of this endpoint needs to know a
    request came from voice.

    `voice_io` is imported LAZILY here, not at module top level — it pulls
    in mlx_whisper/sounddevice (real, already-proven-installed
    dependencies per voice_daemon.py, but a genuinely heavier import),
    and the common case (typing, not talking) shouldn't pay that startup
    cost on every server boot for a feature it never uses.

    `ffmpeg` on PATH is a hard requirement (voice_io.transcribe_file's own
    docstring) — surfaced here as a clear 502 rather than a bare stack
    trace, since "ffmpeg missing" is a real, expected first-run gap for
    anyone following the iPhone-access setup steps out of order."""
    from assistant.voice_io import transcribe_file

    if not file.content_type or not file.content_type.startswith("audio/"):
        raise HTTPException(
            status_code=415, detail=f"expected an audio upload, got '{file.content_type}'"
        )

    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(1_048_576):
        total += len(chunk)
        if total > MAX_VOICE_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413, detail=f"recording exceeds {MAX_VOICE_UPLOAD_BYTES} byte limit"
            )
        chunks.append(chunk)
    raw = b"".join(chunks)
    if not raw:
        return {"text": ""}

    # NamedTemporaryFile, not workspace/ — this is ephemeral audio for STT
    # only, never content the agent or a file tool should see, deleted
    # unconditionally once transcription finishes (or fails).
    suffix = "." + file.filename.rsplit(".", 1)[-1] if file.filename and "." in file.filename else ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name
    try:
        text = await asyncio.to_thread(transcribe_file, tmp_path)
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"transcription failed ({type(exc).__name__}: {exc})"
        ) from exc
    finally:
        os.unlink(tmp_path)

    return {"text": text}


@app.post("/resume")
async def resume(request: ResumeRequest) -> StreamingResponse:
    thread_id = await _resolve_thread_id(request.thread_id)
    # Read the pending interrupt's payload BEFORE resuming, purely to
    # extract its `action` for scoring (STEPS.md 82, evaluations pillar) —
    # same aget_state()/state.tasks[*].interrupts read _stream_turn itself
    # already does at the end of a turn, just done here first since the
    # action needs to be known before the resume call that resolves it.
    state = await app.state.graph.aget_state(make_thread_config(thread_id))
    pending = [i for t in state.tasks for i in t.interrupts]
    action = (
        pending[0].value.get("action")
        if pending and isinstance(pending[0].value, dict)
        else None
    )
    return StreamingResponse(
        _stream_turn(
            app.state.graph,
            thread_id,
            Command(resume=request.approved),
            gate_outcome=(request.approved, action),
            is_resume=True,
        ),
        media_type="text/event-stream",
    )


_PHONE_CHANNEL_MARKER = (
    "[This message was sent from the user's iPhone via the Action Button / "
    "Share Sheet — for opening an app, opening a URL, or a WhatsApp compose "
    "draft, use phone_agent's own tools (open_app_on_phone/open_url_on_phone), "
    "which act on THIS phone, not mac_control_agent's Mac-only equivalents "
    "(open_app/open_url_in_brave/compose_whatsapp), which would act on the "
    "user's Mac somewhere else instead — the wrong device for a request "
    "made from the phone in hand.]"
)


@app.post("/phone/turn")
async def phone_turn(request: PhoneTurnRequest) -> dict[str, Any]:
    """PLAN.md Phase 21: the Action Button / Share Sheet entry point —
    Shortcuts' `Dictate Text` (or a Share Sheet photo/link, uploaded first
    via the existing `POST /uploads` and referenced as an attachment
    exactly like the dashboard composer does) posts here and gets one JSON
    reply back to feed into `Speak Text`. Non-streaming sibling of /chat —
    see `_run_turn`'s docstring for the interrupt-handling contract, which
    differs from /chat's in one deliberate way (text-only gates
    auto-decline instead of surfacing).

    Prepends `_PHONE_CHANNEL_MARKER` (PLAN.md Phase 22) — a real gap found
    while wiring the messaging cluster: without an explicit signal, the
    supervisor has no way to know a request came from the phone rather
    than the Mac dashboard/CLI/voice, and could route an "open Spotify" or
    "message Mom on WhatsApp" request to mac_control_agent's Mac-only
    open_app/compose_whatsapp — which would act on the Mac sitting
    elsewhere, not the phone actually in the user's hand. This marker is
    plain context text the model reads, same trust tier as everything else
    in its own turn (not a directive from untrusted content — it's
    server-constructed, not user- or tool-supplied)."""
    thread_id = await _resolve_thread_id(request.thread_id)
    message = _PHONE_CHANNEL_MARKER + "\n\n" + request.message
    if request.location:
        message += f"\n\n[Current location, from the phone: {request.location}]"
    input_ = {"messages": [("user", _build_user_content(message, request.attachments))]}
    return await _run_turn(app.state.graph, thread_id, input_)


@app.post("/phone/resume")
async def phone_resume(request: PhoneResumeRequest) -> dict[str, Any]:
    """Answers a `voice_approvable: True` gate reached via /phone/turn —
    the Shortcut speaks the interrupt payload's `spoken_prompt`, Dictates a
    yes/no, and posts the result here. A second endpoint rather than
    folding into /resume itself: this channel is single-shot JSON, not
    SSE, and the two response shapes shouldn't be conflated. Mirrors
    /resume's own action-lookup-before-resuming pattern exactly."""
    thread_id = await _resolve_thread_id(request.thread_id)
    state = await app.state.graph.aget_state(make_thread_config(thread_id))
    pending = [i for t in state.tasks for i in t.interrupts]
    action = (
        pending[0].value.get("action")
        if pending and isinstance(pending[0].value, dict)
        else None
    )
    return await _run_turn(
        app.state.graph,
        thread_id,
        Command(resume=request.approved),
        gate_outcome=(request.approved, action),
        is_resume=True,
    )


@app.post("/phone/health-sync")
async def phone_health_sync(request: PhoneHealthSyncRequest) -> dict[str, Any]:
    """PLAN.md Phase 21: the health-sync Shortcut's own POST target — runs
    only when the user manually triggers it, never automatically. Stores
    the pushed content as phone_agent's `get_latest_health_snapshot` tool
    will read it back; overwrites whatever was there before (phone_store.py's
    module docstring — only the latest snapshot per kind is ever kept)."""
    snapshot = await phone_store.save_snapshot("health", request.content)
    return {"kind": snapshot.kind, "synced_at": snapshot.synced_at}


@app.post("/a2ui/action")
async def a2ui_action(request: A2UIActionRequest) -> StreamingResponse:
    """Phase 17 Part B: an interactive A2UI surface's Button reports back
    here — see assistant/a2ui.py's module docstring for the full security
    reasoning. Built as a PLAIN `("user", ...)` turn, the exact same shape
    /chat uses for a typed message (not a tool result, not a synthetic
    graph-inserted marker) — deliberately: the user genuinely typed/picked
    these values on their own screen and clicked submit, which is at least
    as trustworthy as free-text chat input, and treating it identically
    means every existing turn-boundary mechanism (write caps, upfront-
    confirmation windows, compaction, memory-extraction scoping — all keyed
    off `is_genuine_human_turn`) handles it correctly for free, with zero
    special-casing. Whatever the agent decides to do in response — including
    any real side effect — still goes through the exact same gated tools and
    interrupt() this turn would hit from a typed chat message; this endpoint
    creates no new path to a side effect, only a new way to start an
    ordinary turn.
    """
    thread_id = await _resolve_thread_id(request.thread_id)
    message = (
        f"[UI interaction] The user submitted the {request.name!r} action on the "
        f"rendered UI surface {request.surface_id!r}, with these values: "
        f"{json.dumps(request.context)}"
    )
    input_ = {"messages": [("user", message)]}
    return StreamingResponse(
        _stream_turn(app.state.graph, thread_id, input_), media_type="text/event-stream"
    )


@app.post("/chat/stop")
async def stop_chat(request: StopRequest) -> dict[str, Any]:
    """Cancel whatever turn is currently streaming for a thread, if any.
    See `_stream_turn`'s docstring for what cancellation actually leaves
    behind in the checkpointer."""
    thread_id = await _resolve_thread_id(request.thread_id)
    task = app.state.active_tasks.get(thread_id)
    if task is None or task.done():
        return {"stopped": False}
    task.cancel()
    return {"stopped": True}


@app.get("/activity/active")
async def list_active_turns() -> dict[str, Any]:
    """Every currently in-flight agent turn, across ALL channels (dashboard,
    voice, phone, unattended automations) — polled by the dashboard's
    persistent activity indicator (PLAN.md, STEPS.md 122) so a long-running
    or stuck turn is visible regardless of which tab is open or which
    channel started it. See `assistant/active_turns.py`'s module docstring
    for exactly what "in-flight" covers and its one accepted scope gap
    (specialist-internal activity isn't tracked, only the top-level
    supervisor/specialist-delegation view).

    Also returns `recently_ended` — turns that ended (any outcome) within
    the last 30s, the follow-up to the above that closes a related gap: a
    turn started by voice/phone/an automation that ends abnormally was
    otherwise invisible to every OTHER tab/channel the instant it dropped
    out of `active`, with nothing distinguishing "finished fine" from "just
    broke." See `active_turns.list_recent()`'s own docstring."""
    return {"active": active_turns.list_active(), "recently_ended": active_turns.list_recent()}


@app.get("/threads")
async def list_threads() -> dict[str, Any]:
    threads = await thread_store.list_threads(db_path=thread_store.DEFAULT_DB_PATH)
    active_thread_id = await thread_store.get_active_thread_id(db_path=thread_store.DEFAULT_DB_PATH)
    return {
        "threads": [_serialize_thread(t) for t in threads],
        "active_thread_id": active_thread_id,
    }


@app.post("/threads")
async def create_thread(request: CreateThreadRequest) -> dict[str, Any]:
    thread = await thread_store.create_thread(title=request.title, db_path=thread_store.DEFAULT_DB_PATH)
    return _serialize_thread(thread)


@app.post("/threads/active")
async def set_active_thread(request: SetActiveThreadRequest) -> dict[str, Any]:
    try:
        thread = await thread_store.set_active_thread(
            request.thread_id, db_path=thread_store.DEFAULT_DB_PATH
        )
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No thread with id {request.thread_id}")
    return _serialize_thread(thread)


@app.patch("/threads/{thread_id}")
async def rename_thread(thread_id: str, request: RenameThreadRequest) -> dict[str, Any]:
    try:
        thread = await thread_store.rename_thread(
            thread_id, request.title, db_path=thread_store.DEFAULT_DB_PATH
        )
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No thread with id {thread_id}")
    return _serialize_thread(thread)


@app.delete("/threads/{thread_id}")
async def delete_thread(thread_id: str) -> dict[str, Any]:
    """Does not purge the thread's own conversation_memory.sqlite checkpoint
    rows — see thread_store.delete_thread's docstring for why. Returns the
    active_thread_id AFTER deletion, since deleting the currently-active
    thread reassigns the pointer (thread_store's "always exactly one active
    thread" invariant) — the caller needs to know what it's now looking at."""
    try:
        active_thread_id = await thread_store.delete_thread(
            thread_id, db_path=thread_store.DEFAULT_DB_PATH
        )
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No thread with id {thread_id}")
    return {"deleted": True, "active_thread_id": active_thread_id}


@app.patch("/threads/{thread_id}/project")
async def assign_thread_project(thread_id: str, request: AssignThreadProjectRequest) -> dict[str, Any]:
    """Both of Phase 28's UI paths (the tree's "Move to project" row
    action and drag-and-drop) call this same endpoint — it's a plain
    proxy to thread_store.assign_thread_project's own dual-error
    behavior (KeyError for a bad thread_id, ValueError for a bad
    project_id), which server.py resolves into the same 404 shape either
    way since the client only needs to know the request failed."""
    try:
        thread = await thread_store.assign_thread_project(
            thread_id, request.project_id, db_path=thread_store.DEFAULT_DB_PATH
        )
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No thread with id {thread_id}")
    except ValueError:
        raise HTTPException(status_code=404, detail=f"No project with id {request.project_id}")
    return _serialize_thread(thread)


@app.get("/projects")
async def list_projects() -> dict[str, Any]:
    projects = await thread_store.list_projects(db_path=thread_store.DEFAULT_DB_PATH)
    return {"projects": [_serialize_project(p) for p in projects]}


@app.post("/projects")
async def create_project(request: CreateProjectRequest) -> dict[str, Any]:
    project = await thread_store.create_project(request.name, db_path=thread_store.DEFAULT_DB_PATH)
    return _serialize_project(project)


@app.patch("/projects/{project_id}")
async def rename_project(project_id: str, request: RenameProjectRequest) -> dict[str, Any]:
    try:
        project = await thread_store.rename_project(
            project_id, request.name, db_path=thread_store.DEFAULT_DB_PATH
        )
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No project with id {project_id}")
    return _serialize_project(project)


@app.delete("/projects/{project_id}")
async def delete_project(project_id: str) -> dict[str, Any]:
    """Unassigns rather than deletes every Thread in this Project
    (PLAN.md Phase 28 Decision 4) — see thread_store.delete_project's own
    docstring for why."""
    try:
        await thread_store.delete_project(project_id, db_path=thread_store.DEFAULT_DB_PATH)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"No project with id {project_id}")
    return {"deleted": True}


@app.get("/history")
async def history() -> dict[str, Any]:
    """Read the active thread's persisted state via the public
    `graph.aget_state()` API — not by hand-parsing the checkpointer's own
    serialized SQLite rows (STEPS.md 54 flagged this as real parsing work
    the wrong way to do it). Always follows the active pointer (Phase 15):
    a GUI picker switches threads via POST /threads/active, then re-calls
    this — /history itself doesn't take a thread_id override, since viewing
    a thread IS what "make it active" means for this endpoint's one caller
    (the History panel)."""
    thread_id = await thread_store.get_active_thread_id(db_path=thread_store.DEFAULT_DB_PATH)
    snapshot = await app.state.graph.aget_state(make_thread_config(thread_id))
    messages: list[BaseMessage] = snapshot.values.get("messages", [])
    return {
        "messages": [
            {
                "role": _message_role(m),
                "content": _render_content(m.content),
                "synthetic": _is_synthetic(m),
                # The message's own `.name` — semantics depend on role,
                # checked against real output rather than assumed (STEPS.md
                # 58): on a ToolMessage it's the tool that ran (e.g.
                # "send_test_notification"); on an AIMessage in this
                # multi-agent graph it's which node produced the reply
                # (e.g. "supervisor" vs "coding_agent" — supervisor.py's
                # own node names, set by LangGraph's multi-agent
                # machinery). None on a genuine user HumanMessage. The
                # (full-fidelity, unlike the chat panel) History panel
                # surfaces whatever is here rather than assuming only
                # tools have one.
                "name": getattr(m, "name", None),
                # Phase 18 (PLAN.md): the FULL A2UI surface(s) this
                # ToolMessage carries — either render_ui's own direct call,
                # or a specialist-delegation tool forwarding what a
                # sub-agent rendered during its own isolated run
                # (supervisor.py's call_specialist / _invoke_agent_graph).
                # Read straight back from additional_kwargs (assistant/
                # a2ui.py's A2UI_SURFACE_KEY), never re-derived or
                # re-summarized, same verbatim-relay posture this module's
                # docstring already holds interrupt payloads to. Always a
                # list (possibly empty/absent); the client decides what to
                # do with it (ChatPanel groups it onto the turn's closing
                # bubble, HistoryPanel shows it inline on this exact row).
                "surfaces": getattr(m, "additional_kwargs", {}).get(A2UI_SURFACE_KEY) or [],
            }
            for m in messages
        ],
        "thread_id": thread_id,
    }


@app.get("/memory/facts")
async def list_memory_facts() -> dict[str, Any]:
    facts = await memory_store.list_facts()
    return {
        "facts": [
            {
                "id": f.id,
                "content": f.content,
                "provenance": f.provenance,
                "created_at": f.created_at,
            }
            for f in facts
        ]
    }


class CreateMemoryFactRequest(BaseModel):
    content: str


class UpdateMemoryFactRequest(BaseModel):
    content: str


@app.post("/memory/facts")
async def create_memory_fact(request: CreateMemoryFactRequest) -> dict[str, Any]:
    """User-authored fact, typed directly into the Memory panel — not an
    agent proposal, so this deliberately does NOT go through interrupt()
    either (same reasoning as delete_memory_fact/update_memory_fact below:
    the gate in memory_extraction.py exists for the agent's own autonomous
    writes, not the user adding to their own store). provenance="user"
    marks it apart from an agent-derived fact's None/"from X result" so the
    panel can label its origin."""
    content = request.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="content must not be empty")
    fact_id = await memory_store.save_fact(content, provenance="user")
    return {
        "id": fact_id,
        "content": content,
        "provenance": "user",
    }


@app.patch("/memory/facts/{fact_id}")
async def update_memory_fact(fact_id: int, request: UpdateMemoryFactRequest) -> dict[str, Any]:
    """User editing their own already-saved fact — same non-gated curation
    category as delete_memory_fact below."""
    content = request.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="content must not be empty")
    updated = await memory_store.update_fact(fact_id, content)
    if not updated:
        raise HTTPException(status_code=404, detail=f"No fact with id {fact_id}")
    return {"id": fact_id, "content": content}


@app.delete("/memory/facts/{fact_id}")
async def delete_memory_fact(fact_id: int) -> dict[str, Any]:
    """User-initiated deletion of their own already-saved fact — curation,
    not a new agent side effect, so this deliberately does NOT go through
    interrupt() (that gate is for the agent writing autonomously; see
    memory_extraction.py's docstring). No confirmation-gate change implied."""
    deleted = await memory_store.delete_fact(fact_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"No fact with id {fact_id}")
    return {"deleted": True}


# --- Nightly memory review queue (memory_review_agent.py) -------------------


@app.get("/memory/pending")
async def list_pending_memory_facts() -> dict[str, Any]:
    """Cards for the Memory panel's review queue — candidates
    memory_review_agent.py's nightly pass proposed, awaiting an explicit
    approve/decline. This IS the confirmation gate for memory writes now
    (see memory_extraction.py's module docstring); nothing here has been
    saved as a real, recalled fact yet."""
    pending = await memory_store.list_pending_facts()
    return {
        "pending": [
            {
                "id": p.id,
                "content": p.content,
                "provenance": p.provenance,
                "created_at": p.created_at,
            }
            for p in pending
        ]
    }


@app.post("/memory/pending/{pending_id}/approve")
async def approve_pending_memory_fact(pending_id: int) -> dict[str, Any]:
    """The actual confirmation click: moves a proposal into the real facts
    table verbatim. Not behind interrupt() — this endpoint IS the human
    approval, same as every other user-initiated memory_store call above."""
    fact = await memory_store.approve_pending_fact(pending_id)
    if fact is None:
        raise HTTPException(status_code=404, detail=f"No pending fact with id {pending_id}")
    return {
        "id": fact.id,
        "content": fact.content,
        "provenance": fact.provenance,
        "created_at": fact.created_at,
    }


@app.post("/memory/pending/{pending_id}/decline")
async def decline_pending_memory_fact(pending_id: int) -> dict[str, Any]:
    declined = await memory_store.decline_pending_fact(pending_id)
    if not declined:
        raise HTTPException(status_code=404, detail=f"No pending fact with id {pending_id}")
    return {"declined": True}


@app.post("/memory/review/run-now")
async def run_memory_review_now() -> dict[str, Any]:
    """Manual trigger for memory_review_agent's nightly pass — the same
    function _memory_review_loop calls at midnight, exposed here as an
    on-demand "check now" affordance and so this can be live-verified
    without waiting for an actual midnight."""
    queued = await memory_review_agent.run_nightly_review(conversation_db_path=CONVERSATION_DB_PATH)
    return {"queued": queued}


def _serialize_board_item(item: board_store.BoardItem) -> dict[str, Any]:
    return {
        "id": item.id,
        "column": item.column,
        "ref": item.ref,
        "priority": item.priority,
        "title": item.title,
        "description": item.description,
        "position": item.position,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


class CreateBoardTaskRequest(BaseModel):
    column: str
    title: str
    description: str = ""
    priority: str = "medium"


class UpdateBoardTaskRequest(BaseModel):
    """Open-ended: any subset of fields. Presence of `column` means "move
    this task" (board_store.move_item); any of title/description/priority
    present ALSO means "edit these fields" (board_store.update_item) —
    both can apply to the same request, e.g. a drag-and-drop that also
    changes priority in one PATCH."""

    column: str | None = None
    position: int | None = None
    title: str | None = None
    description: str | None = None
    priority: str | None = None


@app.get("/board/tasks")
async def list_board_tasks() -> dict[str, Any]:
    """Kanban board state — same store both the dashboard's Board tab and
    life_admin_agent's board_tools.py read/write, full access per the
    user's explicit request (see board_tools.py's own docstring for why
    this is deliberately ungated, unlike email/calendar/filter writes)."""
    items = await board_store.list_items()
    return {"tasks": [_serialize_board_item(i) for i in items]}


@app.post("/board/tasks")
async def create_board_task(request: CreateBoardTaskRequest) -> dict[str, Any]:
    try:
        item = await board_store.create_item(
            column=request.column,
            title=request.title,
            description=request.description,
            priority=request.priority,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _serialize_board_item(item)


@app.patch("/board/tasks/{task_id}")
async def update_board_task(task_id: str, request: UpdateBoardTaskRequest) -> dict[str, Any]:
    try:
        if request.column is not None:
            await board_store.move_item(task_id, column=request.column, position=request.position)
        if request.title is not None or request.description is not None or request.priority is not None:
            item = await board_store.update_item(
                task_id,
                title=request.title,
                description=request.description,
                priority=request.priority,
            )
        else:
            items = await board_store.list_items()
            item = next(i for i in items if i.id == task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"No task with id {task_id}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _serialize_board_item(item)


@app.delete("/board/tasks/{task_id}")
async def delete_board_task(task_id: str) -> dict[str, Any]:
    """User-initiated deletion of their own task — same reasoning as
    delete_memory_fact above: curation of the user's own data, not a new
    agent-authored side effect, so no confirmation gate."""
    try:
        await board_store.delete_item(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"No task with id {task_id}") from exc
    return {"deleted": True}


# --- Unattended pre-approved automations (PLAN.md Phase 24) -----------------


def _serialize_automation(a: automation_store.Automation) -> dict[str, Any]:
    return {
        "id": a.id,
        "name": a.name,
        "trigger_description": a.trigger_description,
        "target": a.target,
        "goal": a.goal,
        "action": a.action,
        "enabled": a.enabled,
        "created_at": a.created_at,
        "updated_at": a.updated_at,
    }


def _serialize_run(r: automation_store.AutomationRun) -> dict[str, Any]:
    return {
        "id": r.id,
        "automation_id": r.automation_id,
        "fired_at": r.fired_at,
        "outcome": r.outcome,
        "detail": r.detail,
    }


class CreateAutomationRequest(BaseModel):
    name: str
    trigger_description: str
    target: str
    goal: str
    action: str


class UpdateAutomationRequest(BaseModel):
    name: str | None = None
    trigger_description: str | None = None
    target: str | None = None
    goal: str | None = None
    action: str | None = None
    enabled: bool | None = None


@app.get("/automations")
async def list_automations() -> dict[str, Any]:
    automations = await automation_store.list_automations()
    return {"automations": [_serialize_automation(a) for a in automations]}


@app.post("/automations")
async def create_automation(request: CreateAutomationRequest) -> dict[str, Any]:
    if request.action not in AUTOMATION_ELIGIBLE_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"action must be one of {sorted(AUTOMATION_ELIGIBLE_ACTIONS)} — "
                "unattended pre-approval is deliberately scoped to messaging-shaped "
                "actions only (PLAN.md Phase 24), not the full GATED_ACTIONS set"
            ),
        )
    automation = await automation_store.create_automation(
        name=request.name,
        trigger_description=request.trigger_description,
        target=request.target,
        goal=request.goal,
        action=request.action,
    )
    return _serialize_automation(automation)


@app.patch("/automations/{automation_id}")
async def update_automation(automation_id: str, request: UpdateAutomationRequest) -> dict[str, Any]:
    if request.action is not None and request.action not in AUTOMATION_ELIGIBLE_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"action must be one of {sorted(AUTOMATION_ELIGIBLE_ACTIONS)}",
        )
    try:
        automation = await automation_store.update_automation(
            automation_id,
            name=request.name,
            trigger_description=request.trigger_description,
            target=request.target,
            goal=request.goal,
            action=request.action,
            enabled=request.enabled,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"No automation with id {automation_id}") from exc
    return _serialize_automation(automation)


@app.delete("/automations/{automation_id}")
async def delete_automation(automation_id: str) -> dict[str, Any]:
    try:
        await automation_store.delete_automation(automation_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"No automation with id {automation_id}") from exc
    return {"deleted": True}


@app.get("/automations/runs")
async def list_automation_runs() -> dict[str, Any]:
    runs = await automation_store.list_runs()
    return {"runs": [_serialize_run(r) for r in runs]}


@app.post("/automations/{automation_id}/fire")
async def fire_automation(automation_id: str) -> dict[str, Any]:
    """The geofence-detecting Shortcut's own POST target (PHONE_SETUP.md)
    — the ENTIRE unattended-execution path lives in this one function.

    **No `interrupt()` call exists anywhere in this function or anything
    it calls with these arguments — that absence is intentional (this IS
    the pre-approval this whole phase exists to provide), not an
    oversight.** Reuses `_invoke_agent_graph` (supervisor.py) — the exact
    same mechanism every other specialist delegation already uses — with
    `pre_approved_actions={automation.action}`, so the target specialist's
    own gated tool (`send_imessage`/`send_email`) sees its action already
    cleared via the SAME `GatedAgentState.pre_approved_actions` check a
    live upfront-confirmed turn would set, and proceeds without calling
    `interrupt()` itself either. Every firing is logged via
    `automation_store.log_run` regardless of outcome — the
    reviewable-after-the-fact record this execution path substitutes for
    a before-the-fact confirmation."""
    automation = await automation_store.get_automation(automation_id)
    if automation is None:
        raise HTTPException(status_code=404, detail=f"No automation with id {automation_id}")

    if not automation.enabled:
        await automation_store.log_run(automation_id, outcome="skipped", detail="automation is disabled")
        return {"outcome": "skipped", "detail": "automation is disabled"}

    recent_runs = await automation_store.list_runs(automation_id)
    last_fired = next((r for r in recent_runs if r.outcome == "fired"), None)
    if last_fired is not None:
        elapsed = datetime.now(UTC) - datetime.fromisoformat(last_fired.fired_at)
        if elapsed < AUTOMATION_FIRE_COOLDOWN:
            detail = (
                f"cooldown active — last fired {last_fired.fired_at}, "
                f"retry after {AUTOMATION_FIRE_COOLDOWN} has elapsed"
            )
            await automation_store.log_run(automation_id, outcome="skipped", detail=detail)
            return {"outcome": "skipped", "detail": detail}

    specialist_name = GATED_ACTIONS.get(automation.action)
    specialist_graph = (
        app.state.automation_specialist_graphs.get(specialist_name) if specialist_name else None
    )
    if specialist_graph is None:
        detail = f"action {automation.action!r} has no automation-eligible specialist wired up"
        await automation_store.log_run(automation_id, outcome="error", detail=detail)
        return {"outcome": "error", "detail": detail}

    instruction = (
        f"{automation.goal}\n\nTarget: {automation.target}\n\n"
        "This request comes from a pre-approved automation the user themselves "
        f"registered in advance (PLAN.md Phase 24) — proceed directly with the "
        f"{automation.action} action it is scoped to; it does not need a fresh "
        "confirmation from you."
    )
    active_turns.start_turn(f"automation:{automation_id}", channel="automation", agent=specialist_name)
    turn_outcome: active_turns.Outcome = "completed"
    try:
        content, _surfaces, _phone_actions, _executed_actions = await _invoke_agent_graph(
            specialist_graph,
            specialist_name,
            [HumanMessage(content=instruction)],
            {automation.action},
        )
    except asyncio.CancelledError:
        turn_outcome = "cancelled"
        raise
    except Exception as exc:  # a real upstream failure — logged, not raised
        turn_outcome = "error"
        detail = f"{type(exc).__name__}: {exc}"
        await automation_store.log_run(automation_id, outcome="error", detail=detail)
        return {"outcome": "error", "detail": detail}
    finally:
        active_turns.finish_turn(f"automation:{automation_id}", outcome=turn_outcome)

    await automation_store.log_run(automation_id, outcome="fired", detail=content)
    return {"outcome": "fired", "detail": content}


# --- Workflow runs (PLAN.md Phase 25) --------------------------------------
#
# Read-only from this API's side — a workflow run is only ever CREATED by
# supervisor.py's propose_workflow tool (via a real /chat -> gate -> /resume
# round trip) and only ever UPDATED by supervisor.py's own
# _record_workflow_progress as specialist calls actually execute. There is
# no POST/PATCH/DELETE here by design: this endpoint exists purely to
# surface the approved-vs-executed audit (decision D3) in the dashboard's
# new Workflows tab (decision D10), not to let the dashboard drive workflow
# execution directly.


def _serialize_workflow_step(s: workflow_store.WorkflowStep) -> dict[str, Any]:
    return {
        "step_index": s.step_index,
        "action": s.action,
        "planned_summary": s.planned_summary,
        "executed_args": s.executed_args,
        "outcome": s.outcome,
        "detail": s.detail,
        "executed_at": s.executed_at,
        "diverged": s.diverged,
    }


def _serialize_workflow_run(r: workflow_store.WorkflowRun) -> dict[str, Any]:
    return {
        "id": r.id,
        "thread_id": r.thread_id,
        "goal": r.goal,
        "status": r.status,
        "created_at": r.created_at,
        "completed_at": r.completed_at,
        "steps": [_serialize_workflow_step(s) for s in r.steps],
    }


@app.get("/workflows")
async def list_workflows(thread_id: str | None = None) -> dict[str, Any]:
    runs = await workflow_store.list_runs(thread_id=thread_id)
    return {"workflows": [_serialize_workflow_run(r) for r in runs]}


@app.get("/workflows/{run_id}")
async def get_workflow(run_id: str) -> dict[str, Any]:
    run = await workflow_store.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"No workflow run with id {run_id}")
    return _serialize_workflow_run(run)


# --- Claude Code sessions (2026-08-06) --------------------------------------
#
# Read-only, same reasoning as the Workflows section above: run_claude_code
# (assistant/claude_code_tool.py) is the only writer of these sessions —
# Claude Code's own CLI process writes the underlying .jsonl transcripts,
# not this server — so there is no POST/PATCH/DELETE here. Exists purely
# because Claude Code's own interactive session browser filters these
# sessions out (they're tagged entrypoint="sdk-cli", not an interactive
# terminal session) — see claude_code_sessions.py's own module docstring.


@app.get("/claude-code-sessions")
async def list_claude_code_sessions() -> dict[str, Any]:
    return {"sessions": claude_code_sessions.list_sessions()}


@app.get("/claude-code-sessions/{session_id}")
async def get_claude_code_session(session_id: str) -> dict[str, Any]:
    session = claude_code_sessions.read_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"No Claude Code session with id {session_id}")
    return session


@app.get("/cost")
async def cost() -> dict[str, Any]:
    """Token/cost tracking (PLAN.md Phase 9 step 6). Source swapped from
    LangSmith to Langfuse (2026-07-25): LangSmith's account-level monthly
    trace-ingestion quota silently stopped accepting new traces (PLAN.md
    Phase 19's finding, live-confirmed via a real 429 "Monthly unique
    traces usage limit exceeded"), and stayed exhausted for over a week
    with nothing fixable on this side — the gap was entirely upstream in
    what LangSmith accepted, not a bug in the aggregation call. Langfuse
    (Phase 16) is a completely separate ingestion pipeline that was already
    tracing every real call correctly the whole time (the v2->v3 migration's
    own fix for a token/cost bug), so it was never affected.

    Considered Anthropic's own Usage & Cost Admin API instead (real USD,
    not an estimate) — the more authoritative source in principle — but it
    requires the Console account to first be converted from an individual
    account into an Organization (Admin API keys don't exist for individual
    accounts; live-confirmed the documented Console path 401s/doesn't exist
    otherwise), a real account-structure change well beyond the scope of
    unblocking this panel. Left as a possible future upgrade.

    `total_cost`/`prompt_cost`/`completion_cost` remain an ESTIMATE —
    Langfuse's own recorded token counts × its maintained per-model price
    list — same caveat the LangSmith-backed version carried, just from an
    unblocked source, never a literal Anthropic invoice pull.

    Three windows, queried concurrently. `run_count` comes from
    `uniq(traceId)` over the "observations" view rather than a dedicated
    trace-count endpoint — see `_query_langfuse_cost_sync`'s docstring for
    why that's equivalent, verified live against the real project.

    NEVER throws for a degraded-but-recoverable Langfuse failure — the
    user's own direct ask, after an earlier version of this endpoint still
    just returned a bare 429/502 for a real, live-observed rate limit
    (Langfuse's own metrics API caps at 100 requests/window; this endpoint
    burns 3 per call, and normal dashboard traffic exhausted that well
    under a day). Every window ALWAYS gets a value: on a live failure, it
    falls back to `cost_cache.py`'s durable last-known-good snapshot
    (marked `stale: true`, with its own `read_at`), or to zeroed
    placeholders with `no_data: true` if nothing has ever been read yet.
    A 429 specifically is additionally surfaced as a top-level
    `rate_limited` object (message/retry_after_seconds/reset_at) so the
    frontend can show a real countdown — and once `cost_cache.py` knows
    we're inside that window, this skips calling Langfuse again entirely
    rather than spending another request just to get the same 429 back.
    The only real error left is the pre-flight 503 above: Langfuse never
    configured at all has no history to fall back to either."""
    client = observability.get_client()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Langfuse not configured (LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY missing or invalid)",
        )

    now = datetime.now(UTC)
    standing_rate_limit = cost_cache.get_rate_limit()
    skip_live_call = cost_cache.rate_limit_active(standing_rate_limit)

    def _stale_window(window_key: str) -> dict[str, Any]:
        cached = cost_cache.get_window(window_key)
        if cached is None:
            summary = _summarize_langfuse_row({})
            summary.update(stale=True, no_data=True, read_at=None)
        else:
            summary = _summarize_langfuse_row(cached["row"])
            summary.update(stale=True, no_data=False, read_at=cached["read_at"])
        return summary

    async def _window(
        window_key: str, delta: timedelta | None
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        if skip_live_call:
            return _stale_window(window_key), standing_rate_limit

        start = now - delta if delta else _ALL_TIME_START
        try:
            row = await asyncio.to_thread(_query_langfuse_cost_sync, client, start, now)
        except Exception as exc:
            rate_limit_info: dict[str, Any] | None = None
            if isinstance(exc, ApiError) and exc.status_code == 429 and isinstance(exc.body, dict):
                details = exc.body.get("details") or {}
                rate_limit_info = {
                    "message": exc.body.get("message", "Rate limit exceeded"),
                    "retry_after_seconds": details.get("retryAfterSeconds"),
                    "reset_at": details.get("resetAt"),
                }
                cost_cache.save_rate_limit(**rate_limit_info)
            return _stale_window(window_key), rate_limit_info

        read_at = cost_cache.save_window(window_key, row)
        summary = _summarize_langfuse_row(row)
        summary.update(stale=False, no_data=False, read_at=read_at)
        return summary, None

    results = await asyncio.gather(
        *(_window(key, delta) for key, delta in _COST_WINDOWS.items())
    )
    windows: dict[str, Any] = {}
    rate_limited: dict[str, Any] | None = None
    for key, (summary, rl) in zip(_COST_WINDOWS.keys(), results):
        windows[key] = summary
        if rl and rate_limited is None:
            rate_limited = rl

    return {
        "project": "langfuse",
        "windows": windows,
        "rate_limited": rate_limited,
    }


# iPhone-access feature: mounted LAST, deliberately — Starlette tries
# routes in registration order, and a root mount matches every path that
# isn't otherwise claimed, so every explicit @app.get/post route above
# MUST already be registered before this line or it would shadow them.
# `html=True` serves index.html both at "/" and as the fallback for any
# unmatched path, which is what lets the SPA's own client-side router
# handle deep links (e.g. a phone bookmark straight to a specific view)
# instead of 404ing at the server. Guarded on the directory actually
# existing so `pytest`/a dev checkout that's never run `npm run build`
# doesn't fail at import time — same defensive-construction posture as
# the Langfuse/MCP clients above, just for a static directory instead of
# a network client.
if DASHBOARD_DIST_PATH.is_dir():
    app.mount("/", StaticFiles(directory=DASHBOARD_DIST_PATH, html=True), name="dashboard")
