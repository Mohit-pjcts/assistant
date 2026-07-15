"""Tests for assistant.thinking_repair — the ThinkingBlockRepairMiddleware
that neutralizes the confirmed langchain-anthropic streaming bug (STEPS.md
28/73/74).

Runnable directly (no test framework required yet), same convention as
test_supervisor.py. These are deterministic structural tests of the repair
logic (a fake handler returning a hand-built malformed message), not a live
API call — the live repro (real astream() call hitting the bug; real
replay 400ing unpatched and succeeding patched) was verified by hand
against the real API and is recorded in STEPS.md 73/74, not re-proven here
on every run.
"""

import asyncio
from types import SimpleNamespace

from langchain_core.messages import AIMessage, HumanMessage

from assistant.thinking_repair import ThinkingBlockRepairMiddleware, _repair_content

MALFORMED_BLOCK = {"type": "thinking", "signature": "sig-abc", "index": 0}
WELL_FORMED_BLOCK = {"type": "thinking", "thinking": "some reasoning", "signature": "sig-abc", "index": 0}
TEXT_BLOCK = {"type": "text", "text": "The answer is 4."}


def test_repair_content_adds_missing_thinking_key() -> None:
    """The exact shape reproduced live against the real API (STEPS.md 73/74):
    a thinking block with a signature but no `thinking` key. Must come back
    with `thinking: ""` added, everything else (including the real
    signature) untouched."""
    repaired = _repair_content([MALFORMED_BLOCK, TEXT_BLOCK])
    assert repaired[0] == {"type": "thinking", "signature": "sig-abc", "index": 0, "thinking": ""}
    assert repaired[1] == TEXT_BLOCK


def test_repair_content_leaves_well_formed_blocks_untouched() -> None:
    """A thinking block that already has its `thinking` key (the normal,
    non-buggy case) must not be modified — confirms the repair is targeted,
    not a blanket rewrite of every thinking block."""
    original = [WELL_FORMED_BLOCK, TEXT_BLOCK]
    repaired = _repair_content(original)
    assert repaired == original


def test_repair_content_is_a_noop_for_non_list_content() -> None:
    """Plain-string content (no thinking enabled, or a text-only reply) must
    pass through unchanged rather than erroring."""
    assert _repair_content("just a string") == "just a string"


def test_repair_content_returns_same_object_when_nothing_to_patch() -> None:
    """No unnecessary copying/mutation of messages that don't need repair."""
    original = [TEXT_BLOCK]
    assert _repair_content(original) is original


def test_middleware_patches_malformed_message_in_response() -> None:
    """End-to-end through the middleware's awrap_model_call: a response
    carrying the malformed message must come back patched, so it's safe to
    store in graph state and replay in a later turn."""
    middleware = ThinkingBlockRepairMiddleware()
    malformed_message = AIMessage(content=[MALFORMED_BLOCK, TEXT_BLOCK])
    response = SimpleNamespace(result=[HumanMessage(content="hi"), malformed_message])

    async def fake_handler(_req):
        return response

    result = asyncio.run(middleware.awrap_model_call(SimpleNamespace(), fake_handler))

    patched = result.result[1]
    assert patched.content[0] == {"type": "thinking", "signature": "sig-abc", "index": 0, "thinking": ""}
    assert patched.content[1] == TEXT_BLOCK


def test_middleware_leaves_non_thinking_responses_untouched() -> None:
    """A plain text-only response (no thinking blocks at all — most turns)
    must pass through with no changes."""
    middleware = ThinkingBlockRepairMiddleware()
    message = AIMessage(content="plain text reply")
    response = SimpleNamespace(result=[message])

    async def fake_handler(_req):
        return response

    result = asyncio.run(middleware.awrap_model_call(SimpleNamespace(), fake_handler))
    assert result.result[0].content == "plain text reply"


if __name__ == "__main__":
    test_repair_content_adds_missing_thinking_key()
    print("OK: test_repair_content_adds_missing_thinking_key")
    test_repair_content_leaves_well_formed_blocks_untouched()
    print("OK: test_repair_content_leaves_well_formed_blocks_untouched")
    test_repair_content_is_a_noop_for_non_list_content()
    print("OK: test_repair_content_is_a_noop_for_non_list_content")
    test_repair_content_returns_same_object_when_nothing_to_patch()
    print("OK: test_repair_content_returns_same_object_when_nothing_to_patch")
    test_middleware_patches_malformed_message_in_response()
    print("OK: test_middleware_patches_malformed_message_in_response")
    test_middleware_leaves_non_thinking_responses_untouched()
    print("OK: test_middleware_leaves_non_thinking_responses_untouched")
    print("\n6 tests passed")
