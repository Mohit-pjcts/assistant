// Copyright (c) Meta Platforms, Inc. and affiliates.

"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/relativeTime";
import { InstrumentCard } from "@/components/ui/instrument-card";
import { Chip } from "@/components/ui/chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  PlusIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  InboxIcon,
  InformationCircleIcon,
  ClipboardDocumentCheckIcon,
  EllipsisHorizontalIcon,
} from "@heroicons/react/24/outline";

import {
  fetchBoardTasks,
  createBoardTask,
  updateBoardTask,
  deleteBoardTask,
  type BoardTask,
  type BoardColumnId,
  type BoardPriority,
} from "@/lib/api";

// PLAN.md Phase 29 Stage 2: Astryx's Layout/Card/Badge/Button/IconButton/
// Icon/StatusDot/EmptyState/MoreMenu/Tooltip/Toolbar/Section/Timestamp/
// Dialog/AlertDialog/TextInput/TextArea/Selector all replaced by this
// app's own shadcn primitives + InstrumentCard + plain Tailwind — a pure
// presentation swap, same discipline as InterruptGate.tsx/A2UIRenderer.tsx.
// No test file exists for this component (confirmed before starting), so
// the only real contracts to preserve are the drag-and-drop pointer
// mechanics below (untouched) and the real /board/tasks API calls.

function StatusDot({ className, label }: { className: string; label: string }) {
  return <span aria-label={label} className={cn("inline-block size-2 rounded-full", className)} />;
}

// ============= TYPES =============

interface ColumnMeta {
  id: BoardColumnId;
  title: string;
  dotClass: string;
  tooltip: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyIcon: typeof InboxIcon;
}

// Where a dragged card will land: a column and an insertion index within it
// (measured against the cards remaining after the dragged card is removed).
interface DropTarget {
  column: BoardColumnId;
  index: number;
}

// Live state of an in-progress pointer drag. Coordinates are in viewport space.
interface DragState {
  id: string;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  pointerX: number;
  pointerY: number;
  target: DropTarget | null;
}

// ============= DATA =============

const COLUMNS: ColumnMeta[] = [
  {
    id: "todo",
    title: "To-do",
    dotClass: "bg-muted-foreground",
    tooltip: "Items assigned to this sprint, waiting to be picked up.",
    emptyTitle: "To-do is empty",
    emptyDescription: "Items pulled into this sprint appear here.",
    emptyIcon: InboxIcon,
  },
  {
    id: "in-progress",
    title: "In progress",
    dotClass: "bg-accent-signal",
    tooltip: "Items currently in progress.",
    emptyTitle: "Nothing in progress",
    emptyDescription: "Items being worked on appear here.",
    emptyIcon: ArrowPathIcon,
  },
  {
    id: "in-review",
    title: "In review",
    dotClass: "bg-signal",
    tooltip: "Items waiting for your review.",
    emptyTitle: "Nothing in review",
    emptyDescription: "Items awaiting your review appear here.",
    emptyIcon: ClipboardDocumentCheckIcon,
  },
  {
    id: "done",
    title: "Done",
    dotClass: "bg-moss",
    tooltip: "Items that have been handled.",
    emptyTitle: "Nothing done yet",
    emptyDescription: "Completed items appear here.",
    emptyIcon: CheckCircleIcon,
  },
];

const PRIORITY_META: Record<BoardPriority, { label: string; dotClass: string }> = {
  high: { label: "High", dotClass: "bg-rust" },
  medium: { label: "Medium", dotClass: "bg-signal" },
  low: { label: "Low", dotClass: "bg-teal-500" },
};

const PRIORITY_OPTIONS = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

// How often to re-fetch while idle (not mid-drag, no dialog open) — the
// board is also written by life_admin_agent's board_tools.py, completely
// outside this panel's own request cycle, so it needs the same kind of
// external-update poll ChatPanel already has for voice-driven turns.
const EXTERNAL_UPDATE_POLL_MS = 4000;

// Pointer travel (px) before a press is promoted to a drag, so taps and clicks
// on card controls still register normally.
const DRAG_THRESHOLD = 5;

// ============= STYLES =============
// PLAN.md Phase 29 Stage 2: the Astryx-only CSS vars this object used to
// reference (--spacing-4, --shadow-high, --radius-container, --color-
// background-muted) don't exist once Astryx's theme is gone — the fixed
// layout classes moved to plain Tailwind directly in JSX below; only the
// genuinely DYNAMIC per-drag values (position/size, computed at pointer-
// move time) still need inline styles, since Tailwind can't express those.

const styles = {
  floatingAt: (x: number, y: number, width: number) => ({
    width,
    transform: `translate(${x}px, ${y}px)`,
  }),
  ghost: (height: number) => ({ height }) as const,
};

// ============= TASK FORM (Add / Edit) =============

interface TaskFormValue {
  title: string;
  description: string;
  priority: BoardPriority;
}

function TaskFormDialog({
  isOpen,
  onOpenChange,
  initial,
  onSubmit,
  isSaving,
  title,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  initial: TaskFormValue;
  onSubmit: (value: TaskFormValue) => void;
  isSaving: boolean;
  title: string;
}) {
  const [value, setValue] = useState(initial);
  const titleId = useId();
  const descriptionId = useId();
  const priorityId = useId();

  useEffect(() => {
    if (isOpen) setValue(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle className="mb-3">{title}</DialogTitle>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor={titleId} className="text-xs text-muted-foreground">
              Title
            </label>
            <Input
              id={titleId}
              autoFocus
              required
              value={value.title}
              onChange={(event) => setValue((s) => ({ ...s, title: event.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={descriptionId} className="text-xs text-muted-foreground">
              Description (optional)
            </label>
            <Textarea
              id={descriptionId}
              rows={3}
              value={value.description}
              onChange={(event) => setValue((s) => ({ ...s, description: event.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={priorityId} className="text-xs text-muted-foreground">
              Priority
            </label>
            <select
              id={priorityId}
              value={value.priority}
              onChange={(event) =>
                setValue((s) => ({ ...s, priority: event.target.value as BoardPriority }))
              }
              className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring"
            >
              {PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2 border-t border-graphite/20 pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={isSaving || !value.title.trim()} onClick={() => onSubmit(value)}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============= CARD BODY =============

// Shared card contents, rendered both in the column list and inside the
// floating drag clone so the two stay pixel-identical.
function BoardCardBody({
  item,
  onMove,
  onEdit,
  onDelete,
}: {
  item: BoardTask;
  onMove: (id: string, to: BoardColumnId) => void;
  onEdit: (item: BoardTask) => void;
  onDelete: (item: BoardTask) => void;
}) {
  const priority = PRIORITY_META[item.priority];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          <Chip>{item.ref}</Chip>
          <Chip className="flex items-center gap-1">
            <span className={cn("inline-block size-1.5 rounded-full", priority.dotClass)} />
            {priority.label}
          </Chip>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Work item actions"
            onPointerDown={(e) => e.stopPropagation()}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-graphite/10 hover:text-foreground"
          >
            <EllipsisHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onEdit(item)}>Edit</DropdownMenuItem>
            {COLUMNS.filter((c) => c.id !== item.column).map((c) => (
              <DropdownMenuItem key={c.id} onClick={() => onMove(item.id, c.id)}>
                Move to {c.title}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem onClick={() => onDelete(item)} className="text-destructive">
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-col gap-1">
        <h4 className="font-heading text-sm font-semibold">{item.title}</h4>
        {item.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{item.description}</p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">Updated {relativeTime(item.updated_at)}</p>
    </div>
  );
}

// ============= BOARD CARD =============

// A plain div carrying the `.instrument-card` CSS class directly, NOT the
// InstrumentCard *component* — this card needs a real external ref for the
// drag/drop pointer hit-testing below, which InstrumentCard doesn't expose
// (its own ref is used internally for the mousemove-driven tilt). Running
// both the tilt effect's own `style.transform` writes and this file's drag
// positioning on the same element would fight over the same property, so
// the spotlight/tilt effect is deliberately dropped here — the hairline
// border and hover-glow (both pure CSS, no JS) still apply.
function BoardCard({
  item,
  cardRef,
  onPointerDown,
  onMove,
  onEdit,
  onDelete,
}: {
  item: BoardTask;
  cardRef: (el: HTMLDivElement | null) => void;
  onPointerDown: (e: ReactPointerEvent, id: string) => void;
  onMove: (id: string, to: BoardColumnId) => void;
  onEdit: (item: BoardTask) => void;
  onDelete: (item: BoardTask) => void;
}) {
  return (
    <div
      ref={cardRef}
      className="instrument-card kanban-card p-3"
      onPointerDown={(e) => onPointerDown(e, item.id)}
    >
      <BoardCardBody item={item} onMove={onMove} onEdit={onEdit} onDelete={onDelete} />
    </div>
  );
}

// ============= BOARD COLUMN =============

function BoardColumn({
  meta,
  count,
  contentRef,
  children,
}: {
  meta: ColumnMeta;
  count: number;
  contentRef: (el: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  return (
    <InstrumentCard className="flex h-full w-[300px] shrink-0 flex-col p-0">
      <div className="flex items-center justify-between gap-2 border-b border-graphite/20 p-3">
        <div className="flex items-center gap-2">
          <StatusDot className={meta.dotClass} label={`${meta.title} status`} />
          <h4 className="font-heading text-sm font-semibold">{meta.title}</h4>
          <InformationCircleIcon className="size-3.5 text-muted-foreground" title={meta.tooltip} />
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      </div>
      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {children ?? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <meta.emptyIcon className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">{meta.emptyTitle}</p>
            <p className="text-xs text-muted-foreground">{meta.emptyDescription}</p>
          </div>
        )}
      </div>
    </InstrumentCard>
  );
}

// ============= MAIN =============

export function KanbanBoard() {
  const [items, setItems] = useState<BoardTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editTarget, setEditTarget] = useState<BoardTask | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BoardTask | null>(null);

  const refetch = () => {
    fetchBoardTasks()
      .then(setItems)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    fetchBoardTasks()
      .then(setItems)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoaded(true));
  }, []);

  // External-update poll: life_admin_agent's board_tools.py can create/
  // move/update/delete tasks completely outside this panel's own request
  // cycle. Paused while dragging or while a dialog is open so it can't
  // clobber in-flight interaction with a stale snapshot — same reasoning
  // ChatPanel's own external-update poll already documents.
  useEffect(() => {
    const interval = setInterval(() => {
      if (drag || isAddOpen || editTarget || deleteTarget) return;
      refetch();
    }, EXTERNAL_UPDATE_POLL_MS);
    return () => clearInterval(interval);
  }, [drag, isAddOpen, editTarget, deleteTarget]);

  // Live element registries for pointer hit-testing (kept out of render state).
  const columnEls = useRef(new Map<BoardColumnId, HTMLElement>());
  const cardEls = useRef(new Map<string, HTMLElement>());
  const columnRefCbs = useRef(new Map<BoardColumnId, (el: HTMLDivElement | null) => void>());
  const cardRefCbs = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const teardownRef = useRef<(() => void) | null>(null);

  const getColumnRef = (id: BoardColumnId) => {
    let cb = columnRefCbs.current.get(id);
    if (!cb) {
      cb = (el) => {
        if (el) columnEls.current.set(id, el);
        else columnEls.current.delete(id);
      };
      columnRefCbs.current.set(id, cb);
    }
    return cb;
  };

  const getCardRef = (id: string) => {
    let cb = cardRefCbs.current.get(id);
    if (!cb) {
      cb = (el) => {
        if (el) cardEls.current.set(id, el);
        else cardEls.current.delete(id);
      };
      cardRefCbs.current.set(id, cb);
    }
    return cb;
  };

  const itemsByColumn = useMemo(() => {
    const map: Record<BoardColumnId, BoardTask[]> = {
      todo: [],
      "in-progress": [],
      "in-review": [],
      done: [],
    };
    for (const item of items) {
      map[item.column].push(item);
    }
    return map;
  }, [items]);

  const moveItem = (id: string, to: BoardColumnId) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, column: to } : item)));
    updateBoardTask(id, { column: to }).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  };

  const computeTarget = (px: number, py: number, draggedId: string): DropTarget | null => {
    for (const [colId, el] of Array.from(columnEls.current.entries())) {
      const r = el.getBoundingClientRect();
      if (px < r.left || px > r.right || py < r.top || py > r.bottom) {
        continue;
      }

      const ids = itemsByColumn[colId].filter((it) => it.id !== draggedId).map((it) => it.id);

      let index = ids.length;
      for (let i = 0; i < ids.length; i++) {
        const cardEl = cardEls.current.get(ids[i]);
        if (!cardEl) continue;
        const cr = cardEl.getBoundingClientRect();
        if (py < cr.top + cr.height / 2) {
          index = i;
          break;
        }
      }
      return { column: colId, index };
    }
    return null;
  };

  const commitDrag = (id: string, target: DropTarget) => {
    setItems((prev) => {
      const moved = prev.find((it) => it.id === id);
      if (!moved) return prev;

      const rest = prev.filter((it) => it.id !== id);
      const updated: BoardTask = { ...moved, column: target.column };
      const colItems = rest.filter((it) => it.column === target.column);
      const anchor = colItems[target.index];

      if (!anchor) {
        return [...rest, updated];
      }
      const at = rest.indexOf(anchor);
      return [...rest.slice(0, at), updated, ...rest.slice(at)];
    });
    updateBoardTask(id, { column: target.column, position: target.index }).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  };

  const onCardPointerDown = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, [role="menuitem"], [role="menu"]')) {
      return;
    }

    const el = cardEls.current.get(id);
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const offsetX = startX - rect.left;
    const offsetY = startY - rect.top;
    const { width, height } = rect;

    let started = false;
    let target: DropTarget | null = null;

    const onMove = (ev: PointerEvent) => {
      if (
        !started &&
        Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < DRAG_THRESHOLD
      ) {
        return;
      }
      started = true;
      target = computeTarget(ev.clientX, ev.clientY, id);
      setDrag({
        id,
        width,
        height,
        offsetX,
        offsetY,
        pointerX: ev.clientX,
        pointerY: ev.clientY,
        target,
      });
    };

    const onUp = () => {
      teardownRef.current?.();
      if (started && target) {
        commitDrag(id, target);
      }
      setDrag(null);
    };

    const teardown = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      teardownRef.current = null;
    };
    teardownRef.current = teardown;

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const draggedItem = drag ? items.find((it) => it.id === drag.id) : undefined;
  const isDragging = drag !== null;

  useEffect(() => {
    if (!isDragging) return;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = previous;
    };
  }, [isDragging]);

  useEffect(() => () => teardownRef.current?.(), []);

  const renderColumnCards = (colId: BoardColumnId): ReactNode => {
    const colItems = itemsByColumn[colId];
    const visible = drag ? colItems.filter((it) => it.id !== drag.id) : colItems;
    const ghostTarget = drag && drag.target && drag.target.column === colId ? drag : null;

    if (visible.length === 0 && !ghostTarget) {
      return null;
    }

    const nodes: ReactNode[] = visible.map((it) => (
      <BoardCard
        key={it.id}
        item={it}
        cardRef={getCardRef(it.id)}
        onPointerDown={onCardPointerDown}
        onMove={moveItem}
        onEdit={setEditTarget}
        onDelete={setDeleteTarget}
      />
    ));

    if (ghostTarget && ghostTarget.target) {
      const index = Math.min(ghostTarget.target.index, nodes.length);
      nodes.splice(
        index,
        0,
        <div
          key="drag-ghost"
          className="rounded-md bg-muted"
          style={styles.ghost(ghostTarget.height)}
        />,
      );
    }

    return <div className="flex flex-col gap-2">{nodes}</div>;
  };

  async function handleCreate(value: TaskFormValue) {
    setIsSaving(true);
    try {
      const created = await createBoardTask({ column: "todo", ...value });
      setItems((prev) => [...prev, created]);
      setIsAddOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleEditSave(value: TaskFormValue) {
    if (!editTarget) return;
    setIsSaving(true);
    try {
      const updated = await updateBoardTask(editTarget.id, value);
      setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
      setEditTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setIsSaving(true);
    try {
      await deleteBoardTask(deleteTarget.id);
      setItems((prev) => prev.filter((it) => it.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-3 border-b border-graphite/20 pb-3">
        <div className="flex items-center gap-2">
          <h3 className="font-heading text-lg font-semibold">Kanban Board</h3>
          <Chip>{items.length}</Chip>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" aria-label="Refresh" onClick={refetch}>
            <ArrowPathIcon className="size-4" />
          </Button>
          <Button onClick={() => setIsAddOpen(true)}>
            <PlusIcon className="size-4" />
            Add task
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {!loaded ? (
          <p className="p-10 text-center text-sm text-muted-foreground">Loading board…</p>
        ) : (
          <div className="flex h-full gap-4 overflow-x-auto overflow-y-hidden">
            {COLUMNS.map((meta) => (
              <BoardColumn
                key={meta.id}
                meta={meta}
                count={itemsByColumn[meta.id].length}
                contentRef={getColumnRef(meta.id)}
              >
                {renderColumnCards(meta.id)}
              </BoardColumn>
            ))}
          </div>
        )}
      </div>
      {drag && draggedItem ? (
        <div
          className="instrument-card fixed top-0 left-0 z-[1000] cursor-grabbing p-3 shadow-lg"
          style={{
            pointerEvents: "none",
            ...styles.floatingAt(
              drag.pointerX - drag.offsetX,
              drag.pointerY - drag.offsetY,
              drag.width,
            ),
          }}
        >
          <BoardCardBody
            item={draggedItem}
            onMove={() => {}}
            onEdit={() => {}}
            onDelete={() => {}}
          />
        </div>
      ) : null}

      <TaskFormDialog
        isOpen={isAddOpen}
        onOpenChange={setIsAddOpen}
        initial={{ title: "", description: "", priority: "medium" }}
        onSubmit={handleCreate}
        isSaving={isSaving}
        title="Add task"
      />
      <TaskFormDialog
        isOpen={editTarget !== null}
        onOpenChange={(open) => !open && setEditTarget(null)}
        initial={
          editTarget
            ? {
                title: editTarget.title,
                description: editTarget.description,
                priority: editTarget.priority,
              }
            : { title: "", description: "", priority: "medium" }
        }
        onSubmit={handleEditSave}
        isSaving={isSaving}
        title={`Edit ${editTarget?.ref ?? "task"}`}
      />
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogTitle>{`Delete ${deleteTarget?.ref ?? "task"}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {`"${deleteTarget?.title ?? ""}" will be permanently deleted. This can't be undone.`}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isSaving}
              onClick={handleDeleteConfirm}
            >
              {isSaving ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
