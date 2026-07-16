"""Phase 16 Part A: push this project's system prompts into Langfuse as
managed prompts (label="production"), per the langfuse skill's
prompt-migration workflow (references/prompt-migration.md).

Manual, repeatable: NOT run automatically at app startup. Re-run this after
genuinely changing a prompt's local fallback text in supervisor.py/
sub_agents.py/compaction.py, to push the update — `create_prompt()` creates
a new version each time, and "production" always points at the latest push.

Deliberately excludes assistant/memory_extraction.py's `_EXTRACTION_PROMPT`
— see assistant/prompts.py's module docstring for the full reasoning (that
prompt backs a structural, not instruction-based, security guarantee and
was deliberately kept local-only).

Run: python scripts/sync_prompts_to_langfuse.py
"""

from __future__ import annotations

from dotenv import load_dotenv

load_dotenv()

from assistant import observability  # noqa: E402
from assistant.compaction import _SUMMARY_PROMPT_FALLBACK  # noqa: E402
from assistant.sub_agents import (  # noqa: E402
    CODING_SYSTEM_PROMPT_FALLBACK,
    LIFE_ADMIN_SYSTEM_PROMPT_FALLBACK,
    MAC_CONTROL_SYSTEM_PROMPT_FALLBACK,
    RESEARCH_SYSTEM_PROMPT_FALLBACK,
)
from assistant.supervisor import SUPERVISOR_SYSTEM_PROMPT_FALLBACK  # noqa: E402

# (Langfuse prompt name, local fallback text to push as the new version)
_PROMPTS = [
    ("supervisor-system-prompt", SUPERVISOR_SYSTEM_PROMPT_FALLBACK),
    ("coding-agent-system-prompt", CODING_SYSTEM_PROMPT_FALLBACK),
    ("research-agent-system-prompt", RESEARCH_SYSTEM_PROMPT_FALLBACK),
    ("life-admin-agent-system-prompt", LIFE_ADMIN_SYSTEM_PROMPT_FALLBACK),
    ("mac-control-agent-system-prompt", MAC_CONTROL_SYSTEM_PROMPT_FALLBACK),
    ("compaction-summary-prompt", _SUMMARY_PROMPT_FALLBACK),
]


def main() -> None:
    client = observability.get_client()
    if client is None:
        raise SystemExit(
            "LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY not configured — nothing to sync."
        )
    for name, text in _PROMPTS:
        client.create_prompt(name=name, prompt=text, type="text", labels=["production"])
        print(f"synced: {name} ({len(text)} chars)")
    client.flush()
    print(f"Done — {len(_PROMPTS)} prompts synced to Langfuse (label=production).")


if __name__ == "__main__":
    main()
