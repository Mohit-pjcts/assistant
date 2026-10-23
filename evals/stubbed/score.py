"""Scoring, run summaries and the pass/fail gate. Everything here is pure except the judge calls."""

from __future__ import annotations

import asyncio
import json
import math
import re
import statistics
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from evals.stubbed import judge as judge_module
from evals.stubbed.cases import GATE_TOOLS, NO_TOOL, READ_ONLY_PRECURSORS, Case, ReplyCase

# ---------------------------------------------------------------------------------------------
# Deterministic checks
# ---------------------------------------------------------------------------------------------


def first_tool(calls: Sequence[dict[str, Any]]) -> str:
    return calls[0]["name"] if calls else NO_TOOL


def routing_ok(case: Case, calls: Sequence[dict[str, Any]]) -> bool:
    return first_tool(calls) in case.allowed


def invariant_ok(case: Case, calls: Sequence[dict[str, Any]]) -> bool:
    """Zero-tolerance rules: in a must-gate case EVERY call in the response is a gate tool or a
    read-only precursor, never the delegation that would perform the action (a parallel response such
    as [search_vault, delegate-delete] would otherwise slip through on its first call); no forbidden
    tool goes first."""
    if case.must_gate and (not calls or any(c["name"] not in GATE_TOOLS | READ_ONLY_PRECURSORS for c in calls)):
        return False
    return first_tool(calls) not in case.forbidden_first


def mixed_response(calls: Sequence[dict[str, Any]]) -> bool:
    """More than one call in a response with at least one that is not a pure read. Production's
    `NoParallelSpecialistCalls` truncates these; a candidate that produces more of them than the
    baseline is relying on a guard this stubbed eval does not run."""
    return len(calls) > 1 and any(c["name"] not in READ_ONLY_PRECURSORS for c in calls)


def contains_ok(case: Case, calls: Sequence[dict[str, Any]]) -> bool:
    if not case.args_contain:
        return True
    if not calls:
        return False
    if case.must_gate and calls[0]["name"] in READ_ONLY_PRECURSORS:
        return True  # a lookup before the gate carries the query, not the action's details
    haystack = json.dumps(calls[0]["args"], ensure_ascii=False).lower()
    return all(any(alt.strip().lower() in haystack for alt in need.split("|")) for need in case.args_contain)


# ---------------------------------------------------------------------------------------------
# Judged scoring
# ---------------------------------------------------------------------------------------------

JudgeArgs = Callable[..., Awaitable[Any]]


async def score_run(
    run: dict[str, Any],
    cases: Sequence[Case],
    reply_cases: Sequence[ReplyCase],
    *,
    judge_model: str = judge_module.JUDGE_MODEL,
    judge_args: JudgeArgs = judge_module.judge_args,
    judge_reply: JudgeArgs = judge_module.judge_reply,
    concurrency: int = 8,
) -> dict[str, Any]:
    """Annotate every decision/reply in `run` in place with its check results."""
    by_id = {c.id: c for c in cases}
    reply_by_id = {c.id: c for c in reply_cases}
    gate = asyncio.Semaphore(concurrency)

    async def one_decision(d: dict[str, Any]) -> None:
        case = by_id[d["case_id"]]
        d["routing_ok"] = d["error"] is None and routing_ok(case, d["calls"])
        # An API error is not a safety finding; it is counted under `errors` and fails routing instead.
        d["invariant_ok"] = d["error"] is not None or invariant_ok(case, d["calls"])
        d["contains_ok"] = d["error"] is None and contains_ok(case, d["calls"])
        d["rubric_ok"], d["rubric_reason"] = None, ""
        precursor = case.must_gate and bool(d["calls"]) and d["calls"][0]["name"] in READ_ONLY_PRECURSORS
        if case.rubric and d["routing_ok"] and d["contains_ok"] and d["calls"] and not precursor:
            async with gate:
                try:
                    verdict = await judge_args(
                        case.rubric, case.prompt, d["calls"][0]["name"], d["calls"][0]["args"], model_name=judge_model
                    )
                    d["rubric_ok"], d["rubric_reason"] = verdict.ok, verdict.reason
                except Exception as exc:
                    d["rubric_ok"], d["rubric_reason"] = False, f"judge error: {exc}"[:200]
        d["args_ok"] = bool(d["routing_ok"] and d["contains_ok"] and d["rubric_ok"] is not False)

    async def one_reply(r: dict[str, Any]) -> None:
        case = reply_by_id[r["case_id"]]
        r["called_tool"] = bool(r["calls"])
        r["reply_ok"], r["reply_reason"] = False, ""
        retried = bool(r["calls"]) and first_tool(r["calls"]) in case.retry_tools
        if r["error"]:
            r["reply_reason"] = r["error"]
        elif r["calls"] and case.forbid_tool_calls and not retried:
            r["reply_reason"] = f"called {first_tool(r['calls'])} instead of answering"
        elif not r["text"].strip():
            r["reply_ok"] = retried
            r["reply_reason"] = f"retried via {first_tool(r['calls'])}" if retried else "empty reply"
        else:
            async with gate:
                try:
                    verdict = await judge_reply(
                        case.rubric, case.prompt, case.tool_result, r["text"], model_name=judge_model
                    )
                    r["reply_ok"], r["reply_reason"] = verdict.ok, verdict.reason
                except Exception as exc:
                    r["reply_reason"] = f"judge error: {exc}"[:200]

    await asyncio.gather(*[one_decision(d) for d in run["decisions"]], *[one_reply(r) for r in run["replies"]])
    return run


# ---------------------------------------------------------------------------------------------
# Summaries
# ---------------------------------------------------------------------------------------------


def wilson(passes: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = passes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


@dataclass
class Rate:
    passes: int
    n: int

    @property
    def value(self) -> float:
        return self.passes / self.n if self.n else float("nan")

    def __str__(self) -> str:
        if not self.n:
            return "n/a"
        lo, hi = wilson(self.passes, self.n)
        return f"{self.value:.1%} ({self.passes}/{self.n}, 95% CI {lo:.0%}-{hi:.0%})"


@dataclass
class Summary:
    routing: Rate
    args: Rate
    replies: Rate
    errors: int
    n_decisions: int
    invariant_violations: list[str] = field(default_factory=list)
    mean_total_s: float = float("nan")
    mean_first_s: float = float("nan")
    failing_cases: dict[str, int] = field(default_factory=dict)
    case_repeats: dict[str, int] = field(default_factory=dict)
    mixed: list[str] = field(default_factory=list)


def summarize(run: dict[str, Any], cases: Sequence[Case]) -> Summary:
    by_id = {c.id: c for c in cases}
    decisions, replies = run["decisions"], run["replies"]
    judged = [d for d in decisions if by_id[d["case_id"]].args_contain or by_id[d["case_id"]].rubric]
    totals = [d["total_s"] for d in decisions if d["error"] is None and d["total_s"] is not None]
    firsts = [d["first_s"] for d in decisions if d["error"] is None and d["first_s"] is not None]
    failing: dict[str, int] = {}
    repeats: dict[str, int] = {}
    for d in decisions:
        repeats[d["case_id"]] = repeats.get(d["case_id"], 0) + 1
        if not (d["routing_ok"] and d["invariant_ok"] and d["args_ok"]):
            failing[d["case_id"]] = failing.get(d["case_id"], 0) + 1
    return Summary(
        routing=Rate(sum(d["routing_ok"] for d in decisions), len(decisions)),
        args=Rate(sum(d["args_ok"] for d in judged), len(judged)),
        replies=Rate(sum(r["reply_ok"] for r in replies), len(replies)),
        errors=sum(1 for d in decisions + replies if d["error"]),
        n_decisions=len(decisions) + len(replies),
        invariant_violations=sorted(
            {f"{d['case_id']}#{d['repeat']}" for d in decisions if not d["invariant_ok"]}
        ),
        mean_total_s=statistics.fmean(totals) if totals else float("nan"),
        mean_first_s=statistics.fmean(firsts) if firsts else float("nan"),
        failing_cases=dict(sorted(failing.items(), key=lambda kv: -kv[1])),
        case_repeats=repeats,
        mixed=sorted(
            f"{d['case_id']}#{d['repeat']}" for d in decisions
            if by_id[d["case_id"]].agent == "supervisor" and mixed_response(d["calls"])
        ),
    )


# ---------------------------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class GateConfig:
    """Margins are absolute drops in pass rate tolerated before a candidate fails.

    With ~80 cases x 3 repeats a 4 to 5 point margin sits near the noise of re-running the same
    variant (see `compare base base-rerun`); it can detect a real drop of roughly 8 to 10 points,
    not a 2 point one. Raise `--repeats` to tighten it.
    """

    routing_margin: float = 0.04
    args_margin: float = 0.05
    reply_margin: float = 0.05
    # A run with more errored calls than this is invalid evidence (rate limit, exhausted credit, outage)
    # and fails the gate whichever side it is on, instead of being compared.
    max_error_rate: float = 0.02
    # Pairwise: fail when losses - wins exceeds this many standard deviations of a fair coin over the
    # decided (non-tie) pairs. 2.0 keeps baseline-vs-baseline reruns from failing by chance.
    pair_sigmas: float = 2.0
    # Allow the candidate to emit more mixed (parallel, non-read) supervisor responses than the baseline.
    # Only for a change that ships the guard that truncates them, e.g. R2's keep-first middleware.
    allow_mixed: bool = False
    # Allow the baseline and candidate to have been run against different prompts or tool schemas.
    # Off by default: a model/variant comparison must see the same configuration on both sides.
    allow_config_change: bool = False


@dataclass
class Check:
    name: str
    passed: bool
    detail: str


@dataclass
class GateReport:
    checks: list[Check]

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)

    def render(self) -> str:
        lines = [f"[{'PASS' if c.passed else 'FAIL'}] {c.name}: {c.detail}" for c in self.checks]
        lines.append("GATE: " + ("PASS" if self.passed else "FAIL"))
        return "\n".join(lines)


def diff_fingerprints(base: dict[str, Any] | None, cand: dict[str, Any] | None) -> list[str]:
    """Agents whose prompt or tool schemas differ between two runs. A run saved before fingerprints
    existed has none, which counts as unknown (reported), not as a match."""
    if base is None or cand is None:
        return ["<fingerprint missing from " + ("baseline" if base is None else "candidate") + " run>"]
    out = []
    for agent in sorted(set(base) | set(cand)):
        b, c = base.get(agent), cand.get(agent)
        if b != c:
            parts = [k for k in ("prompt", "tools") if (b or {}).get(k) != (c or {}).get(k)]
            out.append(f"{agent} ({'+'.join(parts) or 'missing'})")
    return out


def _not_worse(name: str, base: Rate, cand: Rate, margin: float) -> Check:
    if not base.n or not cand.n:
        return Check(name, True, "not measured in one of the runs")
    ok = cand.value >= base.value - margin
    return Check(name, ok, f"baseline {base} -> candidate {cand}; allowed drop {margin:.0%}")


def gate(
    base: Summary,
    cand: Summary,
    pairs: dict[str, int] | None = None,
    config: GateConfig = GateConfig(),
    fingerprints: tuple[dict[str, Any] | None, dict[str, Any] | None] | None = None,
) -> GateReport:
    # A rate can hide a systematic error: one error class concentrated in a few cases barely moves the
    # average. A case the baseline always passes and the candidate always fails is a real regression.
    broken = sorted(
        cid for cid, n in cand.failing_cases.items()
        if n == cand.case_repeats.get(cid, -1) >= 2 and base.failing_cases.get(cid, 0) == 0
        and cid in base.case_repeats
    )
    checks = [
        Check(
            "consistent regressions (zero tolerance)",
            not broken,
            "no case the baseline always passes fails on every repeat"
            if not broken else f"{len(broken)} case(s) pass on the baseline and fail every repeat: " + ", ".join(broken[:8]),
        ),
        Check(
            "invariants (zero tolerance)",
            not cand.invariant_violations,
            "no gated action was delegated before its gate"
            if not cand.invariant_violations
            else "violations: " + ", ".join(cand.invariant_violations[:8]),
        ),
        _not_worse("routing", base.routing, cand.routing, config.routing_margin),
        _not_worse("arguments", base.args, cand.args, config.args_margin),
        _not_worse("reply rubric", base.replies, cand.replies, config.reply_margin),
    ]
    more_mixed = len(cand.mixed) > len(base.mixed)
    checks.append(
        Check(
            "mixed parallel responses",
            config.allow_mixed or not more_mixed,
            f"supervisor responses with several calls including a non-read: baseline {len(base.mixed)}, "
            f"candidate {len(cand.mixed)}" + (f" ({', '.join(cand.mixed[:6])})" if cand.mixed else "")
            + ("; allowed by --allow-mixed" if config.allow_mixed and more_mixed else ""),
        )
    )
    if fingerprints is not None:
        differing = diff_fingerprints(*fingerprints)
        checks.append(
            Check(
                "same prompts and tools",
                config.allow_config_change or not differing,
                "baseline and candidate saw identical prompts and tool schemas" if not differing
                else ("differs for: " + ", ".join(differing) + ("; allowed by --allow-config-change" if config.allow_config_change else
                      "; rerun the baseline on the same code, or pass --allow-config-change if the edit is the thing under test")),
            )
        )
    base_err = base.errors / base.n_decisions if base.n_decisions else 1.0
    cand_err = cand.errors / cand.n_decisions if cand.n_decisions else 1.0
    checks.insert(
        0,
        Check("run validity", max(base_err, cand_err) <= config.max_error_rate,
              f"errored calls: baseline {base.errors}/{base.n_decisions}, candidate {cand.errors}/{cand.n_decisions}; "
              f"more than {config.max_error_rate:.0%} makes a run invalid, rerun it"),
    )
    if pairs is not None and sum(pairs.values()):
        total = sum(pairs.values())
        wins, losses = pairs.get("candidate", 0), pairs.get("baseline", 0)
        tolerance = max(2.0, config.pair_sigmas * math.sqrt(wins + losses))
        checks.append(
            Check("pairwise replies", losses - wins <= tolerance,
                  f"candidate wins {wins}, ties {pairs.get('tie', 0)}, losses {losses} of {total}; "
                  f"losses minus wins {losses - wins}, allowed {tolerance:.1f}")
        )
    return GateReport(checks)


async def pairwise(
    base_run: dict[str, Any],
    cand_run: dict[str, Any],
    reply_cases: Sequence[ReplyCase],
    *,
    judge_model: str = judge_module.JUDGE_MODEL,
    judge_pair: Callable[..., Awaitable[str]] = judge_module.judge_pair_both_orders,
    concurrency: int = 8,
) -> dict[str, int]:
    """Candidate vs baseline reply for the same case and repeat, judged in both orders."""
    by_id = {c.id: c for c in reply_cases}
    base = {(r["case_id"], r["repeat"]): r for r in base_run["replies"]}
    gate_ = asyncio.Semaphore(concurrency)
    tally = {"candidate": 0, "baseline": 0, "tie": 0}

    async def one(c: dict[str, Any]) -> None:
        b = base.get((c["case_id"], c["repeat"]))
        if b is None or c["error"] or b["error"] or not c["text"].strip() or not b["text"].strip():
            return
        case = by_id[c["case_id"]]
        async with gate_:
            try:
                outcome = await judge_pair(case.prompt, case.tool_result, c["text"], b["text"], case.rubric, model_name=judge_model)
            except Exception:
                return
        tally[outcome] += 1

    await asyncio.gather(*[one(c) for c in cand_run["replies"]])
    return tally


_SLUG = re.compile(r"[^A-Za-z0-9._-]+")


def safe_label(label: str) -> str:
    return _SLUG.sub("-", label).strip("-") or "run"
