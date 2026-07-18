"""Phase 16 Part A.5: research_agent as a standalone "functional agent" (FA)
service — the distributed-tracing spike the user's mentor asked for
(DISTRIBUTED_TRACING_SPIKE.md, PLAN.md Phase 16 Part A.5) before the Part B
v3 migration. Models Nova's real shape in miniature: a superagent (this
project's supervisor) calls a functional agent over HTTP, in a separate
process, instead of the FA being embedded in-process as every other
sub-agent here still is.

Deliberately minimal — this is a spike demonstrator, not a production
service: `research_agent` is the ONLY sub-agent touched (read-only web
search, no gated tools, no security/memory surface at risk — chosen for
exactly that reason in the mentor's doc). Reuses `build_research_agent()`
from `sub_agents.py` as-is; does not reimplement the agent.

Own Langfuse identity via `observability.configure_client("research-fa")`,
so its traces are attributable to this process specifically, mirroring
`main.py`/`voice_daemon.py`/`server.py` each claiming their own client tag.
Stateless per request — no checkpointer, unlike the outer graph: each
request is a single, fresh `ainvoke()`, since this FA has no conversation
of its own to persist across calls (checkpointing here is the supervisor's
job, same division of responsibility `sub_agents.py`'s own module docstring
already describes for in-process sub-agents).

Message serialization: LangChain's own `model_dump()` / `convert_to_messages()`
round-trip (verified live before writing this — type info and
`additional_kwargs` markers, e.g. `is_genuine_human_turn`'s Phase 6/7
markers, survive the JSON round trip intact), not a hand-rolled format.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from langchain_core.messages import BaseMessage  # noqa: E402
from langchain_core.messages.utils import convert_to_messages  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from assistant import observability  # noqa: E402

# MUST run before `assistant.sub_agents` is imported, not just before the
# lazy handler is used directly — caught live (STEPS.md, this spike):
# sub_agents.py fetches ALL FIVE of its system prompts via
# prompts.get_prompt() at ITS OWN module-import time, and that call chain
# (prompts.get_prompt -> observability.get_client -> _get_handler) is what
# actually constructs the lazy singleton handler first, with tags=None,
# if this line comes after the import. Exactly the ordering trap main.py's
# own configure_client() call already had to dodge (STEPS.md 80) — missed
# it here on the first attempt, fixed once the tags showed up empty.
observability.configure_client("research-fa")

from assistant.sub_agents import build_research_agent  # noqa: E402


class ResearchRequest(BaseModel):
    messages: list[dict[str, Any]]
    # Shares the caller's session so the FA's trace groups under the same
    # Langfuse session as the supervisor's, even before the trace-level
    # nesting fix below — same session-scoping model Part A already
    # verified for confirmation-gate resume pairs (STEPS.md 80 Finding 1).
    thread_id: str
    # Step 4 of the mentor's spike (PLAN.md Phase 16 Part A.5): when set,
    # nest this request's own trace under the caller's exact handoff span
    # instead of opening a new disconnected root trace — the v2-style fix,
    # mirroring Nova's current hand-rolled FA protocol. Both optional: a
    # caller with no Langfuse handler configured (or an in-process caller
    # not doing the distributed spike at all) simply omits them, and this
    # FA falls back to its own session-tagged handler.
    langfuse_trace_id: str | None = None
    langfuse_parent_observation_id: str | None = None


class ResearchResponse(BaseModel):
    messages: list[dict[str, Any]]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Build the research agent once for the process lifetime — same
    "build once, not per request" principle as the outer graph, even though
    this agent itself carries no checkpointer."""
    app.state.agent = build_research_agent()
    yield


app = FastAPI(lifespan=lifespan)


def _tracing_config(request: ResearchRequest) -> dict[str, Any]:
    """Step 4's v2-style cross-process nesting fix. Verified live before
    writing this (STEPS.md, this spike): `trace.span(parent_observation_id=
    ..., name=...)` genuinely nests (confirmed via a real fetched trace,
    not just "didn't error" — Langfuse's convenience wrapper doesn't
    type-hint `parent_observation_id` but passes it through via **kwargs),
    and `CallbackHandler(stateful_client=...)` is the base handler's own
    documented interop mechanism (base_callback_handler.py) for binding a
    handler to a pre-existing span rather than starting a new root trace.

    Per-request handler construction here is a deliberate, accepted
    tradeoff for a spike (PLAN.md Phase 16 Part A.5 design decision 3) —
    it reintroduces the exact per-call handler cost `observability.py`'s
    shared-singleton design avoids elsewhere, since binding to a specific
    parent span can't be done via the per-call metadata override
    `langfuse_session_id` uses. Not something this FA would do outside spike
    scope.
    """
    client = observability.get_client()
    if client is None:
        return {}
    if request.langfuse_trace_id and request.langfuse_parent_observation_id:
        parent_trace = client.trace(id=request.langfuse_trace_id)
        parent_span = parent_trace.span(
            parent_observation_id=request.langfuse_parent_observation_id,
            name="research-fa",
        )
        return {"callbacks": [observability.CallbackHandler(stateful_client=parent_span)]}
    return observability.langfuse_run_config(request.thread_id)


@app.post("/research")
async def research(request: ResearchRequest) -> ResearchResponse:
    messages: list[BaseMessage] = convert_to_messages(request.messages)
    config = _tracing_config(request)
    result = await app.state.agent.ainvoke({"messages": messages}, config=config)
    return ResearchResponse(messages=[m.model_dump() for m in result["messages"]])


def _extract_token_text(content: object) -> str:
    """Mirrors server.py's own `_extract_token_text` — deliberate small
    per-module duplication of a rendering helper, same precedent server.py
    itself already establishes (its own docstring cites voice_daemon.py
    duplicating a small helper rather than sharing one)."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "".join(parts)


def _sse_event(payload: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(payload)}\n\n".encode()


@app.post("/research/stream")
async def research_stream(request: ResearchRequest) -> StreamingResponse:
    """Streaming counterpart to /research — the design decision (PLAN.md
    Phase 16 Part A.5) to make the proxy-to-FA hop a real streaming relay,
    not the blocking round trip /research still is (kept as-is; nothing
    currently calls it, left for direct testing/comparison). Emits
    `{"type": "token", ...}` frames as the FA's own model generates them,
    followed by exactly one `{"type": "final", "messages": [...]}` frame.

    No checkpointer on this agent (see module docstring), so the final
    message list can't be read back via `aget_state()` the way server.py's
    own `_stream_turn` does — instead captured from the ROOT run's
    `on_chain_end` event (`parent_ids == []`), verified live before writing
    this that its `data.output` really does contain the full final
    `messages` list for a `create_agent(...)`-built graph.

    Error handling mirrors `server.py`'s own `_stream_turn` exactly — a
    real code-review finding (CONFIRMED) caught that this endpoint had NO
    try/except at all, unlike the module it claims to be modeled on: a
    Tavily/Anthropic failure mid-generation would just kill the SSE
    connection with no structured signal. Fixed the same way `_stream_turn`
    already handles it: `asyncio.CancelledError` propagates (a genuine
    `/chat/stop`-style cancellation, not an error), anything else becomes a
    `{"type": "error", ...}` frame the caller (`research_agent_proxy`) can
    now react to instead of just seeing the stream end.
    """
    messages: list[BaseMessage] = convert_to_messages(request.messages)
    config = _tracing_config(request)

    async def event_stream() -> AsyncIterator[bytes]:
        final_messages: list[BaseMessage] | None = None
        try:
            async for event in app.state.agent.astream_events(
                {"messages": messages}, config=config, version="v2"
            ):
                if event.get("event") == "on_chat_model_stream":
                    text = _extract_token_text(event["data"]["chunk"].content)
                    if text:
                        yield _sse_event({"type": "token", "text": text})
                elif event.get("event") == "on_chain_end" and not event.get("parent_ids"):
                    output = event["data"].get("output")
                    if isinstance(output, dict) and "messages" in output:
                        final_messages = output["messages"]
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # network errors, rate limits, etc. — data, not a crash
            yield _sse_event({"type": "error", "detail": f"{type(exc).__name__}: {exc}"})
            return
        yield _sse_event(
            {
                "type": "final",
                "messages": [m.model_dump() for m in final_messages] if final_messages else [],
            }
        )

    return StreamingResponse(event_stream(), media_type="text/event-stream")
