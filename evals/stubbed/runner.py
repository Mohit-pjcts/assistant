"""Run cases against a model with every tool stubbed: schemas are bound, tools are never invoked.

The only thing read from the model is its response (tool calls and text). There is no code path in
this module that calls a tool's `invoke`/`ainvoke`, and `tests/test_stubbed_eval.py` enforces that
with tools that raise if touched.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Sequence
from typing import Any

from langchain_anthropic import ChatAnthropic
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from evals.stubbed.capture import AgentConfig
from evals.stubbed.cases import Case, ReplyCase
from evals.stubbed.variants import Variant

ModelFactory = Callable[[Variant], Any]


def default_model_factory(variant: Variant) -> Any:
    return ChatAnthropic(model=variant.model, max_tokens=variant.max_tokens, **variant.model_kwargs)


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
    return "".join(parts)


def _system(prompt: str) -> SystemMessage:
    return SystemMessage(content=[{"type": "text", "text": prompt, "cache_control": {"type": "ephemeral"}}])


async def _respond(
    variant: Variant, config: AgentConfig, messages: list[Any], factory: ModelFactory
) -> dict[str, Any]:
    """One streamed model response, reduced to plain data. Never raises: errors are recorded."""
    started = time.perf_counter()
    first: float | None = None
    aggregate = None
    try:
        model = factory(variant).bind_tools(
            list(variant.tools_for(config)), parallel_tool_calls=variant.parallel_tool_calls
        )
        async for chunk in model.astream([_system(variant.system_for(config)), *messages]):
            if first is None:
                first = time.perf_counter() - started
            aggregate = chunk if aggregate is None else aggregate + chunk
    except Exception as exc:  # recorded and counted as a failure by the scorer
        return {"calls": [], "text": "", "first_s": None, "total_s": time.perf_counter() - started,
                "out_tokens": None, "stop": None, "error": f"{type(exc).__name__}: {str(exc)[:300]}"}
    if aggregate is None:
        return {"calls": [], "text": "", "first_s": None, "total_s": time.perf_counter() - started,
                "out_tokens": None, "stop": None, "error": "empty response"}
    usage = aggregate.usage_metadata or {}
    return {
        "calls": [{"name": c["name"], "args": c["args"]} for c in (aggregate.tool_calls or [])],
        "text": _text_of(aggregate.content),
        # stop_reason "tool_use" with no parsed call lands here (arguments that failed to parse).
        "invalid_calls": [
            {"name": c.get("name"), "args": str(c.get("args"))[:200], "error": str(c.get("error"))[:120]}
            for c in (getattr(aggregate, "invalid_tool_calls", None) or [])
        ],
        "first_s": first,
        "total_s": time.perf_counter() - started,
        "out_tokens": usage.get("output_tokens"),
        "stop": (aggregate.response_metadata or {}).get("stop_reason"),
        "error": None,
    }


async def decide(
    variant: Variant, config: AgentConfig, case: Case, repeat: int, factory: ModelFactory
) -> dict[str, Any]:
    out = await _respond(variant, config, [HumanMessage(content=case.prompt)], factory)
    return {"case_id": case.id, "repeat": repeat, "prompt": case.prompt, **out}


async def reply(
    variant: Variant, config: AgentConfig, case: ReplyCase, repeat: int, factory: ModelFactory
) -> dict[str, Any]:
    """The supervisor's final answer after a canned tool result (the delegation is stubbed)."""
    call_id = f"toolu_stub_{case.id}"
    messages = [
        HumanMessage(content=case.prompt),
        AIMessage(content="", tool_calls=[{"name": case.tool_name, "args": case.tool_args, "id": call_id}]),
        ToolMessage(content=case.tool_result, tool_call_id=call_id, name=case.tool_name),
    ]
    out = await _respond(variant, config, messages, factory)
    return {"case_id": case.id, "repeat": repeat, **out}


async def run_all(
    variant: Variant,
    configs: dict[str, AgentConfig],
    cases: Sequence[Case],
    reply_cases: Sequence[ReplyCase],
    *,
    repeats: int,
    concurrency: int = 6,
    factory: ModelFactory = default_model_factory,
) -> dict[str, list[dict[str, Any]]]:
    """Every case x repeat, bounded concurrency. Returns {"decisions": [...], "replies": [...]}."""
    gate = asyncio.Semaphore(concurrency)

    async def bounded(coro_fn: Callable[[], Any]) -> dict[str, Any]:
        async with gate:
            return await coro_fn()

    decision_jobs = [
        bounded(lambda c=c, r=r: decide(variant, configs[c.agent], c, r, factory))
        for c in cases for r in range(repeats)
    ]
    reply_jobs = [
        bounded(lambda c=c, r=r: reply(variant, configs["supervisor"], c, r, factory))
        for c in reply_cases for r in range(repeats)
    ]
    decisions, replies = await asyncio.gather(asyncio.gather(*decision_jobs), asyncio.gather(*reply_jobs))
    return {"decisions": list(decisions), "replies": list(replies)}
