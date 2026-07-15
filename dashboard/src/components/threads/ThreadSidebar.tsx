import { useCallback, useEffect, useState } from "react";
import { MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import {
  createThread,
  deleteThread,
  fetchThreads,
  renameThread,
  setActiveThread,
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
}

// A persistent, Claude-style sidebar — visible from every tab (Chat/
// History/Memory/Cost), not scoped to one panel, since switching
// conversations is a cross-cutting action. This supersedes Phase 15's
// original design, which deliberately scoped full thread management to
// the History tab alone (PLAN.md's locked scope-split decision) — that
// was reopened and changed on the user's explicit request for Claude-like
// switching from the chat window itself, not a silent reversal.
//
// App.tsx uses onActiveThreadChange to remount ChatPanel/HistoryPanel via
// `key={activeThreadId}` whenever it changes — both panels already call
// their fetch functions with no thread_id, which server.py resolves
// against the SAME active pointer this sidebar moves, so a remount is all
// it takes for them to pick up the new thread. No thread_id prop drilling
// needed.
export function ThreadSidebar({ onActiveThreadChange }: ThreadSidebarProps) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [openDeleteDialogId, setOpenDeleteDialogId] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetchThreads()
      .then((result) => {
        setThreads(result.threads);
        setActiveThreadId(result.activeThreadId);
        onActiveThreadChange(result.activeThreadId);
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

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col gap-3 border-r border-sidebar-border bg-sidebar p-3 text-sidebar-foreground">
      <Button
        size="sm"
        className="w-full justify-start gap-1.5"
        onClick={() => void handleNewChat()}
        disabled={actionPending}
      >
        <MessageSquarePlus className="size-4" />
        New chat
      </Button>
      <p className="panel-label px-1 text-[0.65rem] text-muted-foreground">Threads</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5" data-testid="thread-list">
          {threads.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">No conversations yet.</p>
          )}
          {threads.map((thread) => {
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
              <div key={thread.id} className="group relative flex items-center gap-0.5 rounded-md">
                {isActive && (
                  <span
                    aria-hidden
                    className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-operator"
                  />
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
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => startRename(thread)}
                  aria-label={`Rename ${label}`}
                  data-testid="thread-rename-trigger"
                  className="shrink-0 opacity-0 group-hover:opacity-100"
                >
                  <Pencil className="size-3.5" />
                </Button>
                <AlertDialog
                  open={openDeleteDialogId === thread.id}
                  onOpenChange={(open) => setOpenDeleteDialogId(open ? thread.id : null)}
                >
                  <AlertDialogTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={deletingId === thread.id}
                        aria-label={`Delete ${label}`}
                        data-testid="thread-delete-trigger"
                        className="shrink-0 text-destructive opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    }
                  />
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This permanently removes &ldquo;{label}&rdquo; from the conversation list.
                        This cannot be undone.
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
          })}
        </div>
      </ScrollArea>
    </aside>
  );
}
