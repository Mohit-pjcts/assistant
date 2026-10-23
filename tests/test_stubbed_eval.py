"""Offline tests for evals/stubbed: scoring, the gate, and the guarantee that no tool is ever run.

No network and no API key needed except `test_capture_*`, which only builds prompts and tools.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from langchain_core.messages import AIMessageChunk
from langchain_core.tools import StructuredTool

from evals.stubbed import score
from evals.stubbed.capture import AgentConfig, capture_agent_configs
from evals.stubbed.cases import (
    ALL_CASES,
    GATE_TOOLS,
    NO_TOOL,
    READ_ONLY_PRECURSORS,
    REPLY_CASES,
    Case,
    ReplyCase,
    case_by_id,
)
from evals.stubbed.runner import run_all
from evals.stubbed.variants import BASELINE, Variant, load_variant


def _case(**kw) -> Case:
    base = dict(id="c", agent="supervisor", prompt="p", allowed=frozenset({"a"}))
    base.update(kw)
    return Case(**base)


def _calls(name: str, **args):
    return [{"name": name, "args": args}]


# --- deterministic checks --------------------------------------------------------------------


def test_routing_no_tool_token():
    case = _case(allowed=frozenset({NO_TOOL}))
    assert score.routing_ok(case, [])
    assert not score.routing_ok(case, _calls("a"))


def test_invariant_must_gate_requires_a_gate_tool_first():
    case = _case(must_gate=True, allowed=frozenset(GATE_TOOLS))
    assert score.invariant_ok(case, _calls("request_gated_action_confirmation"))
    assert score.invariant_ok(case, _calls("propose_workflow"))
    assert score.invariant_ok(case, _calls("search_vault"))  # read-only precursor
    assert not score.invariant_ok(case, _calls("mac_control_agent"))
    assert not score.invariant_ok(case, _calls("life_admin_agent"))
    assert not score.invariant_ok(case, [])


def test_invariant_forbidden_first():
    case = _case(forbidden_first=frozenset({"life_admin_agent"}))
    assert not score.invariant_ok(case, _calls("life_admin_agent"))
    assert score.invariant_ok(case, _calls("research_agent"))


def test_contains_is_case_insensitive_and_supports_alternatives():
    case = _case(args_contain=("Hello.TXT", "formula 1|f1"))
    assert score.contains_ok(case, _calls("a", instruction="create hello.txt about F1"))
    assert not score.contains_ok(case, _calls("a", instruction="create hello.txt only"))
    assert not score.contains_ok(case, [])


def test_every_gate_case_names_a_gate_tool_and_ids_are_unique():
    ids = [c.id for c in ALL_CASES]
    assert len(ids) == len(set(ids))
    for c in ALL_CASES:
        if c.must_gate:
            assert c.allowed <= GATE_TOOLS | READ_ONLY_PRECURSORS, c.id
    assert case_by_id("sup-gate-send-email").must_gate


# --- statistics --------------------------------------------------------------------------------


def test_wilson_interval_brackets_the_rate():
    lo, hi = score.wilson(45, 50)
    assert lo < 0.9 < hi
    assert score.wilson(0, 0) == (0.0, 0.0)


# --- the runner never runs a tool --------------------------------------------------------------


class _FakeModel:
    """Stands in for ChatAnthropic: bind_tools records schemas, astream yields a canned response."""

    def __init__(self, responder):
        self.responder = responder
        self.bound = None

    def bind_tools(self, tools, parallel_tool_calls=None):
        self.bound = list(tools)
        return self

    async def astream(self, messages):
        text, calls = self.responder(messages)
        yield AIMessageChunk(
            content=text,
            tool_calls=[{"name": n, "args": a, "id": f"id{i}"} for i, (n, a) in enumerate(calls)],
            usage_metadata={"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
        )


def _exploding_tool(name: str) -> StructuredTool:
    def boom(x: str = "") -> str:
        raise AssertionError(f"tool {name} was executed")

    return StructuredTool.from_function(func=boom, name=name, description="d")


def _configs() -> dict[str, AgentConfig]:
    tools = (_exploding_tool("a"), _exploding_tool("request_gated_action_confirmation"))
    return {"supervisor": AgentConfig("supervisor", "sys", tools)}


async def test_runner_binds_but_never_invokes_tools():
    cases = [_case(id="one"), _case(id="two", allowed=frozenset({NO_TOOL}))]
    replies = [ReplyCase("r", "q", "a", {"x": "1"}, "result", "rubric")]
    model = _FakeModel(lambda msgs: ("hi", [("a", {"x": "1"})]))
    run = await run_all(BASELINE, _configs(), cases, replies, repeats=2, factory=lambda v: model)
    assert len(run["decisions"]) == 4 and len(run["replies"]) == 2
    assert all(d["calls"][0]["name"] == "a" for d in run["decisions"])
    assert {t.name for t in model.bound} == {"a", "request_gated_action_confirmation"}


async def test_reply_case_sends_the_tool_result_back():
    seen = {}

    def responder(msgs):
        seen["kinds"] = [type(m).__name__ for m in msgs]
        return "answer", []

    case = ReplyCase("r", "q", "research_agent", {"instruction": "x"}, "RESULT", "rubric")
    await run_all(BASELINE, _configs(), [], [case], repeats=1, factory=lambda v: _FakeModel(responder))
    assert seen["kinds"] == ["SystemMessage", "HumanMessage", "AIMessage", "ToolMessage"]


async def test_model_error_is_recorded_not_raised():
    class Boom(_FakeModel):
        async def astream(self, messages):
            raise RuntimeError("429 slow down")
            yield  # pragma: no cover

    run = await run_all(BASELINE, _configs(), [_case()], [], repeats=1, factory=lambda v: Boom(None))
    assert run["decisions"][0]["error"].startswith("RuntimeError")


# --- scoring with a fake judge -----------------------------------------------------------------


async def test_score_run_uses_judge_only_after_cheap_checks_pass():
    asked = []

    async def judge_args(rubric, prompt, tool, args, **kw):
        asked.append(tool)
        return SimpleNamespace(ok=False, reason="nope")

    case = _case(rubric="must be good", args_contain=("x",))
    run = {
        "decisions": [
            {"case_id": "c", "repeat": 0, "calls": _calls("a", q="x"), "error": None},
            {"case_id": "c", "repeat": 1, "calls": _calls("a", q="zzz"), "error": None},  # fails contains
            {"case_id": "c", "repeat": 2, "calls": _calls("b", q="x"), "error": None},  # fails routing
        ],
        "replies": [],
    }
    await score.score_run(run, [case], [], judge_args=judge_args)
    d0, d1, d2 = run["decisions"]
    assert asked == ["a"]
    assert d0["rubric_ok"] is False and not d0["args_ok"]
    assert not d1["args_ok"] and not d2["args_ok"]


async def test_reply_that_calls_a_tool_fails_without_asking_the_judge():
    async def judge_reply(*a, **k):
        raise AssertionError("judge should not be called")

    case = ReplyCase("r", "q", "t", {}, "res", "rub")
    run = {"decisions": [], "replies": [{"case_id": "r", "repeat": 0, "calls": _calls("t"), "text": "", "error": None}]}
    await score.score_run(run, [], [case], judge_reply=judge_reply)
    assert run["replies"][0]["reply_ok"] is False


# --- the gate ------------------------------------------------------------------------------------


def _summary(routing=(90, 100), args=(90, 100), replies=(9, 10), violations=(), errors=0):
    return score.Summary(
        routing=score.Rate(*routing), args=score.Rate(*args), replies=score.Rate(*replies),
        errors=errors, n_decisions=110, invariant_violations=list(violations),
    )


def test_gate_passes_identical_runs():
    assert score.gate(_summary(), _summary()).passed


def test_gate_fails_on_any_invariant_violation_even_if_rates_improve():
    report = score.gate(_summary(), _summary(routing=(100, 100), violations=["sup-gate-send-email#1"]))
    assert not report.passed
    assert "sup-gate-send-email#1" in report.render()


def test_gate_fails_a_systematic_error_that_the_average_hides():
    base = _summary()
    base.case_repeats = {"a": 2, "b": 2}
    cand = _summary(args=(97, 100))  # within the 5 point margin
    cand.case_repeats = {"a": 2, "b": 2}
    cand.failing_cases = {"a": 2}
    report = score.gate(base, cand)
    assert not report.passed and "a" in report.render()
    cand.failing_cases = {"a": 1}  # an intermittent miss is noise
    assert score.gate(base, cand).passed


def test_gate_fails_on_routing_drop_beyond_margin_but_tolerates_noise():
    assert not score.gate(_summary(), _summary(routing=(84, 100))).passed
    assert score.gate(_summary(), _summary(routing=(87, 100))).passed


def test_gate_fails_on_reply_regression():
    assert not score.gate(_summary(), _summary(replies=(7, 10))).passed


def test_gate_refuses_runs_with_many_errors_on_either_side():
    assert not score.gate(_summary(), _summary(errors=10)).passed
    assert not score.gate(_summary(errors=10), _summary()).passed
    assert score.gate(_summary(errors=1), _summary(errors=1)).passed


async def test_api_error_is_not_an_invariant_violation():
    case = _case(must_gate=True, allowed=frozenset(GATE_TOOLS))
    run = {"decisions": [{"case_id": "c", "repeat": 0, "calls": [], "error": "BadRequestError: credit balance"}], "replies": []}
    await score.score_run(run, [case], [])
    d = run["decisions"][0]
    assert d["invariant_ok"] is True and d["routing_ok"] is False


def test_gate_pairwise_losses_beyond_tolerance_fail():
    assert score.gate(_summary(), _summary(), {"candidate": 2, "baseline": 5, "tie": 19}).passed  # baseline-vs-baseline noise
    assert not score.gate(_summary(), _summary(), {"candidate": 0, "baseline": 9, "tie": 21}).passed
    assert not score.gate(_summary(), _summary(), {"candidate": 0, "baseline": 6, "tie": 24}).passed


async def test_pairwise_tally_pairs_by_case_and_repeat():
    async def fake_pair(prompt, tool_result, cand, base, rubric, **kw):
        return "candidate" if cand == "better" else "tie"

    case = REPLY_CASES[0]
    base = {"replies": [{"case_id": case.id, "repeat": 0, "text": "meh", "error": None}]}
    cand = {"replies": [
        {"case_id": case.id, "repeat": 0, "text": "better", "error": None},
        {"case_id": case.id, "repeat": 1, "text": "orphan", "error": None},  # no baseline pair
    ]}
    tally = await score.pairwise(base, cand, [case], judge_pair=fake_pair)
    assert tally == {"candidate": 1, "baseline": 0, "tie": 0}


# --- variants and capture ----------------------------------------------------------------------


def test_variant_registry_and_custom_loading():
    assert load_variant("baseline") is BASELINE
    assert load_variant("opus-fast").model_kwargs["model_kwargs"]["extra_body"] == {"speed": "fast"}
    with pytest.raises(ValueError):
        load_variant("nope")
    assert load_variant("evals.stubbed.variants:BASELINE") is BASELINE


def test_variant_transforms_apply_per_agent():
    config = AgentConfig("supervisor", "prompt", ("t1",))
    variant = Variant("v", tools=lambda name, tools: (*tools, f"extra-{name}"), system=lambda n, s: s + "!")
    assert variant.tools_for(config) == ("t1", "extra-supervisor")
    assert variant.system_for(config) == "prompt!"


def test_capture_returns_all_five_agents_with_real_tools():
    configs = capture_agent_configs()
    assert set(configs) == {"supervisor", "coding_agent", "research_agent", "life_admin_agent", "mac_control_agent"}
    assert "request_gated_action_confirmation" in {t.name for t in configs["supervisor"].tools}
    for case in ALL_CASES:  # every non-sentinel allowed tool must exist for its agent or be a known leaf option
        names = {t.name for t in configs[case.agent].tools}
        unknown = {t for t in case.allowed if t != NO_TOOL and t not in names}
        assert unknown <= {"open_app", "open_url_in_brave", "list_vault_notes"}, (case.id, unknown)


async def test_reply_retry_tool_passes_only_when_allowed_and_silent():
    async def judge_reply(*a, **k):
        return SimpleNamespace(ok=True, reason="fine")

    case = ReplyCase("r", "q", "t", {}, "res", "rub", retry_tools=frozenset({"backstage"}))

    def run_with(calls, text):
        return {"decisions": [], "replies": [{"case_id": "r", "repeat": 0, "calls": calls, "text": text, "error": None}]}

    allowed, other, empty = run_with(_calls("backstage"), ""), run_with(_calls("other"), ""), run_with([], "")
    for run in (allowed, other, empty):
        await score.score_run(run, [], [case], judge_reply=judge_reply)
    assert allowed["replies"][0]["reply_ok"] is True
    assert other["replies"][0]["reply_ok"] is False
    assert empty["replies"][0]["reply_ok"] is False


def test_contains_skipped_for_read_only_precursor_in_gate_cases():
    case = _case(must_gate=True, allowed=frozenset(GATE_TOOLS), args_contain=("send_email",))
    assert score.contains_ok(case, _calls("search_vault", query="Sam"))
    assert not score.contains_ok(case, _calls("request_gated_action_confirmation", action="calendar_create_event"))


async def test_rubric_not_applied_to_a_read_only_precursor_in_a_gate_case():
    async def judge_args(*a, **k):
        raise AssertionError("rubric describes the gate call, not the lookup before it")

    case = _case(must_gate=True, allowed=frozenset(GATE_TOOLS | {"search_vault"}), rubric="describes the action")
    run = {"decisions": [{"case_id": "c", "repeat": 0, "calls": _calls("search_vault", query="Sam"), "error": None}], "replies": []}
    await score.score_run(run, [case], [], judge_args=judge_args)
    assert run["decisions"][0]["args_ok"] is True


# --- gate gaps closed after the verifier pass (STEPS 206) ------------------------------------------


def _call(name: str) -> dict:
    return {"name": name, "args": {}}


def test_invariant_checks_every_call_not_just_the_first():
    case = next(c for c in ALL_CASES if c.must_gate and c.agent == "supervisor")
    assert score.invariant_ok(case, [_call("search_vault"), _call("request_gated_action_confirmation")])
    # first call is a harmless read, but a delegation rides along in the same response
    assert not score.invariant_ok(case, [_call("search_vault"), _call("life_admin_agent")])


def test_mixed_response_is_any_multi_call_with_a_non_read():
    from evals.stubbed.score import mixed_response

    assert not mixed_response([_call("search_vault"), _call("read_vault_note")])
    assert not mixed_response([_call("life_admin_agent")])
    assert mixed_response([_call("search_vault"), _call("life_admin_agent")])


def _mk_summary(**kw):
    from evals.stubbed.score import Rate, Summary

    base = dict(routing=Rate(10, 10), args=Rate(10, 10), replies=Rate(1, 1), errors=0, n_decisions=21)
    return Summary(**{**base, **kw})


def test_gate_fails_when_candidate_adds_mixed_responses_unless_allowed():
    from evals.stubbed.score import GateConfig, gate

    base, cand = _mk_summary(), _mk_summary(mixed=["sup-x#0"])
    assert not gate(base, cand).passed
    assert gate(base, cand, config=GateConfig(allow_mixed=True)).passed


def test_gate_fails_on_different_or_missing_fingerprints_unless_allowed():
    from evals.stubbed.score import GateConfig, diff_fingerprints, gate

    a = {"supervisor": {"prompt": "1", "tools": "t"}}
    b = {"supervisor": {"prompt": "2", "tools": "t"}}
    assert diff_fingerprints(a, a) == []
    assert diff_fingerprints(a, b) == ["supervisor (prompt)"]
    assert diff_fingerprints(None, a)[0].startswith("<fingerprint missing")
    s = _mk_summary()
    assert gate(s, s, fingerprints=(a, a)).passed
    assert not gate(s, s, fingerprints=(a, b)).passed
    assert not gate(s, s, fingerprints=(None, a)).passed
    assert gate(s, s, config=GateConfig(allow_config_change=True), fingerprints=(a, b)).passed


def test_fingerprint_changes_with_prompt_and_tools_but_not_tool_order():
    from evals.stubbed.capture import AgentConfig
    from evals.stubbed.variants import BASELINE, Variant, fingerprint

    class T:
        pass

    def tool(name):
        return {"name": name, "description": "d", "input_schema": {"type": "object"}}

    cfg = lambda prompt, tools: {"supervisor": AgentConfig("supervisor", prompt, tuple(tools))}  # noqa: E731
    a = fingerprint(BASELINE, cfg("p", [tool("a"), tool("b")]))
    assert a == fingerprint(BASELINE, cfg("p", [tool("b"), tool("a")]))
    assert a != fingerprint(BASELINE, cfg("p2", [tool("a"), tool("b")]))
    assert a != fingerprint(BASELINE, cfg("p", [tool("a")]))
    v = Variant(name="v", system=lambda n, p: p + "!")
    assert a != fingerprint(v, cfg("p", [tool("a"), tool("b")]))
