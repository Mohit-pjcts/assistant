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

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from langchain_core.messages import BaseMessage  # noqa: E402
from langchain_core.messages.utils import convert_to_messages  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from assistant import observability  # noqa: E402

# Historically had to run before `assistant.sub_agents` was imported, since
# v2's `configure_client()` baked tags into the handler at construction time
# (STEPS.md 80/84) — sub_agents.py fetching its prompts at module-import
# time could construct that handler first, with tags=None, if this line
# came after the import. No longer a hard ordering requirement as of the
# v3 migration (STEPS.md 86): `configure_client()`'s own docstring now
# states tags are read fresh per-call, so this can even run AFTER the
# handler is first built. Left here at module top for clarity, not because
# it's still required (a real /code-review max finding, STEPS.md 91,
# caught this comment as stale after the migration).
observability.configure_client("research-fa")

from assistant.sub_agents import build_research_agent  # noqa: E402


class ResearchRequest(BaseModel):
    messages: list[dict[str, Any]]
    # Shares the caller's session so the FA's trace groups under the same
    # Langfuse session as the supervisor's — same session-scoping model
    # Part A already verified for confirmation-gate resume pairs (STEPS.md
    # 80 Finding 1). Cross-process trace NESTING (Step 4 of the mentor's
    # spike) no longer needs anything in the request body as of the v3
    # migration (STEPS.md 89) — it travels as a standard `traceparent` HTTP
    # header instead, extracted by `_extract_parent_context()` below.
    thread_id: str


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


@app.post("/research")
async def research(http_request: Request, request: ResearchRequest) -> ResearchResponse:
    """Non-streaming sibling of `/research/stream`. Nothing currently calls
    this in production (see module-level history), but `RESEARCH_FA_URL`
    (supervisor.py) still points at it, so it stays reachable. Wrapped in
    the same `except Exception -> structured error` shape `/research/stream`
    already has — a real /code-review max finding (STEPS.md 91) caught that
    this endpoint never got that fix mirrored onto it, so a Tavily/Anthropic
    failure here surfaced as an unstructured 500 instead.

    Cross-process trace linking + this process's own session/tags/
    trace-name propagation are both handled by
    `observability.attached_parent_context()` — one context manager
    replacing what used to be a hand-written extract+attach+tracing_context
    +detach sequence duplicated at both this endpoint and
    `/research/stream` (STEPS.md 91)."""
    messages: list[BaseMessage] = convert_to_messages(request.messages)
    try:
        with observability.attached_parent_context(http_request.headers, request.thread_id):
            result = await app.state.agent.ainvoke(
                {"messages": messages},
                config={"callbacks": observability.langfuse_callbacks()},
            )
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # network errors, rate limits, etc. — data, not a crash
        raise HTTPException(
            status_code=502, detail=f"Research request failed: {type(exc).__name__}: {exc}"
        ) from exc
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
async def research_stream(http_request: Request, request: ResearchRequest) -> StreamingResponse:
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

    The `traceparent` header is extracted and attached INSIDE the generator,
    not in this outer function — `StreamingResponse` only starts consuming
    `event_stream()` once the ASGI layer begins writing the response body,
    so attaching here would risk `attached_parent_context()`'s attach and
    the actual span-creating work (astream_events) running further apart
    than necessary. Cross-process trace linking + this process's own
    session/tags/trace-name propagation are both handled by
    `observability.attached_parent_context()` — one context manager
    replacing what used to be a hand-written extract+attach+tracing_context
    +detach sequence duplicated at both this endpoint and `/research`
    (STEPS.md 91).
    """
    messages: list[BaseMessage] = convert_to_messages(request.messages)

    async def event_stream() -> AsyncIterator[bytes]:
        final_messages: list[BaseMessage] | None = None
        try:
            with observability.attached_parent_context(http_request.headers, request.thread_id):
                async for event in app.state.agent.astream_events(
                    {"messages": messages},
                    config={"callbacks": observability.langfuse_callbacks()},
                    version="v2",
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
