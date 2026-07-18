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
from assistant.agent import make_thread_config  # noqa: E402
from assistant.compaction import is_compaction_summary, is_genuine_human_turn  # noqa: E402
from assistant.interrupts import send_test_notification  # noqa: E402
from assistant.mcp_tools import load_mcp_tools  # noqa: E402
from assistant.memory import get_checkpointer  # noqa: E402
from assistant.supervisor import build_graph  # noqa: E402

# Must run before observability's lazy handler is first constructed (i.e.
# before the first make_thread_config() call) — tags are constructor-bound
# in Langfuse v2, not per-call overridable. See observability.py.
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
) -> AsyncIterator[bytes]:
    """Stream one turn (a fresh message OR a Command(resume=...)) as SSE
    frames: zero or more `{"type": "token", "text": ...}` deltas, followed
    by exactly one terminal frame — `{"type": "interrupt", "payload": ...}`
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
        async for event in graph.astream_events(input_or_command, config=config, version="v2"):
            if event.get("event") == "on_chat_model_stream":
                text = _extract_token_text(event["data"]["chunk"].content)
                if text:
                    yield _sse_event({"type": "token", "text": text})
            elif event.get("event") == "on_custom_event" and event.get("name") == "research_fa_token":
                # Phase 16 Part A.5 (the mentor's distributed-tracing
                # spike): supervisor.py's research_agent_proxy() re-dispatches
                # tokens it streams from the FA process via
                # adispatch_custom_event(), since that's the one mechanism
                # verified live to actually surface through astream_events()
                # as a real event — LangGraph's own get_stream_writer()
                # custom channel does NOT (checked empirically, not
                # assumed). Forwarded identically to a normal token frame;
                # the dashboard client can't tell the difference, same as
                # the whole point of the spike being invisible to callers.
                text = event["data"].get("text", "")
                if text:
                    yield _sse_event({"type": "token", "text": text})

        state = await graph.aget_state(config)
        pending = [i for t in state.tasks for i in t.interrupts]
        if pending:
            yield _sse_event({"type": "interrupt", "payload": pending[0].value})
        else:
            final_message = state.values["messages"][-1]
            yield _sse_event({"type": "message", "content": _render_content(final_message.content)})
            if gate_outcome is not None:
                approved, action = gate_outcome
                asyncio.create_task(observability.score_gate_outcome(thread_id, approved, action))
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
        ),
        media_type="text/event-stream",
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
    queried concurrently (each is an independent ~1s blocking call)."""
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
