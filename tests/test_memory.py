"""Tests for assistant.memory. Runnable directly (no test framework required yet)."""

import asyncio
import tempfile
import uuid
from pathlib import Path

from assistant.memory import get_checkpointer


async def test_get_checkpointer_round_trip() -> None:
    """get_checkpointer() should yield a working AsyncSqliteSaver that persists checkpoints."""
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "scratch.sqlite"

        async with get_checkpointer(db_path) as checkpointer:
            config = {
                "configurable": {"thread_id": str(uuid.uuid4()), "checkpoint_ns": ""}
            }

            checkpoint = {
                "v": 1,
                "ts": "2026-07-08T00:00:00+00:00",
                "id": str(uuid.uuid4()),
                "channel_values": {"messages": ["hello from smoke test"]},
                "channel_versions": {},
                "versions_seen": {},
            }
            await checkpointer.aput(config, checkpoint, {}, {})

            result = await checkpointer.aget_tuple(config)
            assert result is not None, "expected a checkpoint tuple back, got None"
            assert result.checkpoint["channel_values"]["messages"] == [
                "hello from smoke test"
            ], f"round-trip mismatch: {result.checkpoint}"


if __name__ == "__main__":
    asyncio.run(test_get_checkpointer_round_trip())
    print("OK: get_checkpointer() constructs a working AsyncSqliteSaver and round-trips a checkpoint")
