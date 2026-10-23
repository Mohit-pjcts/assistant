"""A Variant is one way of running the same cases: model, thinking, effort, tool list, prompt.

`baseline` mirrors production. A change under test (an extra leaf tool on the supervisor, a
different prompt, a different model) is a new Variant, so the gate compares like for like.
Custom variants load with `--variant package.module:ATTRIBUTE` (a Variant or a zero-argument
callable returning one).
"""

from __future__ import annotations

import hashlib
import importlib
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from langchain_core.tools import BaseTool

from assistant.thinking_repair import THINKING_CONFIG
from evals.stubbed.capture import AgentConfig

ToolsTransform = Callable[[str, tuple[BaseTool, ...]], tuple[Any, ...]]
SystemTransform = Callable[[str, str], str]


@dataclass(frozen=True)
class Variant:
    """Everything that may legitimately differ between a baseline and a candidate run."""

    name: str
    model: str = "claude-sonnet-5-5"
    model_kwargs: dict[str, Any] = field(default_factory=dict)
    max_tokens: int = 4096
    parallel_tool_calls: bool = False
    # (agent_name, captured tools) -> tools to bind. Items may be BaseTools or raw tool dicts.
    tools: ToolsTransform | None = None
    # (agent_name, captured system prompt) -> prompt to use.
    system: SystemTransform | None = None

    def tools_for(self, config: AgentConfig) -> tuple[Any, ...]:
        return self.tools(config.name, config.tools) if self.tools else config.tools

    def system_for(self, config: AgentConfig) -> str:
        return self.system(config.name, config.system_prompt) if self.system else config.system_prompt


_ADAPTIVE = dict(THINKING_CONFIG)

BASELINE = Variant(name="baseline", model_kwargs={"thinking": _ADAPTIVE})

VARIANTS: dict[str, Variant] = {
    "baseline": BASELINE,
    "sonnet-effort-low": Variant(
        name="sonnet-effort-low", model_kwargs={"thinking": _ADAPTIVE, "effort": "low"}
    ),
    # Negative control: Haiku skipped a confirmation gate as supervisor (docs/SPEED_RESEARCH.md section 2),
    # so a working gate must reject this variant.
    "haiku": Variant(name="haiku", model="claude-haiku-5-5", model_kwargs={"thinking": {"type": "disabled"}}),
    "opus": Variant(name="opus", model="claude-opus-5-5", model_kwargs={"thinking": _ADAPTIVE}),
    # The installed anthropic SDK rejects `speed` as a keyword, so it travels in the body.
    "opus-fast": Variant(
        name="opus-fast",
        model="claude-opus-5-5",
        model_kwargs={"thinking": _ADAPTIVE, "model_kwargs": {"extra_body": {"speed": "fast"}}},
    ),
}


def load_variant(spec: str) -> Variant:
    """Resolve a registry name or `package.module:ATTRIBUTE` to a Variant."""
    if spec in VARIANTS:
        return VARIANTS[spec]
    if ":" not in spec:
        raise ValueError(f"unknown variant {spec!r}; known: {sorted(VARIANTS)} or 'module:ATTRIBUTE'")
    module_name, attribute = spec.split(":", 1)
    value = getattr(importlib.import_module(module_name), attribute)
    variant = value() if callable(value) and not isinstance(value, Variant) else value
    if not isinstance(variant, Variant):
        raise TypeError(f"{spec} resolved to {type(variant).__name__}, not a Variant")
    return variant


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str, ensure_ascii=False).encode()).hexdigest()[:16]


def _tool_schema(tool: Any) -> Any:
    if isinstance(tool, BaseTool):
        return {"name": tool.name, "description": tool.description, "args": tool.args}
    return tool


def fingerprint(variant: Variant, configs: dict[str, AgentConfig]) -> dict[str, dict[str, str]]:
    """Short hashes of the prompt and tool schemas each agent is shown under `variant`.

    Stored in every run so `compare` can refuse a baseline taken on different prompts or tools
    (`capture.py` reads the remote Langfuse prompt when one exists, so the prompt can change
    without any file changing). Tools are sorted by name; order does not matter to the model's choice.
    """
    out: dict[str, dict[str, str]] = {}
    for name, config in configs.items():
        schemas = sorted((_tool_schema(t) for t in variant.tools_for(config)), key=lambda t: json.dumps(t, sort_keys=True, default=str))
        out[name] = {"prompt": _digest(variant.system_for(config)), "tools": _digest(schemas)}
    return out
