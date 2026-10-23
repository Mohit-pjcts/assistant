"""Tool-stubbed decision eval: a pass/fail gate for changes meant to make Oni faster or cheaper.

Why this exists (docs/SPEED_RESEARCH.md section 6): every speed idea that touches the supervisor or a
specialist (express lane, relay mode, parallel reads, model or effort changes) risks making Oni
quietly dumber, and `evals/supervisor_eval.py` cannot check that cheaply because it runs the real
specialists. This package measures only the *decision* a model makes, with every tool stubbed:

- The agent's real system prompt and real tool schemas are captured from the builders
  (`capture.py`), bound to a model, and the model's first response is read. **No tool is ever
  invoked**, so nothing is sent, written, opened or deleted.
- A case passes on three layers: routing (the first tool is an acceptable one), hard invariants
  (an action that must be gated is never delegated first; zero tolerance), and arguments
  (deterministic substring checks, then an LLM judge against a written rubric).
- Reply cases feed a canned tool result back and judge the final answer (facts kept, nothing
  invented), plus a pairwise comparison against a baseline run for changes like relay mode.
- `python -m evals.stubbed run --variant baseline --label base` records a run;
  `python -m evals.stubbed compare base candidate` exits non-zero if the candidate is worse.

Manual and cost-bounded, never scheduled (CLAUDE.md, Cost): a full run is on the order of $1.
"""
