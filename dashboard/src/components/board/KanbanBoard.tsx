// Copyright (c) Meta Platforms, Inc. and affiliates.

'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import {
  Layout,
  LayoutHeader,
  LayoutContent,
  LayoutFooter,
  HStack,
  VStack,
} from '@astryxdesign/core/Layout';
import {Text, Heading} from '@astryxdesign/core/Text';
import {Card} from '@astryxdesign/core/Card';
import {Badge} from '@astryxdesign/core/Badge';
import {Button} from '@astryxdesign/core/Button';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Icon} from '@astryxdesign/core/Icon';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {MoreMenu} from '@astryxdesign/core/MoreMenu';
import {Tooltip} from '@astryxdesign/core/Tooltip';
import {Toolbar} from '@astryxdesign/core/Toolbar';
import {Section} from '@astryxdesign/core/Section';
import {Timestamp} from '@astryxdesign/core/Timestamp';
import {Dialog} from '@astryxdesign/core/Dialog';
import {AlertDialog} from '@astryxdesign/core/AlertDialog';
import {TextInput} from '@astryxdesign/core/TextInput';
import {TextArea} from '@astryxdesign/core/TextArea';
import {Selector} from '@astryxdesign/core/Selector';

import {
  PlusIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  InboxIcon,
  InformationCircleIcon,
  ClipboardDocumentCheckIcon,
} from '@heroicons/react/24/outline';

import {
  fetchBoardTasks,
  createBoardTask,
  updateBoardTask,
  deleteBoardTask,
  type BoardTask,
  type BoardColumnId,
  type BoardPriority,
} from '@/lib/api';

// ============= TYPES =============

interface ColumnMeta {
  id: BoardColumnId;
  title: string;
  variant: 'neutral' | 'accent' | 'warning' | 'success';
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
    id: 'todo',
    title: 'To-do',
    variant: 'neutral',
    tooltip: 'Items assigned to this sprint, waiting to be picked up.',
    emptyTitle: 'To-do is empty',
    emptyDescription: 'Items pulled into this sprint appear here.',
    emptyIcon: InboxIcon,
  },
  {
    id: 'in-progress',
    title: 'In progress',
    variant: 'accent',
    tooltip: 'Items currently in progress.',
    emptyTitle: 'Nothing in progress',
    emptyDescription: 'Items being worked on appear here.',
    emptyIcon: ArrowPathIcon,
  },
  {
    id: 'in-review',
    title: 'In review',
    variant: 'warning',
    tooltip: 'Items waiting for your review.',
    emptyTitle: 'Nothing in review',
    emptyDescription: 'Items awaiting your review appear here.',
    emptyIcon: ClipboardDocumentCheckIcon,
  },
  {
    id: 'done',
    title: 'Done',
    variant: 'success',
    tooltip: 'Items that have been handled.',
    emptyTitle: 'Nothing done yet',
    emptyDescription: 'Completed items appear here.',
    emptyIcon: CheckCircleIcon,
  },
];

const PRIORITY_META: Record<
  BoardPriority,
  {label: string; variant: 'error' | 'warning' | 'teal'}
> = {
  high: {label: 'High', variant: 'error'},
  medium: {label: 'Medium', variant: 'warning'},
  low: {label: 'Low', variant: 'teal'},
};

const PRIORITY_OPTIONS = [
  {value: 'high', label: 'High'},
  {value: 'medium', label: 'Medium'},
  {value: 'low', label: 'Low'},
];

// How often to re-fetch while idle (not mid-drag, no dialog open) — the
// board is also written by life_admin_agent's board_tools.py, completely
// outside this panel's own request cycle, so it needs the same kind of
// external-update poll ChatPanel already has for voice-driven turns.
const EXTERNAL_UPDATE_POLL_MS = 4000;

// Pointer travel (px) before a press is promoted to a drag, so taps and clicks
// on card controls still register normally.
const DRAG_THRESHOLD = 5;

// Shared width for every board column, so they stay visually aligned.
const COLUMN_WIDTH = 300;

// ============= STYLES =============
// Plain inline style objects — see the module's original note: the
// downloaded template used StyleX, which needs a build-time compiler this
// Vite project doesn't have configured. The one :hover effect
// (`.kanban-card` below) is a real CSS class in index.css since inline
// styles can't express pseudo-classes.

const styles = {
  boardColumns: {
    overflowX: 'auto',
    overflowY: 'hidden',
    height: '100%',
    padding: 'var(--spacing-4)',
  } as const,
  columnShell: {
    flexShrink: 0,
    flexBasis: COLUMN_WIDTH,
    height: '100%',
  } as const,
  floating: {
    position: 'fixed',
    insetBlockStart: 0,
    insetInlineStart: 0,
    pointerEvents: 'none',
    cursor: 'grabbing',
    boxShadow: 'var(--shadow-high)',
    zIndex: 1000,
  } as const,
  floatingAt: (x: number, y: number, width: number) => ({
    width,
    transform: `translate(${x}px, ${y}px)`,
  }),
  ghost: (height: number) => ({
    height,
    borderRadius: 'var(--radius-container)',
    backgroundColor: 'var(--color-background-muted)',
  }),
  columnEmptyState: {
    paddingBlock: 'var(--spacing-10)',
  } as const,
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

  useEffect(() => {
    if (isOpen) setValue(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="form" width={420}>
      <Layout
        header={
          <LayoutHeader hasDivider>
            <Heading level={3}>{title}</Heading>
          </LayoutHeader>
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              <TextInput
                label="Title"
                value={value.title}
                onChange={(v) => setValue((s) => ({...s, title: v}))}
                isRequired
                hasAutoFocus
              />
              <TextArea
                label="Description"
                value={value.description}
                onChange={(v) => setValue((s) => ({...s, description: v}))}
                isOptional
                rows={3}
              />
              <Selector
                label="Priority"
                value={value.priority}
                onChange={(v) => setValue((s) => ({...s, priority: v as BoardPriority}))}
                options={PRIORITY_OPTIONS}
              />
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={() => onOpenChange(false)} />
              <Button
                label="Save"
                variant="primary"
                isLoading={isSaving}
                isDisabled={!value.title.trim()}
                onClick={() => onSubmit(value)}
              />
            </HStack>
          </LayoutFooter>
        }
      />
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
  const moveTargets = COLUMNS.filter(c => c.id !== item.column).map(c => ({
    label: `Move to ${c.title}`,
    onClick: () => onMove(item.id, c.id),
  }));

  return (
    <VStack gap={2}>
      <HStack hAlign="between" vAlign="start">
        <HStack gap={1} vAlign="center" wrap="wrap">
          <Badge label={item.ref} variant="neutral" />
          <Badge label={priority.label} variant={priority.variant} />
        </HStack>
        <MoreMenu
          label="Work item actions"
          size="sm"
          items={[
            {label: 'Edit', onClick: () => onEdit(item)},
            {type: 'divider'},
            ...moveTargets,
            {type: 'divider'},
            {label: 'Delete', onClick: () => onDelete(item)},
          ]}
        />
      </HStack>

      <VStack gap={1}>
        <Heading level={4}>{item.title}</Heading>
        {item.description && (
          <Text type="supporting" color="secondary" maxLines={2}>
            {item.description}
          </Text>
        )}
      </VStack>

      <Text type="supporting" color="secondary">
        Updated <Timestamp value={item.updated_at} format="relative" />
      </Text>
    </VStack>
  );
}

// ============= BOARD CARD =============

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
    <Card
      ref={cardRef}
      padding={3}
      className="kanban-card"
      onPointerDown={e => onPointerDown(e, item.id)}>
      <BoardCardBody item={item} onMove={onMove} onEdit={onEdit} onDelete={onDelete} />
    </Card>
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
    <Card variant="muted" padding={0} style={styles.columnShell}>
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider padding={3}>
            <HStack hAlign="between" vAlign="center">
              <HStack gap={2} vAlign="center">
                <StatusDot
                  variant={meta.variant}
                  label={`${meta.title} status`}
                />
                <Heading level={4}>{meta.title}</Heading>
                <Tooltip content={meta.tooltip}>
                  <Icon
                    icon={InformationCircleIcon}
                    size="sm"
                    color="secondary"
                  />
                </Tooltip>
              </HStack>
              <Text type="supporting" color="secondary" hasTabularNumbers>
                {count}
              </Text>
            </HStack>
          </LayoutHeader>
        }
        content={
          <LayoutContent ref={contentRef} padding={2}>
            {children ?? (
              <EmptyState
                isCompact
                style={styles.columnEmptyState}
                icon={
                  <Icon icon={meta.emptyIcon} size="lg" color="secondary" />
                }
                title={meta.emptyTitle}
                description={meta.emptyDescription}
              />
            )}
          </LayoutContent>
        }
      />
    </Card>
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
  const columnRefCbs = useRef(
    new Map<BoardColumnId, (el: HTMLDivElement | null) => void>(),
  );
  const cardRefCbs = useRef(
    new Map<string, (el: HTMLDivElement | null) => void>(),
  );
  const teardownRef = useRef<(() => void) | null>(null);

  const getColumnRef = (id: BoardColumnId) => {
    let cb = columnRefCbs.current.get(id);
    if (!cb) {
      cb = el => {
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
      cb = el => {
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
      'in-progress': [],
      'in-review': [],
      done: [],
    };
    for (const item of items) {
      map[item.column].push(item);
    }
    return map;
  }, [items]);

  const moveItem = (id: string, to: BoardColumnId) => {
    setItems(prev => prev.map(item => (item.id === id ? {...item, column: to} : item)));
    updateBoardTask(id, {column: to}).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  };

  const computeTarget = (
    px: number,
    py: number,
    draggedId: string,
  ): DropTarget | null => {
    for (const [colId, el] of Array.from(columnEls.current.entries())) {
      const r = el.getBoundingClientRect();
      if (px < r.left || px > r.right || py < r.top || py > r.bottom) {
        continue;
      }

      const ids = itemsByColumn[colId]
        .filter(it => it.id !== draggedId)
        .map(it => it.id);

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
      return {column: colId, index};
    }
    return null;
  };

  const commitDrag = (id: string, target: DropTarget) => {
    setItems(prev => {
      const moved = prev.find(it => it.id === id);
      if (!moved) return prev;

      const rest = prev.filter(it => it.id !== id);
      const updated: BoardTask = {...moved, column: target.column};
      const colItems = rest.filter(it => it.column === target.column);
      const anchor = colItems[target.index];

      if (!anchor) {
        return [...rest, updated];
      }
      const at = rest.indexOf(anchor);
      return [...rest.slice(0, at), updated, ...rest.slice(at)];
    });
    updateBoardTask(id, {column: target.column, position: target.index}).catch(
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  };

  const onCardPointerDown = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    if (
      (e.target as HTMLElement).closest(
        'button, [role="menuitem"], [role="menu"]',
      )
    ) {
      return;
    }

    const el = cardEls.current.get(id);
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const offsetX = startX - rect.left;
    const offsetY = startY - rect.top;
    const {width, height} = rect;

    let started = false;
    let target: DropTarget | null = null;

    const onMove = (ev: PointerEvent) => {
      if (
        !started &&
        Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) <
          DRAG_THRESHOLD
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
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      teardownRef.current = null;
    };
    teardownRef.current = teardown;

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const draggedItem = drag ? items.find(it => it.id === drag.id) : undefined;
  const isDragging = drag !== null;

  useEffect(() => {
    if (!isDragging) return;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.userSelect = previous;
    };
  }, [isDragging]);

  useEffect(() => () => teardownRef.current?.(), []);

  const renderColumnCards = (colId: BoardColumnId): ReactNode => {
    const colItems = itemsByColumn[colId];
    const visible = drag ? colItems.filter(it => it.id !== drag.id) : colItems;
    const ghostTarget =
      drag && drag.target && drag.target.column === colId ? drag : null;

    if (visible.length === 0 && !ghostTarget) {
      return null;
    }

    const nodes: ReactNode[] = visible.map(it => (
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
        <VStack key="drag-ghost" style={styles.ghost(ghostTarget.height)} />,
      );
    }

    return <VStack gap={2}>{nodes}</VStack>;
  };

  async function handleCreate(value: TaskFormValue) {
    setIsSaving(true);
    try {
      const created = await createBoardTask({column: 'todo', ...value});
      setItems(prev => [...prev, created]);
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
      setItems(prev => prev.map(it => (it.id === updated.id ? updated : it)));
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
      setItems(prev => prev.filter(it => it.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Section height="100%">
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider padding={4}>
            <Toolbar
              label="Board actions"
              gap={2}
              startContent={
                <>
                  <Heading level={3}>Sprint Board</Heading>
                  <Badge label={items.length} variant="neutral" />
                  {error && (
                    <Text type="supporting" style={{color: 'var(--color-error)'}}>
                      {error}
                    </Text>
                  )}
                </>
              }
              endContent={
                <HStack gap={2}>
                  <IconButton
                    icon={<Icon icon={ArrowPathIcon} size="sm" />}
                    label="Refresh"
                    onClick={refetch}
                  />
                  <Button
                    label="Add task"
                    variant="primary"
                    icon={<Icon icon={PlusIcon} size="sm" />}
                    onClick={() => setIsAddOpen(true)}
                  />
                </HStack>
              }
            />
          </LayoutHeader>
        }
        content={
          <LayoutContent padding={0}>
            {!loaded ? (
              <EmptyState isCompact title="Loading board…" style={styles.columnEmptyState} />
            ) : (
              <HStack gap={4} style={styles.boardColumns}>
                {COLUMNS.map(meta => (
                  <BoardColumn
                    key={meta.id}
                    meta={meta}
                    count={itemsByColumn[meta.id].length}
                    contentRef={getColumnRef(meta.id)}>
                    {renderColumnCards(meta.id)}
                  </BoardColumn>
                ))}
              </HStack>
            )}
          </LayoutContent>
        }
      />
      {drag && draggedItem ? (
        <Card
          padding={3}
          style={{
            ...styles.floating,
            ...styles.floatingAt(
              drag.pointerX - drag.offsetX,
              drag.pointerY - drag.offsetY,
              drag.width,
            ),
          }}>
          <BoardCardBody
            item={draggedItem}
            onMove={() => {}}
            onEdit={() => {}}
            onDelete={() => {}}
          />
        </Card>
      ) : null}

      <TaskFormDialog
        isOpen={isAddOpen}
        onOpenChange={setIsAddOpen}
        initial={{title: '', description: '', priority: 'medium'}}
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
            : {title: '', description: '', priority: 'medium'}
        }
        onSubmit={handleEditSave}
        isSaving={isSaving}
        title={`Edit ${editTarget?.ref ?? 'task'}`}
      />
      <AlertDialog
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.ref ?? 'task'}?`}
        description={`"${deleteTarget?.title ?? ''}" will be permanently deleted. This can't be undone.`}
        actionLabel="Delete"
        actionVariant="destructive"
        onAction={handleDeleteConfirm}
        isActionLoading={isSaving}
      />
    </Section>
  );
}
