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
import json
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

from dotenv import load_dotenv

# Loaded before any other project import — same ordering reasoning as
# main.py: assistant.sub_agents/assistant.supervisor construct ChatAnthropic
# instances at module import time, so the environment must be populated
# first.
load_dotenv()

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from langchain_core.messages import BaseMessage  # noqa: E402
from langgraph.types import Command  # noqa: E402
from langsmith import Client as LangSmithClient  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from assistant import memory_store, observability, thread_store  # noqa: E402
from assistant.a2ui import A2UI_SURFACE_KEY  # noqa: E402
from assistant.agent import make_thread_config  # noqa: E402
from assistant.compaction import is_compaction_summary, is_genuine_human_turn  # noqa: E402
from assistant.interrupts import send_test_notification  # noqa: E402
from assistant.mcp_tools import load_mcp_tools  # noqa: E402
from assistant.memory import get_checkpointer  # noqa: E402
from assistant.supervisor import build_graph  # noqa: E402

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

# Same redirect story for the long-term facts DB — monkeypatches
# memory_store.DEFAULT_DB_PATH exactly the way memory_store's own tests
# already do (its docstring: a parameter default would bind too early to
# catch a later override, so it's resolved inside each function body).
if "ASSISTANT_MEMORY_DB_PATH" in os.environ:
    memory_store.DEFAULT_DB_PATH = os.environ["ASSISTANT_MEMORY_DB_PATH"]

# Same redirect story again, for Phase 15's thread registry/pointer DB.
if "ASSISTANT_THREADS_DB_PATH" in os.environ:
    thread_store.DEFAULT_DB_PATH = os.environ["ASSISTANT_THREADS_DB_PATH"]

# Matches CLAUDE.md's Tech stack section (LANGCHAIN_PROJECT=personal-assistant),
# read from the env rather than hardcoded so a differently-configured
# deployment still points at the right project.
LANGSMITH_PROJECT = os.environ.get("LANGCHAIN_PROJECT", "personal-assistant")

# Verified live against the real project before choosing this shape
# (STEPS.md 60): `Client.get_run_stats()` is a real server-side aggregation
# endpoint — 0.7s for 1358 runs, vs. 30+s to page through and sum
# `list_runs()` client-side, and that gap only grows as the thread's
# history does. `is_root=True` matches how the History/chat panels already
# think about "one turn" — LangSmith rolls a trace's full token/cost total
# up onto its root run, confirmed by cross-checking the manually-summed
# total against get_run_stats's own total for the same window (identical
# to the cent).
_COST_WINDOWS: dict[str, timedelta | None] = {
    "today": timedelta(hours=24),
    "week": timedelta(days=7),
    "all_time": None,
}


def _get_run_stats_sync(client: LangSmithClient, start_time: str | None) -> dict[str, Any]:
    """Blocking call (langsmith's Client is sync-only) — always run via
    asyncio.to_thread, never awaited directly, or it stalls every other
    concurrent request on this server for the ~1s this takes."""
    return client.get_run_stats(
        project_names=[LANGSMITH_PROJECT],
        is_root=True,
        start_time=start_time,
    )


def _summarize_run_stats(stats: dict[str, Any]) -> dict[str, Any]:
    return {
        "run_count": stats.get("run_count", 0),
        "total_tokens": stats.get("total_tokens", 0),
        "prompt_tokens": stats.get("prompt_tokens", 0),
        "completion_tokens": stats.get("completion_tokens", 0),
        "total_cost": stats.get("total_cost", 0.0),
        "prompt_cost": stats.get("prompt_cost", 0.0),
        "completion_cost": stats.get("completion_cost", 0.0),
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
        raise
    except Exception as exc:  # network errors, rate limits, etc. — data, not a crash
        yield _sse_event({"type": "error", "detail": f"{type(exc).__name__}: {exc}"})
    finally:
        app.state.active_tasks.pop(thread_id, None)


class ChatRequest(BaseModel):
    message: str
    # Optional (Phase 15): a client that manages its own conversation can
    # target a specific thread without touching the shared active pointer —
    # the actual fix for STEPS.md 66's collision. Omitted means "whatever
    # the active pointer currently says", preserving every pre-Phase-15
    # client's behavior exactly.
    thread_id: str | None = None


class ResumeRequest(BaseModel):
    approved: bool
    # Must match whichever thread_id the /chat call that produced the
    # pending interrupt used — same fallback-to-active-pointer default.
    thread_id: str | None = None


class StopRequest(BaseModel):
    thread_id: str | None = None


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
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Own the checkpointer for the server's process lifetime, same
    contract main.py's `async with get_checkpointer()` block has — opened
    once, not per-request."""
    try:
        mcp_tools = await load_mcp_tools()
    except Exception:  # e.g. GMAIL_MCP_SERVER_PATH unset, server not built
        mcp_tools = []

    try:
        # Constructed once for the process lifetime, same as the graph
        # below — NOT per-request. Wrapped defensively (unlike the graph,
        # which is load-bearing for every other endpoint): a missing
        # LANGSMITH_API_KEY or misconfigured account must not take down
        # chat/history/memory, which don't need LangSmith at all. /cost
        # checks for None and reports a clear "not configured" error
        # instead of the whole server failing to start.
        langsmith_client: LangSmithClient | None = LangSmithClient()
    except Exception:
        langsmith_client = None
    app.state.langsmith_client = langsmith_client

    async with get_checkpointer(CONVERSATION_DB_PATH) as checkpointer:
        graph = build_graph(checkpointer, [send_test_notification], mcp_tools)
        app.state.graph = graph
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
        yield


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
    input_ = {"messages": [("user", request.message)]}
    return StreamingResponse(
        _stream_turn(app.state.graph, thread_id, input_), media_type="text/event-stream"
    )


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


@app.get("/cost")
async def cost() -> dict[str, Any]:
    """Token/cost tracking (PLAN.md Phase 9 step 6) — real LangSmith
    aggregates, not computed from local pricing tables. Three windows,
    queried concurrently (each is an independent ~1s blocking call).

    The returned `total_cost` is LangSmith's OWN estimate (its recorded
    token counts × its maintained per-model price list) — not a pull from
    Anthropic's real invoice. Live-diagnosed (PLAN.md Phase 19, 2026-07-24):
    a window can legitimately read all-zero not because nothing ran, but
    because LangSmith's account-level ingestion quota was exceeded
    ("Monthly unique traces usage limit exceeded", a real 429 hit live
    against this project's own account) — new traces stop landing entirely
    until the plan is upgraded or the quota resets, while `get_run_stats`
    itself keeps working correctly and reporting exactly what LangSmith
    actually has. This function has no bug to fix for that case: it already
    reflects LangSmith's true stored state; the gap is upstream, in what
    LangSmith accepted."""
    client = app.state.langsmith_client
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="LangSmith not configured (LANGSMITH_API_KEY missing or invalid)",
        )

    now = datetime.now(UTC)

    async def _window(delta: timedelta | None) -> dict[str, Any]:
        start_time = (now - delta).isoformat() if delta else None
        try:
            stats = await asyncio.to_thread(_get_run_stats_sync, client, start_time)
        except Exception as exc:
            raise HTTPException(
                status_code=502, detail=f"{type(exc).__name__}: {exc}"
            ) from exc
        return _summarize_run_stats(stats)

    results = await asyncio.gather(*(_window(delta) for delta in _COST_WINDOWS.values()))
    return {
        "project": LANGSMITH_PROJECT,
        "windows": dict(zip(_COST_WINDOWS.keys(), results)),
    }
