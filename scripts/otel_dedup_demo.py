"""Phase 16 Part B, Task 12 demo: the OTEL auto-instrumentation duplicate-span
problem, and its fix via `blocked_instrumentation_scopes` — the "why v3
matters" migration artifact.

This project's real LLM calls already go through `langchain-anthropic`'s
`ChatAnthropic`, which this project traces via `observability.py`'s
LangChain `CallbackHandler`. If a process ALSO turns on generic OTEL
auto-instrumentation for the raw `anthropic` SDK (e.g. `opentelemetry-
instrumentation-anthropic` — something an org-wide OTEL agent or a second
team member might add without realizing this project already traces
Anthropic calls another way), every call now produces TWO Langfuse
observations for the same underlying API request: the LangChain callback's
own `ChatAnthropic` generation, and a nested `anthropic.chat` generation
from the auto-instrumentor — because `ChatAnthropic` uses the real
`anthropic` SDK client under the hood, and that's exactly what got patched.

Confirmed this isn't hypothetical: Langfuse v3's OWN default span filter
already allowlists `opentelemetry.instrumentation.anthropic` as a "known LLM
instrumentation scope" (langfuse.com/docs/observability/sdk/advanced-
features, fetched live for this task) — so the duplicate is exported by
default, no `should_export_span=lambda span: True` override needed to
reproduce it.

`blocked_instrumentation_scopes` is the fix for this project's actual
pinned SDK (`langfuse==3.15.0`) — Langfuse's current docs describe a newer
`should_export_span`/`langfuse.span_filter` mechanism as the "recommended"
replacement, but that API only ships starting in Langfuse Python SDK 4.x
(confirmed via `inspect.signature(Langfuse.__init__)`/`pkgutil.
iter_modules()` against this project's real venv, not assumed from the
docs' version) — this project's migration target is v3, not v4.

Run each mode in its OWN fresh process — OTEL's `TracerProvider` is a
process-wide singleton that can't be reconfigured after first construction,
so "toggle a filter mid-process" was never going to produce a clean
before/after read.

Requires `opentelemetry-instrumentation-anthropic` (NOT a project
dependency — demo-only, install with
`pip install opentelemetry-instrumentation-anthropic` first).

Run:
    python scripts/otel_dedup_demo.py --before
    python scripts/otel_dedup_demo.py --after
Then compare the two resulting traces (session_id "otel-demo-before" vs.
"otel-demo-after") in the Langfuse UI, or fetch them via
`client.api.observations.get_many(trace_id=...)` — STEPS.md 87 has the
exact live counts this script was built from (2 observations before, 1
after: only the LangChain callback's own `ChatAnthropic` generation
survives in "after", the nested `anthropic.chat` OTEL duplicate is gone).
"""

from __future__ import annotations

import argparse
import asyncio

from dotenv import load_dotenv

load_dotenv()

from opentelemetry.instrumentation.anthropic import AnthropicInstrumentor  # noqa: E402

AnthropicInstrumentor().instrument()

from langchain_anthropic import ChatAnthropic  # noqa: E402
from langfuse import Langfuse, propagate_attributes  # noqa: E402
from langfuse.langchain import CallbackHandler  # noqa: E402

BLOCKED_SCOPES = ["opentelemetry.instrumentation.anthropic"]


async def _run(mode: str) -> None:
    session_id = f"otel-demo-{mode}"
    client = (
        Langfuse()
        if mode == "before"
        # Default span filter, no override — reproduces the duplicate "out
        # of the box", since this scope is already in Langfuse's own
        # default allowlist.
        else Langfuse(blocked_instrumentation_scopes=BLOCKED_SCOPES)
    )
    handler = CallbackHandler()
    model = ChatAnthropic(model="claude-haiku-4-5", max_tokens=100)

    with propagate_attributes(
        session_id=session_id, trace_name="otel-dedup-demo", tags=[f"demo:{mode}"]
    ):
        result = await model.ainvoke(
            "Say hello in exactly five words.",
            config={"callbacks": [handler]},
        )
    print("REPLY:", result.content)
    client.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--before", action="store_const", dest="mode", const="before",
        help="Default span filter — reproduces the duplicate span.",
    )
    group.add_argument(
        "--after", action="store_const", dest="mode", const="after",
        help="blocked_instrumentation_scopes applied — the duplicate is gone.",
    )
    args = parser.parse_args()
    asyncio.run(_run(args.mode))


if __name__ == "__main__":
    main()
