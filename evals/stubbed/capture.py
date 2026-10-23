"""Capture each agent's real system prompt and tool list without building a runnable graph.

`create_agent` is swapped for a recorder while the real builders run, so the prompt and tools are
exactly what production uses (including a Langfuse "production" prompt override, via
`prompts.get_prompt`). Nothing is compiled, no checkpointer is touched, no tool is called.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any
from unittest import mock

from langchain_core.tools import BaseTool

from assistant import sub_agents, supervisor

AGENT_NAMES = (
    "supervisor",
    "coding_agent",
    "research_agent",
    "life_admin_agent",
    "mac_control_agent",
)


@dataclass(frozen=True)
class AgentConfig:
    """One agent as the model sees it: its prompt and its tools. Tools are schemas here only."""

    name: str
    system_prompt: str
    tools: tuple[BaseTool, ...]


def capture_agent_configs() -> dict[str, AgentConfig]:
    """Run the builders against a recording `create_agent` and return one config per agent.

    Specialist graphs passed to `build_supervisor` are placeholders: the supervisor only closes
    over them inside its delegation tools, which this package never calls.
    """
    captured: dict[str, dict[str, Any]] = {}

    def record(**kwargs: Any) -> SimpleNamespace:
        captured[kwargs["name"]] = kwargs
        return SimpleNamespace()

    quiet = logging.getLogger("assistant")
    previous = quiet.level
    quiet.setLevel(logging.ERROR)  # build_life_admin_agent([]) warns that Gmail tools are absent
    try:
        with (
            mock.patch.object(sub_agents, "create_agent", record),
            mock.patch.object(supervisor, "create_agent", record),
        ):
            sub_agents.build_coding_agent()
            sub_agents.build_research_agent()
            sub_agents.build_life_admin_agent([])
            sub_agents.build_mac_control_agent()
            supervisor.build_supervisor(*[object()] * 5)
    finally:
        quiet.setLevel(previous)

    missing = [n for n in AGENT_NAMES if n not in captured]
    if missing:
        raise RuntimeError(f"builders did not create agents named {missing}; got {sorted(captured)}")
    return {
        name: AgentConfig(
            name=name,
            system_prompt=str(captured[name]["system_prompt"]),
            tools=tuple(captured[name]["tools"]),
        )
        for name in AGENT_NAMES
    }
