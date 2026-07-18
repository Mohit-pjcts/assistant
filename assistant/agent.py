"""Shared LangGraph invocation-config helper.

Graph construction moved to supervisor.py (outer graph) and sub_agents.py
(the coding/research/life-admin workers) as of Phase 3's multi-agent split
(STEPS.md 24) — this module's build_agent()/SYSTEM_PROMPT/MODEL_NAME are
superseded by supervisor.build_graph() and each sub-agent's own
MODEL_NAME/SYSTEM_PROMPT constants in sub_agents.py.
"""

from __future__ import annotations

from typing import Any

from assistant import observability


def make_thread_config(thread_id: str) -> dict[str, Any]:
    """Build the LangGraph invocation config for a given conversation thread.

    Always sets both thread_id and checkpoint_ns explicitly — memory.py's
    test surfaced that the underlying SqliteSaver requires checkpoint_ns
    when checkpoints are read/written, so it's set here rather than relying
    on it being defaulted elsewhere. Still correct for the Phase 3 outer
    graph: sub-agent/supervisor subgraph checkpoint_ns nesting is automatic
    (STEPS.md 24), not something this config needs to express.

    Phase 16 Part B (v3 migration): merges in the Langfuse callback handler
    via `observability.langfuse_callbacks()` — the one place all three call
    sites (CLI, voice, dashboard) pick it up, per this module's own "never
    build invocation config dicts by hand" convention. A no-op ([]) when
    Langfuse isn't configured. Unlike v2, session/tags/trace-name are NOT
    part of this config dict — v3 sets those via `observability.
    tracing_context(thread_id)`, a context manager each call site wraps its
    own `ainvoke()`/`astream_events()` call in, since that's how v3's
    `propagate_attributes()` mechanism works (see observability.py's module
    docstring for the full why).

    Args:
        thread_id: Identifier for the conversation thread (e.g. a UUID
            generated once per CLI session).
    """
    config: dict[str, Any] = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}
    callbacks = observability.langfuse_callbacks()
    if callbacks:
        config["callbacks"] = callbacks
    return config
