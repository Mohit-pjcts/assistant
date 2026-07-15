"""Persistent conversation memory: SQLite checkpointer setup for LangGraph."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

DEFAULT_DB_PATH = Path("conversation_memory.sqlite")


@asynccontextmanager
async def get_checkpointer(
    db_path: Path | str = DEFAULT_DB_PATH,
) -> AsyncIterator[AsyncSqliteSaver]:
    """Yield a SQLite-backed checkpointer for LangGraph conversation memory.

    The checkpointer persists graph state (message history) keyed by
    thread_id, so conversations survive process restarts. Use it as an
    async context manager for the lifetime of the graph:

        async with get_checkpointer() as checkpointer:
            graph = builder.compile(checkpointer=checkpointer)
            ...

    Async rather than the sync SqliteSaver: MCP-loaded tools (Phase 2) only
    support async invocation, which forces the whole graph onto
    graph.ainvoke() — and SqliteSaver's own async methods (aget_tuple, etc.)
    explicitly raise NotImplementedError and point to this class instead.

    Args:
        db_path: Path to the SQLite database file. Created if it doesn't exist.

    Yields:
        An AsyncSqliteSaver instance to pass as the `checkpointer` when
        compiling a LangGraph graph.
    """
    async with AsyncSqliteSaver.from_conn_string(str(db_path)) as checkpointer:
        yield checkpointer
