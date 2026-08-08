import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { InstrumentCard } from "@/components/ui/instrument-card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
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
import {
  approvePendingFact,
  createMemoryFact,
  declinePendingFact,
  deleteMemoryFact,
  fetchMemoryFacts,
  fetchPendingFacts,
  triggerMemoryReview,
  updateMemoryFact,
  type MemoryFact,
  type PendingFact,
} from "@/lib/api";

// PLAN.md Phase 9 step 5 — "what the assistant knows about me," view AND
// delete. `/memory/facts` (GET/DELETE) already existed from step 1
// (assistant/server.py); this panel is the first UI for it. Extended later
// with direct add/edit (`POST`/`PATCH /memory/facts`) so the user isn't
// limited to whatever the agent's own extraction gate happened to propose,
// and again (2026-07-28) with a pending-review section: memory_review_
// agent.py's nightly batch pass (replacing the old per-turn interrupt()-
// gated extraction) queues candidates here instead, and approving/
// declining a card IS the confirmation step now — see memory_extraction.
// py's module docstring for the full architecture change.
//
// None of add/edit/delete/approve/decline here go through LangGraph's
// interrupt() gate — server.py's own docstrings are explicit that the gate
// was for the AGENT's autonomous writes, not the user curating their own
// store directly (or, for pending facts, giving the actual confirmation a
// nightly proposal needs before it becomes a real fact). Deletion of an
// already-saved fact is still irreversible from the user's own point of
// view, so it keeps its explicit AlertDialog confirm (Cancel/Delete) before
// calling deleteMemoryFact — a client-side UX safeguard against a stray
// click, not a security boundary. Approving/declining a PENDING fact
// doesn't need that same dialog: the card itself, sitting in a dedicated
// review section rather than mixed into the main list, already IS the
// deliberate confirmation step.
export function MemoryPanel() {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [openDialogId, setOpenDialogId] = useState<number | null>(null);
  const [newFactText, setNewFactText] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [savingEditId, setSavingEditId] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingFact[]>([]);
  const [checkingNow, setCheckingNow] = useState(false);
  const [decidingId, setDecidingId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchMemoryFacts(), fetchPendingFacts()])
      .then(([nextFacts, nextPending]) => {
        setFacts(nextFacts);
        setPending(nextPending);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCheckNow() {
    setCheckingNow(true);
    setError(null);
    try {
      await triggerMemoryReview();
      const nextPending = await fetchPendingFacts();
      setPending(nextPending);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingNow(false);
    }
  }

  async function handleApprovePending(id: number) {
    setDecidingId(id);
    setError(null);
    try {
      const fact = await approvePendingFact(id);
      setPending((prev) => prev.filter((p) => p.id !== id));
      setFacts((prev) => [fact, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDecidingId(null);
    }
  }

  async function handleDeclinePending(id: number) {
    setDecidingId(id);
    setError(null);
    try {
      await declinePendingFact(id);
      setPending((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDecidingId(null);
    }
  }

  async function handleAddFact() {
    const content = newFactText.trim();
    if (!content) return;
    setAdding(true);
    setError(null);
    try {
      const fact = await createMemoryFact(content);
      setFacts((prev) => [fact, ...prev]);
      setNewFactText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  function startEditing(fact: MemoryFact) {
    setEditingId(fact.id);
    setEditText(fact.content);
  }

  function cancelEditing() {
    setEditingId(null);
    setEditText("");
  }

  async function handleSaveEdit(id: number) {
    const content = editText.trim();
    if (!content) return;
    setSavingEditId(id);
    setError(null);
    try {
      await updateMemoryFact(id, content);
      setFacts((prev) => prev.map((fact) => (fact.id === id ? { ...fact, content } : fact)));
      setEditingId(null);
      setEditText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEditId(null);
    }
  }

  async function handleConfirmDelete(id: number) {
    setDeletingId(id);
    setError(null);
    try {
      await deleteMemoryFact(id);
      setFacts((prev) => prev.filter((fact) => fact.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
      setOpenDialogId(null);
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Durable facts the assistant has saved about you.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCheckNow()}
            disabled={checkingNow}
            data-testid="memory-check-now"
          >
            {checkingNow ? "Checking…" : "Check now"}
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {pending.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md border border-signal/60 bg-signal/5 p-3">
          <p className="panel-label text-[0.7rem] text-signal">
            Pending review — from last night&rsquo;s scan
          </p>
          {pending.map((p) => (
            <InstrumentCard key={p.id} className="p-3" data-testid="pending-fact-row">
              <div className="flex flex-col gap-2">
                <div>
                  <p className="whitespace-pre-wrap text-sm">{p.content}</p>
                  {p.provenance && (
                    <p className="mt-1 text-xs text-muted-foreground">Source: {p.provenance}</p>
                  )}
                </div>
                <div className="flex gap-2 border-t border-graphite/20 pt-2">
                  <Button
                    size="sm"
                    onClick={() => void handleApprovePending(p.id)}
                    disabled={decidingId === p.id}
                  >
                    {decidingId === p.id ? "Approving…" : "Approve"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleDeclinePending(p.id)}
                    disabled={decidingId === p.id}
                  >
                    Decline
                  </Button>
                </div>
              </div>
            </InstrumentCard>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-md border p-3">
        <Textarea
          placeholder="Add something for the assistant to remember about you…"
          value={newFactText}
          onChange={(e) => setNewFactText(e.target.value)}
          disabled={adding}
          rows={2}
          data-testid="new-fact-input"
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => void handleAddFact()}
            disabled={adding || !newFactText.trim()}
            data-testid="new-fact-submit"
          >
            {adding ? "Adding…" : "Add fact"}
          </Button>
        </div>
      </div>
      {/* min-h-0 — see ChatPanel.tsx's comment on the same pattern: without
          it a growing list expands the whole page instead of scrolling
          internally (found live in the real window, STEPS.md 61). */}
      <ScrollArea className="min-h-0 flex-1 rounded-md border p-4">
        <div className="flex flex-col gap-2">
          {facts.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">No facts stored yet.</p>
          )}
          {facts.map((fact) => (
            <InstrumentCard key={fact.id} className="p-3" data-testid="memory-fact-row">
              <div className="flex flex-col gap-2">
                <div>
                  {editingId === fact.id ? (
                    <Textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      disabled={savingEditId === fact.id}
                      rows={2}
                      data-testid="edit-fact-input"
                    />
                  ) : (
                    // Verbatim — the same no-re-summarization principle as the
                    // chat panel's interrupt gate, even though this isn't
                    // itself gated: this is the exact string that was
                    // approved/saved, unless the user has since edited it.
                    <p className="whitespace-pre-wrap text-sm">{fact.content}</p>
                  )}
                  {fact.provenance && (
                    <p className="mt-1 text-xs text-muted-foreground">Source: {fact.provenance}</p>
                  )}
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{fact.created_at}</p>
                </div>
                <div className="flex gap-2 border-t border-graphite/20 pt-2">
                  {editingId === fact.id ? (
                    <>
                      <Button variant="ghost" size="sm" onClick={cancelEditing}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void handleSaveEdit(fact.id)}
                        disabled={savingEditId === fact.id || !editText.trim()}
                      >
                        {savingEditId === fact.id ? "Saving…" : "Save"}
                      </Button>
                    </>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => startEditing(fact)}>
                      Edit
                    </Button>
                  )}
                  <AlertDialog
                    open={openDialogId === fact.id}
                    onOpenChange={(open) => setOpenDialogId(open ? fact.id : null)}
                  >
                    <AlertDialogTrigger
                      render={
                        <Button variant="destructive" size="sm" disabled={deletingId === fact.id}>
                          {deletingId === fact.id ? "Deleting…" : "Delete"}
                        </Button>
                      }
                    />
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Delete this fact?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This removes it from long-term memory permanently. The assistant will no
                          longer recall: &ldquo;{fact.content}&rdquo;
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void handleConfirmDelete(fact.id)}>
                          Delete
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            </InstrumentCard>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
