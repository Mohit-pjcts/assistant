"""CLI: python -m evals.stubbed {run,compare,judge-selftest,cases}. See package docstring."""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env")
# This eval makes hundreds of throwaway calls; do not send them to LangSmith (the project's .env
# enables tracing, and its monthly trace quota is already exhausted).
for _flag in ("LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING", "LANGCHAIN_TRACING"):
    os.environ[_flag] = "false"

from evals.stubbed import judge as judge_module  # noqa: E402
from evals.stubbed import score  # noqa: E402
from evals.stubbed.capture import capture_agent_configs  # noqa: E402
from evals.stubbed.cases import ALL_CASES, REPLY_CASES  # noqa: E402
from evals.stubbed.runner import run_all  # noqa: E402
from evals.stubbed.variants import fingerprint, load_variant  # noqa: E402

RUNS_DIR = Path(__file__).resolve().parents[1] / "stubbed_runs"
# Observed on the first benchmarks (docs/SPEED_RESEARCH.md): ~$0.005 per supervisor decision with
# a warm prompt cache, less for specialists. Deliberately a little high.
_COST_PER_DECISION = {"supervisor": 0.007}
_DEFAULT_COST = 0.003


def _select(args: argparse.Namespace):
    cases = [c for c in ALL_CASES if (not args.agent or c.agent in args.agent) and (not args.ids or c.id in args.ids)]
    replies = [] if args.skip_replies or args.agent and "supervisor" not in args.agent else list(REPLY_CASES)
    if args.ids:
        replies = [r for r in replies if r.id in args.ids]
    return cases, replies


def _estimate(cases, replies, repeats: int) -> float:
    per = sum(_COST_PER_DECISION.get(c.agent, _DEFAULT_COST) for c in cases) + 0.007 * len(replies)
    return per * repeats


def _path(label: str) -> Path:
    return RUNS_DIR / f"{score.safe_label(label)}.json"


def _print_summary(label: str, s: score.Summary) -> None:
    print(f"\n== {label} ==")
    print(f"routing     {s.routing}")
    print(f"arguments   {s.args}")
    print(f"replies     {s.replies}")
    print(f"errors      {s.errors} of {s.n_decisions}   mean first token {s.mean_first_s:.2f}s   mean total {s.mean_total_s:.2f}s")
    print(f"invariant violations: {s.invariant_violations or 'none'}")
    if s.mixed:
        print(f"mixed parallel responses: {len(s.mixed)} ({', '.join(s.mixed[:6])})")
    if s.failing_cases:
        print("cases with any failing repeat (id: failing repeats):")
        for cid, n in list(s.failing_cases.items())[:25]:
            print(f"  {cid}: {n}")


async def cmd_run(args: argparse.Namespace) -> int:
    cases, replies = _select(args)
    if _path(args.label).exists() and not args.force and not args.dry_run:
        print(f"{_path(args.label)} exists; choose another --label or pass --force to overwrite it")
        return 1
    cost = _estimate(cases, replies, args.repeats)
    print(f"{len(cases)} decision cases + {len(replies)} reply cases x {args.repeats} repeats; est. ${cost:.2f}")
    if args.dry_run:
        return 0
    variant = load_variant(args.variant)
    configs = capture_agent_configs()
    run = await run_all(variant, configs, cases, replies, repeats=args.repeats, concurrency=args.concurrency)
    await score.score_run(run, cases, replies, judge_model=args.judge_model)
    errored = sum(1 for d in run["decisions"] + run["replies"] if d["error"])
    total = len(run["decisions"]) + len(run["replies"])
    target = _path(args.label)
    if errored > 0.02 * total:
        target = target.with_suffix(".invalid.json")
        sample = next(d["error"] for d in run["decisions"] + run["replies"] if d["error"])
        print(f"WARNING: {errored}/{total} calls errored (e.g. {sample[:140]}); this run is invalid.")
    run.update(label=args.label, variant=variant.name, model=variant.model, repeats=args.repeats,
               created=dt.datetime.now().isoformat(timespec="seconds"), judge_model=args.judge_model,
               fingerprint=fingerprint(variant, configs))
    RUNS_DIR.mkdir(exist_ok=True)
    target.write_text(json.dumps(run, indent=1, ensure_ascii=False, default=str))
    _print_summary(args.label, score.summarize(run, cases))
    print(f"\nsaved {target}")
    return 0


async def cmd_rescore(args: argparse.Namespace) -> int:
    """Re-apply the checks to a saved run (no new model calls except judge calls that newly apply).

    Use after changing the routing/invariant rules or a rubric. A decision whose recorded prompt
    differs from the case's current prompt is refused, since its answer no longer belongs to the case.
    """
    run = json.loads(_path(args.label).read_text())
    prompts = {c.id: c.prompt for c in ALL_CASES}
    stale = [d["case_id"] for d in run["decisions"] if "prompt" in d and d["prompt"] != prompts.get(d["case_id"])]
    unknown = [d["case_id"] for d in run["decisions"] if d["case_id"] not in prompts]
    if stale or unknown:
        print(f"refusing: stale prompts {sorted(set(stale))[:5]}, unknown cases {sorted(set(unknown))[:5]}; rerun instead")
        return 1
    if any("prompt" not in d for d in run["decisions"]) and not args.trust_missing_prompt:
        print("run predates prompt recording; pass --trust-missing-prompt if the case prompts are unchanged since")
        return 1
    await score.score_run(run, list(ALL_CASES), list(REPLY_CASES), judge_model=args.judge_model)
    _path(args.label).write_text(json.dumps(run, indent=1, ensure_ascii=False, default=str))
    _print_summary(args.label, score.summarize(run, list(ALL_CASES)))
    return 0


async def cmd_compare(args: argparse.Namespace) -> int:
    base = json.loads(_path(args.baseline).read_text())
    cand = json.loads(_path(args.candidate).read_text())
    cases = list(ALL_CASES)
    base_s, cand_s = score.summarize(base, cases), score.summarize(cand, cases)
    _print_summary(f"baseline: {args.baseline}", base_s)
    _print_summary(f"candidate: {args.candidate}", cand_s)
    pairs = None if args.no_pairwise else await score.pairwise(base, cand, REPLY_CASES, judge_model=args.judge_model)
    print()
    config = score.GateConfig(allow_mixed=args.allow_mixed, allow_config_change=args.allow_config_change)
    report = score.gate(base_s, cand_s, pairs, config, fingerprints=(base.get("fingerprint"), cand.get("fingerprint")))
    print(report.render())
    return 0 if report.passed else 1


async def cmd_selftest(args: argparse.Namespace) -> int:
    from evals.stubbed.judge_selftest import run_selftest

    passed, total, failures = await run_selftest(args.judge_model)
    print(f"judge self-test ({args.judge_model}): {passed}/{total}")
    for f in failures:
        print("  FAIL", f)
    return 0 if not failures else 1


def cmd_cases(args: argparse.Namespace) -> int:
    for c in ALL_CASES:
        print(f"{c.agent:18} {c.id:32} -> {sorted(c.allowed)}{'  [GATE]' if c.must_gate else ''}")
    print(f"{len(ALL_CASES)} decision cases, {len(REPLY_CASES)} reply cases")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m evals.stubbed")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run all cases against a variant and save the scored result")
    r.add_argument("--variant", default="baseline")
    r.add_argument("--label", required=True)
    r.add_argument("--repeats", type=int, default=3)
    r.add_argument("--concurrency", type=int, default=6)
    r.add_argument("--agent", action="append", help="limit to an agent (repeatable)")
    r.add_argument("--ids", action="append", help="limit to a case id (repeatable)")
    r.add_argument("--skip-replies", action="store_true")
    r.add_argument("--judge-model", default=judge_module.JUDGE_MODEL)
    r.add_argument("--force", action="store_true", help="overwrite an existing run with this label")
    r.add_argument("--dry-run", action="store_true", help="print counts and the cost estimate only")
    c = sub.add_parser("compare", help="gate a candidate run against a baseline run (exit 1 on fail)")
    c.add_argument("baseline")
    c.add_argument("candidate")
    c.add_argument("--no-pairwise", action="store_true")
    c.add_argument("--allow-mixed", action="store_true", help="candidate may emit more parallel non-read responses (ships the guard)")
    c.add_argument("--allow-config-change", action="store_true", help="the prompt/tool edit is the thing under test")
    c.add_argument("--judge-model", default=judge_module.JUDGE_MODEL)
    rs = sub.add_parser("rescore", help="re-apply checks to a saved run after changing rules or rubrics")
    rs.add_argument("label")
    rs.add_argument("--trust-missing-prompt", action="store_true")
    rs.add_argument("--judge-model", default=judge_module.JUDGE_MODEL)
    s = sub.add_parser("judge-selftest", help="known-answer check of the judge; must be 100% before trusting a gate")
    s.add_argument("--judge-model", default=judge_module.JUDGE_MODEL)
    sub.add_parser("cases", help="list the cases")
    args = p.parse_args(argv)
    if args.cmd == "cases":
        return cmd_cases(args)
    handler = {"run": cmd_run, "rescore": cmd_rescore, "compare": cmd_compare, "judge-selftest": cmd_selftest}[args.cmd]
    return asyncio.run(handler(args))


if __name__ == "__main__":
    sys.exit(main())
