import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { fetchWorkflows, type WorkflowRun, type WorkflowStep } from "@/lib/api";

// PLAN.md Phase 25 — the dashboard-side surface for the cross-app workflow
// audit (decision D10). Read-only, same reasoning MemoryPanel's review
// queue and AutomationsPanel's run log both already establish for
// after-the-fact records: there is no create/update/delete here, only
// fetchWorkflows(). The one thing this panel exists to make visible that
// nothing else does — decision D3's whole point — is putting each step's
// PLANNED summary and its REAL executed arguments side by side, so a
// divergence between what was approved and what actually ran (decision
// D2's own accepted risk) is something you can actually go look at,
// not something silently trusted.

function statusVariant(status: WorkflowRun["status"]): "default" | "secondary" | "destructive" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  return "secondary";
}

function outcomeLabel(outcome: WorkflowStep["outcome"]): string {
  if (outcome === "success") return "Executed";
  if (outcome === "failed") return "Failed";
  if (outcome === "never_ran") return "Never ran";
  return "Pending";
}

function outcomeVariant(outcome: WorkflowStep["outcome"]): "default" | "secondary" | "destructive" {
  if (outcome === "success") return "default";
  if (outcome === "failed" || outcome === "never_ran") return "destructive";
  return "secondary";
}

function StepRow({ step }: { step: WorkflowStep }) {
  return (
    <div className="rounded-md border p-2" data-testid="workflow-step-row">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">
          Step {step.step_index + 1}: {step.action}
        </span>
        <div className="flex items-center gap-1.5">
          {step.diverged && (
            <Badge variant="destructive" data-testid="workflow-step-diverged">
              Diverged
            </Badge>
          )}
          <Badge variant={outcomeVariant(step.outcome)}>{outcomeLabel(step.outcome)}</Badge>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Approved plan said:</p>
          <p className="whitespace-pre-wrap rounded-md border bg-muted p-2 font-mono text-xs">
            {step.planned_summary}
          </p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Actually executed with:</p>
          <pre
            className="whitespace-pre-wrap rounded-md border bg-muted p-2 font-mono text-xs"
            data-testid="workflow-step-executed-args"
          >
            {step.executed_args
              ? JSON.stringify(step.executed_args, null, 2)
              : "(not yet executed)"}
          </pre>
        </div>
      </div>
      {step.detail && <p className="mt-1 text-xs text-muted-foreground">{step.detail}</p>}
    </div>
  );
}

export function WorkflowsPanel() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchWorkflows()
      .then(setRuns)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Cross-app workflows (PLAN.md Phase 25) — each run shows the plan you approved next to what
          actually executed. Read-only: workflows are created and run from a real conversation, not
          from this panel.
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <ScrollArea className="min-h-0 flex-1 rounded-md border p-4">
        <div className="flex flex-col gap-3">
          {runs.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">No workflow runs yet.</p>
          )}
          {runs.map((run) => (
            <Card key={run.id} size="sm" data-testid="workflow-run">
              <CardContent>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">{run.goal}</p>
                  <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Created {run.created_at}
                  {run.completed_at ? ` · Completed ${run.completed_at}` : ""}
                </p>
                <div className="mt-2 flex flex-col gap-2">
                  {run.steps.map((step) => (
                    <StepRow key={step.step_index} step={step} />
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
