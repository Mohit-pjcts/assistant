"""Repair middleware for a confirmed langchain-anthropic streaming bug that
corrupts extended-thinking content blocks (STEPS.md 28, revisited/reproduced
live at Phase 10's resume checkpoint, STEPS.md 73/74).

**The bug:** `langchain-anthropic`==1.4.8 (still the latest release on PyPI
as of this writing — no upstream fix exists) merges streamed SSE events into
an `AIMessageChunk` via `chat_models.py`'s `content_block_start`/
`content_block_delta` handling. For a `thinking`-type block, the
`content_block_start` handler only emits a starter chunk `if thinking or
signature` on that opening event. When Anthropic returns a thinking block
whose visible text is empty (a real, common case with `thinking={"type":
"adaptive"}` — the model "thought" but the summarized reasoning shown back
is blank) AND the opening event carries no signature yet either, no starter
chunk is emitted at all. The block is then built purely from a later
`signature_delta` event, whose own `model_dump()` never carries a `thinking`
key. The final merged message ends up with `signature` set but NO
`thinking` key whatsoever (not just an empty string) — confirmed via direct
`AIMessageChunk` construction and, live at this checkpoint, via a real
streamed API call on `claude-sonnet-5` that hit this on the very first
attempt. When that malformed block is later replayed back to Anthropic
(required for any multi-turn tool-calling loop, which is how every agent
here works), the API rejects it: `messages.N.content.0.thinking.thinking:
Field required`.

**Why the fix is safe:** the missing key only ever occurs when the visible
thinking text was genuinely empty to begin with (that's the exact bug
condition — no thinking_delta events ever fired for that block, since a
thinking_delta's own model_dump() DOES carry a "thinking" key and would have
been merged in if it existed). Patching a message that hits this shape with
`"thinking": ""` therefore fabricates nothing — it fills in exactly the
value that was already true, in the shape Anthropic's own non-streaming path
already returns it (`ainvoke()` responses arrive with `"thinking": ""`
present, never absent, confirmed live at this checkpoint). The real
signature — required for Anthropic to verify the reasoning trace on replay
— is left untouched.

**Verified live, real API, this checkpoint (STEPS.md 73/74):** reproduced
the malformed shape via `astream()`; confirmed replaying it unpatched 400s
with the exact error above; confirmed the identical replay succeeds once
patched with `"thinking": ""`.

**Scope:** applied to every agent model that has `thinking={"type":
"adaptive"}` enabled (supervisor + all 4 sub-agents). NOT applied to
compaction.py/memory_extraction.py's Haiku calls, which stay
`thinking={"type": "disabled"}` — single-shot summarization/extraction
tasks with no orchestration reasoning to gain from it.
"""

from __future__ import annotations

from typing import Any

from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import BaseMessage


def _repair_content(content: Any) -> Any:
    """Return `content` with any malformed thinking block patched, or the
    original object unchanged if there's nothing to repair (avoids
    mutating messages that don't need it)."""
    if not isinstance(content, list):
        return content
    patched = False
    repaired: list[Any] = []
    for block in content:
        if (
            isinstance(block, dict)
            and block.get("type") == "thinking"
            and "thinking" not in block
        ):
            block = {**block, "thinking": ""}
            patched = True
        repaired.append(block)
    return repaired if patched else content


class ThinkingBlockRepairMiddleware(AgentMiddleware):
    """Repairs the langchain-anthropic thinking-block merge bug (see module
    docstring) on every model response before it reaches graph state.

    Must run whenever `thinking` is enabled on the wrapped model — without
    it, a malformed block produced during a streamed call (the dashboard's
    `/chat`/`/resume` via `astream_events`) gets stored in state and 400s
    the next time that message is replayed to Anthropic in the same
    multi-turn tool-calling loop.
    """

    async def awrap_model_call(self, request, handler):  # noqa: ANN001, ANN201
        response = await handler(request)
        for message in response.result:
            if isinstance(message, BaseMessage):
                message.content = _repair_content(message.content)
        return response
