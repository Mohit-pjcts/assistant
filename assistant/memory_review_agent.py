"""Nightly memory-review agent — Phase 7 Part B, re-architected 2026-07-28.

The "separate agent" the per-turn extraction flow was split into, at the
user's explicit request: instead of a Haiku extraction call after every
single conversational turn (memory_extraction.py's old
extract_and_propose_memory_node, now removed), this module runs ONCE A DAY
(server.py's midnight scheduler, or a manual `POST /memory/review/run-now`)
and scans every known thread for genuine human turns that haven't been
scanned yet.

Never writes to the real, recalled `facts` table directly — every proposal
lands in memory_store's `pending_facts` queue via
memory_store.propose_pending_fact(). Only a human approving a card in the
dashboard's Memory panel (server.py's `POST /memory/pending/{id}/approve`)
turns a proposal into something recall_memory_node will ever surface. This
preserves the standing "no durable memory write without explicit
confirmation" rule (CLAUDE.md's Security model) — only the mechanism moved,
from a live interrupt() to an async review queue.

Cursor bookkeeping (memory_store.get_review_cursor/set_review_cursor): each
thread's own count of already-scanned genuine human turns, so a repeat
nightly run (or a manual run-now right after an automatic one) never
re-proposes the same turn's facts twice. Reads conversation history
directly off the checkpointer (AsyncSqliteSaver.aget_tuple) rather than
building the full multi-agent graph — this only needs the persisted
`messages` channel value for each thread, not anything that can actually
run a turn, so building coding_agent/research_agent/etc. just to read
history would be pure waste.

Scope cut, deliberate: does not carry over the old flow's cites_tool_result
verification — see memory_extraction.py's own module docstring for why
that assumption doesn't survive a retroactive, once-a-day batch scan.
"""

from __future__ import annotations

from langchain_core.messages import AnyMessage

from assistant import memory_extraction, memory_store, thread_store
from assistant.agent import make_thread_config
from assistant.compaction import is_genuine_human_turn
from assistant.memory import get_checkpointer
from assistant.memory_extraction import text_only_content

CONVERSATION_DB_PATH = "conversation_memory.sqlite"

# Distinguishes a nightly-review-derived fact's provenance from a user-typed
# one ("user", MemoryPanel's direct-add feature) and from the pre-rewrite
# per-turn flow's own citation-shaped provenance strings.
_PROVENANCE = "nightly review"


async def _new_turns_text(
    thread_id: str, already_processed: int, conversation_db_path: str
) -> tuple[str, int]:
    """Returns (joined text of this thread's not-yet-scanned genuine human
    turns, that thread's new total turn count). Empty text / an unchanged
    count if there's nothing new — a thread with no activity since the last
    run, or one with no checkpoint at all."""
    async with get_checkpointer(conversation_db_path) as checkpointer:
        tup = await checkpointer.aget_tuple(make_thread_config(thread_id))
    if tup is None:
        return "", already_processed

    messages: list[AnyMessage] = tup.checkpoint.get("channel_values", {}).get("messages", [])
    human_turns = [m for m in messages if is_genuine_human_turn(m)]
    new_turns = human_turns[already_processed:]
    if not new_turns:
        return "", already_processed

    text = "\n".join(text_only_content(m.content) for m in new_turns)
    return text, len(human_turns)


async def run_nightly_review(conversation_db_path: str = CONVERSATION_DB_PATH) -> int:
    """Scans every known thread for genuine human turns since its own
    last-scanned cursor, proposes 0+ facts per thread via the same isolated
    Haiku extraction channel memory_extraction.py already uses
    (propose_facts — capped per call by
    memory_extraction.MAX_PROPOSED_FACTS_PER_CALL), and queues each into
    memory_store's pending_facts table. Returns the number of new proposals
    queued this run.

    A thread whose extraction call fails (e.g. a transient API error)
    simply keeps its old cursor and gets retried on the next run — the
    cursor is only advanced past a thread's new turns once propose_facts()
    for that thread has actually returned, never advanced speculatively
    first."""
    threads = await thread_store.list_threads()
    queued = 0
    for thread in threads:
        already_processed = await memory_store.get_review_cursor(thread.id)
        text, new_total = await _new_turns_text(thread.id, already_processed, conversation_db_path)
        if text.strip():
            # Called module-qualified (not `from ... import propose_facts`)
            # specifically so tests can monkeypatch
            # memory_extraction.propose_facts and have it actually take
            # effect here — a `from X import Y` binding would freeze its
            # own separate reference at import time, silently ignoring a
            # later patch on X itself (same reasoning memory_store.py's
            # save_fact docstring gives for db_path defaults).
            proposed = await memory_extraction.propose_facts(text)
            for fact in proposed:
                await memory_store.propose_pending_fact(fact.content, provenance=_PROVENANCE)
                queued += 1
        if new_total != already_processed:
            await memory_store.set_review_cursor(thread.id, new_total)
    return queued
