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

import uuid
from typing import Annotated, Any

from langchain_core.tools import InjectedToolCallId, tool
from langgraph.types import Command

from assistant import board_store
from assistant.a2ui import dispatch_surface


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


_COLUMN_TITLES: dict[board_store.ColumnId, str] = {
    "todo": "To Do",
    "in-progress": "In Progress",
    "in-review": "In Review",
    "done": "Done",
}


@tool
async def render_board_ui(tool_call_id: Annotated[str, InjectedToolCallId]) -> Command:
    """Render the kanban board as a rich card layout in the dashboard,
    visually matching the real Board tab — one column per status, one card
    per task, with the same ref/priority badges, title, description, and
    "updated X ago" the Board tab itself shows.

    Takes NO arguments. Unlike render_ui, you never describe the board's
    content yourself: this tool fetches the real board state directly from
    board_store and binds every field (ref/title/description/priority/
    column/updated_at) to the surface's own dataModel by path, rather than
    you retyping it into the surface — so nothing can be mistyped,
    paraphrased, or drift from what list_board_tasks would show. Prefer
    this over calling render_ui by hand whenever you're asked to show the
    board. Has no effect outside the dashboard, same as render_ui/
    render_form.
    """
    items = await board_store.list_items()
    data_model: dict[str, str] = {}
    components: list[dict[str, Any]] = []
    column_card_ids: list[str] = []

    for column in board_store.COLUMNS:
        column_items = [item for item in items if item.column == column]
        col_id = f"col_{column}"
        heading_id = f"{col_id}_heading"
        heading_path = f"/{col_id}/heading"
        data_model[heading_path] = f"{_COLUMN_TITLES[column]} ({len(column_items)})"
        components.append({"id": heading_id, "component": "Badge", "text": {"path": heading_path}})
        col_children = [heading_id]

        if not column_items:
            empty_id = f"{col_id}_empty"
            components.append({"id": empty_id, "component": "Text", "text": "No tasks"})
            col_children.append(empty_id)

        for item in column_items:
            title_id = f"{item.id}_title"
            priority_id = f"{item.id}_priority"
            title_path = f"/{item.id}/title"
            priority_path = f"/{item.id}/priority"
            # Raw values (not pre-formatted) — the dedicated board renderer
            # (A2UIRenderer.tsx's BoardSurfaceView, keyed off this tool's
            # own "board-" surfaceId prefix) reads these same paths
            # directly and maps priority/column through the SAME label/
            # color meta the real Board tab uses (KanbanBoard.tsx's
            # PRIORITY_META/COLUMNS), for visual parity rather than a
            # generic Text/Badge dump. `ref`/`description`/`column`/
            # `updated_at` below have no corresponding generic component
            # node — that's fine, dataModel entries don't require one —
            # they exist purely for BoardSurfaceView to read.
            data_model[title_path] = item.title
            data_model[priority_path] = item.priority
            data_model[f"/{item.id}/ref"] = item.ref
            data_model[f"/{item.id}/description"] = item.description
            data_model[f"/{item.id}/column"] = item.column
            data_model[f"/{item.id}/updated_at"] = item.updated_at
            components.append({"id": title_id, "component": "Text", "text": {"path": title_path}})
            components.append({"id": priority_id, "component": "Badge", "text": {"path": priority_path}})

            task_col_id = f"{item.id}_col"
            components.append({"id": task_col_id, "component": "Column", "children": [title_id, priority_id]})
            task_card_id = f"{item.id}_card"
            components.append({"id": task_card_id, "component": "Card", "child": task_col_id})
            col_children.append(task_card_id)

        col_col_id = f"{col_id}_col"
        components.append({"id": col_col_id, "component": "Column", "children": col_children})
        col_card_id = f"{col_id}_card"
        components.append({"id": col_card_id, "component": "Card", "child": col_col_id})
        column_card_ids.append(col_card_id)

    components.append({"id": "root", "component": "Row", "children": column_card_ids})
    surface = {
        # The "board-" prefix is a deliberate, load-bearing contract with
        # the frontend (A2UIRenderer.tsx checks for it) — same "client and
        # server agree on a well-known id ahead of time" pattern real A2UI
        # uses for catalog negotiation, just scoped to one surface shape
        # instead of a whole component catalog. Don't rename this prefix
        # without updating BoardSurfaceView's own check.
        "surfaceId": f"board-{uuid.uuid4().hex[:8]}",
        "components": components,
        "dataModel": data_model,
    }
    return await dispatch_surface(surface, tool_call_id, "render_board_ui rejected the board surface")


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
        render_board_ui,
        create_board_task,
        update_board_task,
        move_board_task,
        delete_board_task,
    ]
