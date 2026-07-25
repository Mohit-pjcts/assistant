"""Tests for evals/supervisor_eval.py's pure scoring logic.

Deliberately does NOT run `_run_scenario` (that hits the real graph/API —
same no-mocking convention that keeps this project off CI, see PLAN.md's
CI-declined note) — only the deterministic, pure-data helpers that don't
touch the network: message-parsing and the two evaluators.
"""

from langchain_core.messages import AIMessage, HumanMessage

from evals.supervisor_dataset import SCENARIOS, _validate_scenarios
from evals.supervisor_eval import _extract_specialists_called, gate_evaluator, routing_evaluator


def test_scenario_gate_actions_are_all_real_gated_actions() -> None:
    _validate_scenarios()  # raises on a typo'd expected_gate_action


def test_scenario_ids_are_unique() -> None:
    ids = [s["id"] for s in SCENARIOS]
    assert len(ids) == len(set(ids))


def test_extract_specialists_called_reads_tool_calls_in_order() -> None:
    messages = [
        HumanMessage(content="do things"),
        AIMessage(
            content="",
            tool_calls=[{"name": "research_agent", "args": {}, "id": "1"}],
        ),
        AIMessage(
            content="",
            tool_calls=[{"name": "life_admin_agent", "args": {}, "id": "2"}],
        ),
    ]
    assert _extract_specialists_called(messages) == ["research_agent", "life_admin_agent"]


def test_extract_specialists_called_ignores_non_specialist_tool_calls() -> None:
    messages = [
        AIMessage(
            content="",
            tool_calls=[{"name": "request_gated_action_confirmation", "args": {}, "id": "1"}],
        ),
    ]
    assert _extract_specialists_called(messages) == []


def test_extract_specialists_called_handles_no_tool_calls() -> None:
    messages = [HumanMessage(content="hi"), AIMessage(content="hello there")]
    assert _extract_specialists_called(messages) == []


def test_routing_evaluator_passes_on_expected_subset() -> None:
    result = routing_evaluator(
        input=None,
        output={"specialists_called": ["research_agent"]},
        expected_output={"expected_specialists": ["research_agent"], "no_specialist_expected": False},
    )
    assert result.value is True


def test_routing_evaluator_fails_on_missing_specialist() -> None:
    result = routing_evaluator(
        input=None,
        output={"specialists_called": ["coding_agent"]},
        expected_output={"expected_specialists": ["research_agent"], "no_specialist_expected": False},
    )
    assert result.value is False


def test_routing_evaluator_direct_answer_case() -> None:
    result = routing_evaluator(
        input=None,
        output={"specialists_called": []},
        expected_output={"expected_specialists": [], "no_specialist_expected": True},
    )
    assert result.value is True


def test_routing_evaluator_direct_answer_case_fails_if_specialist_called() -> None:
    result = routing_evaluator(
        input=None,
        output={"specialists_called": ["coding_agent"]},
        expected_output={"expected_specialists": [], "no_specialist_expected": True},
    )
    assert result.value is False


def test_routing_evaluator_gated_scenario_passes_when_owning_specialist_absent() -> None:
    # Reflects the always-decline eval policy: once request_gated_action_
    # confirmation is declined, the supervisor's own contract is "do not
    # delegate" — an incidental research_agent call (date resolution) made
    # BEFORE the gate is fine and must not fail this check.
    result = routing_evaluator(
        input=None,
        output={"specialists_called": ["research_agent"], "gate_action": "delete_calendar_event"},
        expected_output={
            "expected_specialists": ["life_admin_agent"],
            "no_specialist_expected": False,
            "expected_gate_action": "delete_calendar_event",
        },
    )
    assert result.value is True


def test_routing_evaluator_gated_scenario_fails_if_owning_specialist_called_anyway() -> None:
    result = routing_evaluator(
        input=None,
        output={"specialists_called": ["life_admin_agent"], "gate_action": "send_email"},
        expected_output={
            "expected_specialists": ["life_admin_agent"],
            "no_specialist_expected": False,
            "expected_gate_action": "send_email",
        },
    )
    assert result.value is False


def test_gate_evaluator_passes_on_matching_action() -> None:
    result = gate_evaluator(
        input=None,
        output={"gate_action": "send_email"},
        expected_output={"expected_gate_action": "send_email"},
    )
    assert result.value is True


def test_gate_evaluator_fails_when_gate_unexpectedly_fires() -> None:
    result = gate_evaluator(
        input=None,
        output={"gate_action": "send_email"},
        expected_output={"expected_gate_action": None},
    )
    assert result.value is False


def test_gate_evaluator_fails_when_gate_expected_but_missing() -> None:
    result = gate_evaluator(
        input=None,
        output={"gate_action": None},
        expected_output={"expected_gate_action": "delete_calendar_event"},
    )
    assert result.value is False
