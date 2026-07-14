import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
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
import { deleteMemoryFact, fetchMemoryFacts, type MemoryFact } from "@/lib/api";

// PLAN.md Phase 9 step 5 — "what the assistant knows about me," view AND
// delete. `/memory/facts` (GET/DELETE) already existed from step 1
// (assistant/server.py); this panel is the first UI for it.
//
// Deletion here is NOT behind LangGraph's interrupt() gate — server.py's
// own docstring is explicit that the gate is for the AGENT's autonomous
// writes (memory_extraction.py), not the user curating their own
// already-saved data. But it's still irreversible from the user's own
// point of view, so this panel requires an explicit AlertDialog confirm
// (Cancel/Delete) before calling deleteMemoryFact — a client-side UX
// safeguard against a stray click, not a security boundary.
export function MemoryPanel() {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [openDialogId, setOpenDialogId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchMemoryFacts()
      .then(setFacts)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ScrollArea className="flex-1 rounded-md border p-4">
        <div className="flex flex-col gap-2">
          {facts.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">No facts stored yet.</p>
          )}
          {facts.map((fact) => (
            <Card key={fact.id} size="sm" data-testid="memory-fact-row">
              <CardContent>
                {/* Verbatim — the same no-re-summarization principle as the
                    chat panel's interrupt gate, even though deletion isn't
                    itself gated: this is still the exact string that was
                    approved and saved. */}
                <p className="whitespace-pre-wrap text-sm">{fact.content}</p>
                {fact.provenance && (
                  <p className="mt-1 text-xs text-muted-foreground">Source: {fact.provenance}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">{fact.created_at}</p>
              </CardContent>
              <CardFooter>
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
              </CardFooter>
            </Card>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
