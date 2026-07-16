"""Phase 16 Part A (STEPS.md 82): Langfuse prompt management.

Fetches this project's system prompts from Langfuse at runtime (label
"production"), with the ORIGINAL local text always kept as a mandatory
fallback — Langfuse is an override source here, never the sole source of
truth. A missing/unreachable/misconfigured Langfuse account must never
prevent an agent from building; every call site keeps its exact original
prompt text as `fallback`, unchanged from before this module existed.

Reuses `observability.get_client()` (same credentials, same lazy singleton
the CallbackHandler already owns — no second client/connection).

Prompts are pushed into Langfuse by `scripts/sync_prompts_to_langfuse.py`
(run manually, repeatable — see that script's own docstring), not
automatically at runtime. This module only ever reads.

**Deliberately excludes `memory_extraction.py`'s `_EXTRACTION_PROMPT`.**
Every prompt migrated here is a normal agent system prompt whose security
properties already depend on the model choosing to follow instructions — a
"soft" trust boundary, not categorically different from, say, a compromised
git-write-access scenario touching `sub_agents.py` directly. The extraction
prompt is different in kind: Phase 7 Part B's source-restriction guarantee
is explicitly STRUCTURAL, not instruction-based — built specifically NOT to
depend on the model being told the right thing, because prompt-level
defenses were judged insufficient for that one channel (a durable memory
write outliving a single turn). Making that prompt's TEXT fetchable from a
third-party account would add a new prompt-supply-chain trust dependency to
the one place in this project explicitly designed not to need it.
CLAUDE.md's "do not weaken without discussion" standing note on that module
applies here — so it stays a local-only constant, unmigrated, on purpose,
not an oversight.
"""

from __future__ import annotations

import logging

from assistant import observability

logger = logging.getLogger(__name__)


def _compile_local(template: str, /, **variables: str) -> str:
    """Mirrors Langfuse's own `{{var}}` substitution (simple replacement
    only — no conditionals/loops, per Langfuse's own documented templating
    limits) so the fallback path behaves identically to a real
    Langfuse-hosted prompt, whether or not a client exists at all.
    `template` is positional-only for the same reason `get_prompt()`'s
    `name`/`fallback` are — a `{{template}}` variable shouldn't collide with
    this function's own parameter name."""
    result = template
    for key, value in variables.items():
        result = result.replace("{{" + key + "}}", value)
    return result


def get_prompt(name: str, fallback: str, /, **variables: str) -> str:
    """Fetch a text prompt from Langfuse (label="production"), compiling
    `{{var}}` placeholders with `variables` if given. Falls back to
    `fallback` — compiled the same way — if Langfuse isn't configured,
    unreachable, or the prompt doesn't exist there yet. Never raises: a bad
    Langfuse config must not prevent an agent from building.

    `name`/`fallback` are positional-only (the `/`) — caught live by this
    module's own test suite: a template prompt with a `{{name}}` or
    `{{fallback}}` variable couldn't be compiled at all without this, since
    `variables["name"]` would collide with this function's own `name`
    parameter. None of this project's current prompts happen to use those
    words as variables, but the API shouldn't silently break the day one
    does.

    Uses the SDK's own native `fallback=` support on `get_prompt()` (not a
    hand-rolled try/except only) — verified against the real installed
    source that this returns a real, `.compile()`-able prompt client
    wrapping the fallback text on any fetch error, not just a bare string.
    """
    client = observability.get_client()
    if client is None:
        return _compile_local(fallback, **variables)
    try:
        prompt = client.get_prompt(name, label="production", fallback=fallback)
        return prompt.compile(**variables)
    except Exception:
        logger.warning("Langfuse prompt %r unavailable, using local fallback", name, exc_info=True)
        return _compile_local(fallback, **variables)
