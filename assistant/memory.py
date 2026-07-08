"""Persistent conversation memory: SQLite checkpointer setup for LangGraph."""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from langgraph.checkpoint.sqlite import SqliteSaver

DEFAULT_DB_PATH = Path("conversation_memory.sqlite")


@contextmanager
def get_checkpointer(db_path: Path | str = DEFAULT_DB_PATH) -> Iterator[SqliteSaver]:
    """Yield a SQLite-backed checkpointer for LangGraph conversation memory.

    The checkpointer persists graph state (message history) keyed by
    thread_id, so conversations survive process restarts. Use it as a
    context manager for the lifetime of the graph:

        with get_checkpointer() as checkpointer:
            graph = builder.compile(checkpointer=checkpointer)
            ...

    Args:
        db_path: Path to the SQLite database file. Created if it doesn't exist.

    Yields:
        A SqliteSaver instance to pass as the `checkpointer` when compiling
        a LangGraph graph.
    """
    with SqliteSaver.from_conn_string(str(db_path)) as checkpointer:
        yield checkpointer
