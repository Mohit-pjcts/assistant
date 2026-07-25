"""Kanban board tools for life_admin_agent — full CRUD, deliberately UNGATED.

The user explicitly asked for "full access" to the board for life_admin_agent.
This is a different risk category from the gated write tools in
write_tools.py (send_email, calendar create/update/delete, Gmail filters):
those touch EXTERNAL systems (an inbox, someone else's calendar invite,
another mailbox's mail flow) and are irreversible or hard to undo outside
this app. A kanban task is purely local, in-app state — created, edited, and
deleted entirely within this SQLite file, fully visible on the dashboard's
Board tab, and trivially reversible (delete a task, move it back, edit the
title again). It's a closer match to render_ui (also ungated, also
presentation/local-state-only) than to send_email. If board tasks ever
start carrying real external consequences (e.g., an agent-triggered
webhook, or writes visible to other people), revisit this call — it was a
one-time decision made explicit here, not a general precedent for skipping
the confirmation gate.

Tools operate on a task's `ref` (the human-readable "ONI-N" shown on every
card and in list_board_tasks' own output) rather than the internal uuid —
that's what the model actually sees and what a user would say out loud
("move ONI-3 to done"), so making tools accept it directly avoids an extra
lookup round-trip. Falls back to accepting the raw internal id too, in case
a caller already has one from a prior list_board_tasks call.
"""

from __future__ import annotations

from langchain_core.tools import tool

from assistant import board_store


async def _resolve_id(ref_or_id: str) -> str:
    """Resolve a human-facing ref ("ONI-3") or a raw internal id to the
    internal id update_item/move_item/delete_item actually need. Raises
    KeyError (caught by each tool, turned into a data string per this
    project's "tool errors are data, not exceptions" rule) if neither
    matches."""
    items = await board_store.list_items()
    for item in items:
        if item.ref == ref_or_id or item.id == ref_or_id:
            return item.id
    raise KeyError(ref_or_id)


def _format_item(item: board_store.BoardItem) -> str:
    return (
        f"{item.ref} [{item.column}] ({item.priority}) {item.title!r}"
        + (f" — {item.description}" if item.description else "")
    )


@tool
async def list_board_tasks() -> str:
    """List every task on the kanban board, across all columns (todo,
    in-progress, in-review, done), with its ref, column, priority, and
    title/description. Use this before creating/updating/moving/deleting a
    task if you don't already know its ref from earlier in the
    conversation.
    """
    items = await board_store.list_items()
    if not items:
        return "The board is empty — no tasks in any column."
    return "\n".join(_format_item(item) for item in items)


@tool
async def create_board_task(
    column: str,
    title: str,
    description: str = "",
    priority: str = "medium",
) -> str:
    """Create a new task on the kanban board.

    Args:
        column: One of "todo", "in-progress", "in-review", "done".
        title: Short task title.
        description: Optional longer description.
        priority: One of "high", "medium", "low" (default "medium").
    """
    try:
        item = await board_store.create_item(
            column=column, title=title, description=description, priority=priority
        )
    except ValueError as exc:
        return f"Error: {exc}"
    return f"Created {_format_item(item)}"


@tool
async def update_board_task(
    ref: str,
    title: str | None = None,
    description: str | None = None,
    priority: str | None = None,
) -> str:
    """Edit an existing task's title, description, and/or priority. Does
    NOT move it between columns — use move_board_task for that. Only pass
    the fields you want to change; the rest stay as they are.

    Args:
        ref: The task's ref (e.g. "ONI-3") from list_board_tasks, or its
            internal id.
        title: New title, if changing it.
        description: New description, if changing it.
        priority: New priority ("high", "medium", or "low"), if changing it.
    """
    try:
        item_id = await _resolve_id(ref)
        item = await board_store.update_item(
            item_id, title=title, description=description, priority=priority
        )
    except KeyError:
        return f"Error: no task found with ref or id '{ref}'"
    except ValueError as exc:
        return f"Error: {exc}"
    return f"Updated {_format_item(item)}"


@tool
async def move_board_task(ref: str, column: str) -> str:
    """Move a task to a different column (e.g. "todo" -> "in-progress").
    Lands at the end of the target column.

    Args:
        ref: The task's ref (e.g. "ONI-3") from list_board_tasks, or its
            internal id.
        column: One of "todo", "in-progress", "in-review", "done".
    """
    try:
        item_id = await _resolve_id(ref)
        item = await board_store.move_item(item_id, column=column)
    except KeyError:
        return f"Error: no task found with ref or id '{ref}'"
    except ValueError as exc:
        return f"Error: {exc}"
    return f"Moved {_format_item(item)}"


@tool
async def delete_board_task(ref: str) -> str:
    """Delete a task from the board permanently.

    Args:
        ref: The task's ref (e.g. "ONI-3") from list_board_tasks, or its
            internal id.
    """
    try:
        item_id = await _resolve_id(ref)
        await board_store.delete_item(item_id)
    except KeyError:
        return f"Error: no task found with ref or id '{ref}'"
    return f"Deleted task {ref}"


def build_board_tools() -> list:
    return [
        list_board_tasks,
        create_board_task,
        update_board_task,
        move_board_task,
        delete_board_task,
    ]
