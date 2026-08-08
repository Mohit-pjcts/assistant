import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Asterisk,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  EllipsisVertical,
  Folder,
  FolderPlus,
  MessageSquarePlus,
  Pencil,
  Trash2,
} from "lucide-react";
import { RadialChatSelector } from "./RadialChatSelector";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  assignThreadProject,
  createProject,
  createThread,
  deleteProject,
  deleteThread,
  fetchProjects,
  fetchThreads,
  renameProject,
  renameThread,
  setActiveThread,
  type Project,
  type ThreadSummary,
} from "@/lib/api";

interface ThreadSidebarProps {
  // Write-only from this component's point of view: it tracks its own
  // authoritative `activeThreadId` locally (from fetchThreads/switch/
  // create/delete responses) for rendering, and calls this purely to let
  // the parent know — it never reads a value back through props. That
  // avoids a prop round-trip (child reports -> parent re-renders -> new
  // prop flows back down) just to know what it already knows.
  onActiveThreadChange: (threadId: string) => void;
  // Optional: App.tsx's draggable column divider drives this (px) once
  // the user resizes the sidebar; the Tailwind w-[216px] below stays as
  // the default for anyone who hasn't dragged it yet.
  width?: number;
}

// A persistent, Claude-style sidebar — visible from every tab (Chat/
// History/Memory/Cost), not scoped to one panel, since switching
// conversations is a cross-cutting action. This supersedes Phase 15's
// original design, which deliberately scoped full thread management to
// the History tab alone (PLAN.md's locked scope-split decision) — that
// was reopened and changed on the user's explicit request for Claude-like
// switching from the chat window itself, not a silent reversal.
//
// PLAN.md Phase 28 extends this into a collapsible Project/Thread tree
// (`Oni -> Project -> Thread`, see CONTEXT.md) — threads with no
// project_id (every thread that existed before this phase, plus any new
// thread until explicitly moved) render as a flat list below the project
// folders, identical to this component's pre-Phase-28 appearance. Both of
// Phase 28's locked assignment mechanisms (the "Move to project" menu
// action and tree drag-and-drop) funnel through the same
// `handleAssignThreadProject`, which is itself a thin wrapper around the
// one server endpoint (`PATCH /threads/{id}/project`) both paths share.
//
// App.tsx uses onActiveThreadChange to remount ChatPanel/HistoryPanel via
// `key={activeThreadId}` whenever it changes — both panels already call
// their fetch functions with no thread_id, which server.py resolves
// against the SAME active pointer this sidebar moves, so a remount is all
// it takes for them to pick up the new thread. No thread_id prop drilling
// needed.
export function ThreadSidebar({ onActiveThreadChange, width }: ThreadSidebarProps) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [openDeleteDialogId, setOpenDeleteDialogId] = useState<string | null>(null);

  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(new Set());
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectValue, setNewProjectValue] = useState("");
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [renameProjectValue, setRenameProjectValue] = useState("");
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [openDeleteProjectDialogId, setOpenDeleteProjectDialogId] = useState<string | null>(null);
  const [dragThreadId, setDragThreadId] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [radialOpen, setRadialOpen] = useState(false);

  const load = useCallback(() => {
    setError(null);
    Promise.all([fetchThreads(), fetchProjects()])
      .then(([threadResult, projectResult]) => {
        setThreads(threadResult.threads);
        setProjects(projectResult);
        setActiveThreadId(threadResult.activeThreadId);
        onActiveThreadChange(threadResult.activeThreadId);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [onActiveThreadChange]);

  useEffect(() => {
    load();
    // Intentionally mount-only: `load` fetches whatever the server's
    // active pointer currently is, and every action below re-calls it
    // after mutating that pointer — a dependency-driven refetch loop isn't
    // needed on top of that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSwitch(threadId: string) {
    if (threadId === activeThreadId || actionPending) return;
    setActionPending(true);
    setError(null);
    try {
      await setActiveThread(threadId);
      setActiveThreadId(threadId);
      onActiveThreadChange(threadId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(false);
    }
  }

  async function handleNewChat() {
    if (actionPending) return;
    setActionPending(true);
    setError(null);
    try {
      const thread = await createThread();
      setActiveThreadId(thread.id);
      onActiveThreadChange(thread.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(false);
    }
  }

  function startRename(thread: ThreadSummary) {
    setRenamingId(thread.id);
    setRenameValue(thread.title ?? "");
  }

  async function submitRename(threadId: string) {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title) return;
    try {
      await renameThread(threadId, title);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleConfirmDelete(threadId: string) {
    setDeletingId(threadId);
    setError(null);
    try {
      const { activeThreadId: newActiveId } = await deleteThread(threadId);
      // Deleting the active thread reassigns the shared pointer
      // server-side (thread_store's "always exactly one active thread"
      // invariant) — pick that up immediately rather than waiting on load().
      setActiveThreadId(newActiveId);
      onActiveThreadChange(newActiveId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
      setOpenDeleteDialogId(null);
    }
  }

  async function handleAssignThreadProject(threadId: string, projectId: string | null) {
    setError(null);
    try {
      await assignThreadProject(threadId, projectId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleProjectCollapsed(projectId: string) {
    setCollapsedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  const allCollapsed = projects.length > 0 && projects.every((p) => collapsedProjectIds.has(p.id));

  function toggleCollapseAll() {
    setCollapsedProjectIds(allCollapsed ? new Set() : new Set(projects.map((p) => p.id)));
  }

  function startCreateProject() {
    setCreatingProject(true);
    setNewProjectValue("");
  }

  async function submitCreateProject() {
    const name = newProjectValue.trim();
    setCreatingProject(false);
    if (!name) return;
    try {
      await createProject(name);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function startRenameProject(project: Project) {
    setRenamingProjectId(project.id);
    setRenameProjectValue(project.name);
  }

  async function submitRenameProject(projectId: string) {
    const name = renameProjectValue.trim();
    setRenamingProjectId(null);
    if (!name) return;
    try {
      await renameProject(projectId, name);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleConfirmDeleteProject(projectId: string) {
    setDeletingProjectId(projectId);
    setError(null);
    try {
      await deleteProject(projectId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingProjectId(null);
      setOpenDeleteProjectDialogId(null);
    }
  }

  function handleDrop(projectId: string | null) {
    setDragOverTarget(null);
    const threadId = dragThreadId;
    setDragThreadId(null);
    if (!threadId) return;
    void handleAssignThreadProject(threadId, projectId);
  }

  const projectById = new Map(projects.map((p) => [p.id, p]));
  const threadsByProject = new Map<string, ThreadSummary[]>();
  const ungroupedThreads: ThreadSummary[] = [];
  for (const thread of threads) {
    if (thread.project_id && projectById.has(thread.project_id)) {
      const bucket = threadsByProject.get(thread.project_id) ?? [];
      bucket.push(thread);
      threadsByProject.set(thread.project_id, bucket);
    } else {
      ungroupedThreads.push(thread);
    }
  }

  function renderThreadRow(thread: ThreadSummary) {
    const isActive = thread.id === activeThreadId;
    const label = thread.title || thread.id;

    if (renamingId === thread.id) {
      return (
        <input
          key={thread.id}
          autoFocus
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={() => void submitRename(thread.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submitRename(thread.id);
            if (event.key === "Escape") setRenamingId(null);
          }}
          className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          data-testid="thread-rename-input"
        />
      );
    }

    return (
      // The Operator-blue rail on the left edge is this app's
      // recurring "selected/active" signal (see index.css's block
      // comment) — reused here instead of a plain background tint
      // so the same visual grammar means the same thing everywhere.
      <div
        key={thread.id}
        data-testid={`thread-row-${thread.id}`}
        className={cn(
          "group relative flex items-center gap-0.5 rounded-md",
          dragThreadId === thread.id && "opacity-50",
        )}
        draggable
        onDragStart={() => setDragThreadId(thread.id)}
        onDragEnd={() => {
          setDragThreadId(null);
          setDragOverTarget(null);
        }}
      >
        {isActive && (
          <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-operator" />
        )}
        <Button
          variant={isActive ? "secondary" : "ghost"}
          size="sm"
          disabled={actionPending}
          onClick={() => void handleSwitch(thread.id)}
          className={cn("min-w-0 flex-1 justify-start pl-3", isActive && "font-medium")}
          data-testid="thread-item"
          data-active={isActive}
        >
          <span className="truncate">{label}</span>
        </Button>
        {/* Consolidated "..." row menu, replacing three separate hover
            icon buttons (move/rename/delete) that used to crowd out the
            thread name — the actual reported bug (long titles truncating
            because three icons were competing with the label for the
            row's own width). One trigger, one menu; the destructive
            AlertDialog below is still a real confirmation gate, just
            opened from a menu item instead of its own dedicated button. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${label} options`}
                data-testid="thread-options-trigger"
                className="shrink-0 opacity-0 group-hover:opacity-100"
              >
                <EllipsisVertical className="size-3.5" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => startRename(thread)}
              data-testid="thread-rename-trigger"
            >
              <Pencil className="size-3.5" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Move to project</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => void handleAssignThreadProject(thread.id, null)}>
              No project
            </DropdownMenuItem>
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onClick={() => void handleAssignThreadProject(thread.id, project.id)}
              >
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: project.color }}
                />
                {project.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setOpenDeleteDialogId(thread.id)}
              disabled={deletingId === thread.id}
              data-testid="thread-delete-trigger"
              className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
            >
              <Trash2 className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AlertDialog
          open={openDeleteDialogId === thread.id}
          onOpenChange={(open) => setOpenDeleteDialogId(open ? thread.id : null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes &ldquo;{label}&rdquo; from the conversation list. This
                cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void handleConfirmDelete(thread.id)}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  }

  function renderProjectSection(project: Project) {
    const projectThreads = threadsByProject.get(project.id) ?? [];
    const collapsed = collapsedProjectIds.has(project.id);
    const isDropTarget = dragOverTarget === project.id;

    if (renamingProjectId === project.id) {
      return (
        <input
          key={project.id}
          autoFocus
          value={renameProjectValue}
          onChange={(event) => setRenameProjectValue(event.target.value)}
          onBlur={() => void submitRenameProject(project.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submitRenameProject(project.id);
            if (event.key === "Escape") setRenamingProjectId(null);
          }}
          className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          data-testid="project-rename-input"
        />
      );
    }

    return (
      <div key={project.id} className="flex flex-col gap-0.5">
        <div
          data-testid={`project-drop-zone-${project.id}`}
          className={cn(
            "group flex items-center gap-1 rounded-md px-1",
            isDropTarget && "bg-accent ring-1 ring-operator",
          )}
          onDragOver={(event) => {
            if (dragThreadId) {
              event.preventDefault();
              setDragOverTarget(project.id);
            }
          }}
          onDragLeave={() =>
            setDragOverTarget((current) => (current === project.id ? null : current))
          }
          onDrop={(event) => {
            event.preventDefault();
            handleDrop(project.id);
          }}
        >
          <button
            type="button"
            onClick={() => toggleProjectCollapsed(project.id)}
            aria-label={collapsed ? `Expand ${project.name}` : `Collapse ${project.name}`}
            data-testid="project-header"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 text-left text-sm hover:bg-accent/50"
          >
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                !collapsed && "rotate-90",
              )}
            />
            <Folder className="size-3.5 shrink-0" style={{ color: project.color }} />
            <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
            <span className="panel-label shrink-0 text-[0.65rem] text-muted-foreground">
              {projectThreads.length}
            </span>
          </button>
          {/* Same "..." consolidation as renderThreadRow's own menu, and
              for the same reason — two separate hover icon buttons here
              competed with the project name for the row's width. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${project.name} project options`}
                  data-testid="project-options-trigger"
                  className="shrink-0 opacity-0 group-hover:opacity-100"
                >
                  <EllipsisVertical className="size-3.5" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => startRenameProject(project)}
                data-testid="project-rename-trigger"
              >
                <Pencil className="size-3.5" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setOpenDeleteProjectDialogId(project.id)}
                disabled={deletingProjectId === project.id}
                data-testid="project-delete-trigger"
                className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
              >
                <Trash2 className="size-3.5" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <AlertDialog
            open={openDeleteProjectDialogId === project.id}
            onOpenChange={(open) => setOpenDeleteProjectDialogId(open ? project.id : null)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this project?</AlertDialogTitle>
                <AlertDialogDescription>
                  &ldquo;{project.name}&rdquo; will be removed. Its threads are NOT deleted — they
                  become ungrouped.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void handleConfirmDeleteProject(project.id)}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {/* PLAN.md Phase 29 Stage 4: DESIGN.md's own tree-collapse
            technique animates an always-mounted wrapper's max-height —
            incompatible here, since ThreadSidebar.test.tsx's own
            pre-existing "collapsing hides threads" test requires a
            collapsed row to leave the DOM/accessibility tree entirely
            (`.not.toBeInTheDocument()`), not just be visually clipped.
            A deliberate, disclosed adaptation: EXPANDING still gets a
            real animated entrance via the shared `.reveal` clip-path
            technique (a fresh mount naturally retriggers a CSS
            `animation`, no JS class-toggle needed); collapsing stays an
            instant unmount, preserving the existing a11y-correct
            behavior the test already locks in. */}
        {!collapsed && (
          <div className="reveal flex flex-col gap-0.5 pl-4">
            {projectThreads.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">No threads yet.</p>
            ) : (
              projectThreads.map((thread) => renderThreadRow(thread))
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {/* PLAN.md Phase 29: 256px (w-64) -> 216px, matching
          instrument/DESIGN.md §3's own frame-body proportions (rail 52px
          now lives in NavRail.tsx, a separate sibling column — this used
          to be one 256px column combining both). */}
      <aside
        className="flex h-screen w-[216px] shrink-0 flex-col gap-3 border-r border-sidebar-border bg-sidebar p-3 text-sidebar-foreground"
        style={width ? { width } : undefined}
      >
        <Button
          size="sm"
          className="w-full justify-start gap-1.5"
          onClick={() => void handleNewChat()}
          disabled={actionPending}
        >
          <MessageSquarePlus className="size-4" />
          New chat
        </Button>
        <div className="flex items-center justify-between px-1">
          <p className="panel-label text-[0.65rem] text-muted-foreground">Threads</p>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setRadialOpen(true)}
              aria-label="Radial view"
              data-testid="radial-trigger"
            >
              <Asterisk className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={startCreateProject}
              aria-label="New project"
              data-testid="new-project-trigger"
            >
              <FolderPlus className="size-3.5" />
            </Button>
            {projects.length > 0 && (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={toggleCollapseAll}
                aria-label={allCollapsed ? "Expand all projects" : "Collapse all projects"}
                data-testid="collapse-all-trigger"
              >
                {allCollapsed ? (
                  <ChevronsUpDown className="size-3.5" />
                ) : (
                  <ChevronsDownUp className="size-3.5" />
                )}
              </Button>
            )}
          </div>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1" data-testid="thread-list">
            {creatingProject && (
              <input
                autoFocus
                value={newProjectValue}
                onChange={(event) => setNewProjectValue(event.target.value)}
                onBlur={() => void submitCreateProject()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitCreateProject();
                  if (event.key === "Escape") setCreatingProject(false);
                }}
                placeholder="Project name"
                className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                data-testid="project-create-input"
              />
            )}
            {projects.map((project) => renderProjectSection(project))}
            <div
              data-testid="ungrouped-drop-zone"
              className={cn(
                "flex flex-col gap-0.5 rounded-md",
                dragOverTarget === "ungrouped" && "bg-accent ring-1 ring-operator",
              )}
              onDragOver={(event) => {
                if (dragThreadId) {
                  event.preventDefault();
                  setDragOverTarget("ungrouped");
                }
              }}
              onDragLeave={() =>
                setDragOverTarget((current) => (current === "ungrouped" ? null : current))
              }
              onDrop={(event) => {
                event.preventDefault();
                handleDrop(null);
              }}
            >
              {threads.length === 0 && (
                <p className="px-2 py-1 text-xs text-muted-foreground">No conversations yet.</p>
              )}
              {ungroupedThreads.map((thread) => renderThreadRow(thread))}
            </div>
          </div>
        </ScrollArea>
      </aside>
      {radialOpen &&
        createPortal(
          // A plain `position:fixed` child here would be trapped inside
          // App.tsx's own mobile-drawer wrapper around <ThreadSidebar> —
          // that wrapper carries a `transform` utility (`md:translate-x-0`,
          // needed for the real Phase 21 iPhone-access slide-over drawer),
          // and ANY non-`none` computed `transform` on an ancestor creates
          // a new containing block for `position:fixed` descendants,
          // confining them to that ancestor's own box instead of the real
          // viewport (confirmed live: the overlay rendered at exactly the
          // sidebar's own 256px width instead of the full window).
          // Portalling straight to `document.body` sidesteps that ancestor
          // entirely, without touching its own legitimate transform.
          <RadialChatSelector
            projects={projects}
            threads={threads}
            activeThreadId={activeThreadId}
            onSelectThread={(threadId) => void handleSwitch(threadId)}
            onClose={() => setRadialOpen(false)}
          />,
          document.body,
        )}
    </>
  );
}
