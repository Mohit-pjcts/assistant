"""Phase 21: eval-suite runner — executes evals/supervisor_dataset.py's
golden scenarios against the REAL supervisor graph and scores routing/gate
correctness deterministically, via Langfuse's native `run_experiment()`
(langfuse==3.15.0, verified installed before writing this module — see
`Langfuse.run_experiment`'s own signature/docstring, checked live).

**Deterministic evaluators, not an LLM judge — a deliberate cost/reliability
choice.** Routing (which specialist tool got called) and gating (did
request_gated_action_confirmation fire, with which action) are both
mechanically readable off the graph's own output messages/`__interrupt__`
value — no fuzzy judgment call needed, so a second model call to grade the
first one would only add cost and a new source of flakiness for zero
accuracy gain. `evals/supervisor_dataset.py`'s own docstring covers why
output-quality grading (which WOULD need a judge) is out of this phase's
scope entirely.

**Cost, real and bounded, not unattended (CLAUDE.md's Cost section):** each
scenario is one real supervisor turn (extended-thinking Sonnet 5, same as
any real chat turn) plus, for non-gated scenarios, one real specialist turn
— gated scenarios are declined immediately (see `_run_scenario` below),
stopping the run BEFORE the owning specialist ever touches a real
side-effect API. Based on the real per-call cost observed during the Phase
10 Haiku-eval benchmark (~$0.0117/call, STEPS.md 75), the full ~14-scenario
suite (roughly 2-3 model calls per scenario) is on the order of $0.30-$0.50
per run — manually triggered only (`python evals/supervisor_eval.py`), never
wired into CI or any scheduled/unattended path, same posture this project
already chose for pytest itself (PLAN.md's CI-declined note).

**Never performs a real side effect.** Every `interrupt()` the graph raises
during a scenario — including a real gated action AND any incidental
long-term-memory-write proposal from `extract_and_propose_memory_node` — is
unconditionally declined (`Command(resume=False)`). No golden scenario
should ever actually send an email, touch a calendar, run a Shortcut, or
persist a memory fact.

Run: python evals/supervisor_eval.py
"""

from __future__ import annotations

from typing import Any

from dotenv import load_dotenv

load_dotenv()

from langchain_core.messages import HumanMessage  # noqa: E402
from langfuse import Evaluation  # noqa: E402
from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402
from langgraph.graph.state import CompiledStateGraph  # noqa: E402
from langgraph.types import Command  # noqa: E402

from assistant import observability  # noqa: E402
from assistant.agent import make_thread_config  # noqa: E402
from assistant.interrupts import send_test_notification  # noqa: E402
from assistant.supervisor import GATED_ACTIONS, build_graph  # noqa: E402
from evals.supervisor_dataset import DATASET_NAME  # noqa: E402

# The four supervisor-level delegation tool names (assistant/supervisor.py's
# _make_specialist_tool call sites) — not exported as a constant there, so
# mirrored here rather than reaching into a private module detail.
_SPECIALIST_TOOL_NAMES = {"coding_agent", "research_agent", "life_admin_agent", "mac_control_agent"}

_graph: CompiledStateGraph | None = None


def _build_eval_graph() -> CompiledStateGraph:
    """Built once per process, cached — an InMemorySaver checkpointer
    (ephemeral, never touches the real conversation_memory.sqlite) is
    required because request_gated_action_confirmation's interrupt() needs
    SOME checkpointer to pause/resume against (studio.py's checkpointer=None
    only works there because the LangGraph API server supplies its own).
    mcp_tools=[] deliberately: this suite only checks WHICH specialist got
    called, never whether a read actually succeeded, so life_admin_agent
    ends up with zero real Gmail/Calendar tools and no live OAuth
    dependency — a routing eval that needed a live Google account to run
    would be a much more fragile thing to leave in the repo."""
    global _graph
    if _graph is None:
        _graph = build_graph(
            checkpointer=InMemorySaver(),
            coding_extra_tools=[send_test_notification],
            mcp_tools=[],
        )
    return _graph


def _extract_specialists_called(messages: list[Any]) -> list[str]:
    """Which specialist delegation tools the supervisor actually invoked,
    in call order — read off each AIMessage's own `tool_calls`, the same
    shape LangChain always gives a tool-calling model response."""
    called: list[str] = []
    for msg in messages:
        for call in getattr(msg, "tool_calls", None) or []:
            name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
            if name in _SPECIALIST_TOOL_NAMES:
                called.append(name)
    return called


async def _run_scenario(*, item: Any, **kwargs: Any) -> dict[str, Any]:
    """Langfuse experiment task function — runs ONE scenario end-to-end
    against the real graph. Declines every interrupt it hits (see this
    module's docstring) and records only the FIRST GATED_ACTIONS-shaped one
    as the scenario's gate_action; a later, incidental save_memory proposal
    (a different, non-GATED_ACTIONS action string — memory_extraction.py's
    own interrupt payload) is declined the same way but not counted as a
    routing/gate result."""
    graph = _build_eval_graph()
    thread_id = f"eval-{item.id}"
    config = make_thread_config(thread_id)

    result = await graph.ainvoke({"messages": [HumanMessage(content=item.input["message"])]}, config=config)

    gate_action: str | None = None
    while "__interrupt__" in result:
        payload = result["__interrupt__"][0].value
        action = payload.get("action")
        if gate_action is None and action in GATED_ACTIONS:
            gate_action = action
        result = await graph.ainvoke(Command(resume=False), config=config)

    return {
        "specialists_called": _extract_specialists_called(result.get("messages", [])),
        "gate_action": gate_action,
    }


def routing_evaluator(*, input: Any, output: Any, expected_output: Any, **kwargs: Any) -> Evaluation:
    """Live-caught bug in the FIRST real run of this suite, not a bug in
    the assistant: `_run_scenario` always declines every gate (required —
    an eval must never perform a real side effect), and the supervisor's
    own contract for a decline is "do not delegate at all" (its
    `request_gated_action_confirmation` tool description). A gated
    scenario's `expected_specialists` therefore does NOT describe who ends
    up called — under an always-decline policy nobody legitimately should.
    The routing question that actually matters for a gated scenario is
    "did it correctly identify the request as *this* gated action" (which
    the gate_action check already answers) PLUS "did it correctly refrain
    from delegating once declined" — checked here by asserting the
    action's OWNING specialist (GATED_ACTIONS) is absent from what got
    called, tolerating an incidental research_agent call made earlier to
    resolve an objective date/time (CLAUDE.md's Phase 10 rule) before the
    gate was ever reached."""
    expected = expected_output or {}
    actual_specialists = set(output.get("specialists_called") or [])
    gate_action = expected.get("expected_gate_action")
    if gate_action is not None:
        owning_specialist = GATED_ACTIONS.get(gate_action)
        correct = owning_specialist not in actual_specialists
        comment = (
            f"gated action {gate_action!r} (declined) — owning specialist "
            f"{owning_specialist!r} must be absent, got {sorted(actual_specialists)}"
        )
    elif expected.get("no_specialist_expected"):
        correct = not actual_specialists
        comment = f"expected no specialist, got {sorted(actual_specialists)}"
    else:
        expected_specialists = set(expected.get("expected_specialists") or [])
        correct = expected_specialists.issubset(actual_specialists)
        comment = f"expected {sorted(expected_specialists)}, got {sorted(actual_specialists)}"
    return Evaluation(name="routing_correct", value=correct, comment=comment, data_type="BOOLEAN")


def gate_evaluator(*, input: Any, output: Any, expected_output: Any, **kwargs: Any) -> Evaluation:
    expected_action = (expected_output or {}).get("expected_gate_action")
    actual_action = output.get("gate_action")
    return Evaluation(
        name="gate_correct",
        value=actual_action == expected_action,
        comment=f"expected gate={expected_action!r}, got {actual_action!r}",
        data_type="BOOLEAN",
    )


def main() -> None:
    client = observability.get_client()
    if client is None:
        raise SystemExit(
            "LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY not configured — nothing to run."
        )
    dataset = client.get_dataset(DATASET_NAME)
    if not dataset.items:
        raise SystemExit(
            f"Dataset {DATASET_NAME!r} has no items — run "
            "`python evals/supervisor_dataset.py` first."
        )
    result = dataset.run_experiment(
        name="supervisor-routing-gate-eval",
        task=_run_scenario,
        evaluators=[routing_evaluator, gate_evaluator],
        # Deliberately low, not the SDK's default of 50 — this hits the
        # real Anthropic API with real spend per item (see module
        # docstring); bounding concurrency keeps a run's pace predictable
        # rather than firing all ~14 scenarios at once.
        max_concurrency=3,
    )
    client.flush()
    print(result.format())
    if result.dataset_run_url:
        print(f"\nFull results: {result.dataset_run_url}")


if __name__ == "__main__":
    main()
