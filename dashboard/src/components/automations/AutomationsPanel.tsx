import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import {
  createAutomation,
  deleteAutomation,
  fetchAutomationRuns,
  fetchAutomations,
  updateAutomation,
  type Automation,
  type AutomationAction,
  type AutomationRun,
} from "@/lib/api";

// PLAN.md Phase 24 — the dashboard-side half of the pre-approved
// automation registry. Everything here is safe, ordinary CRUD (no
// confirmation gate needed — registering/editing/disabling an automation
// definition isn't itself a side effect, same reasoning MemoryPanel/
// KanbanBoard already establish for user-curated-data panels). The
// actual risk this phase introduces lives entirely in server.py's
// POST /automations/{id}/fire — this panel never calls that endpoint
// itself; firing only ever happens from the geofence-detecting Shortcut
// on the phone (PHONE_SETUP.md).
const ACTIONS: AutomationAction[] = ["send_imessage", "send_email"];

const EMPTY_FORM = {
  name: "",
  trigger_description: "",
  target: "",
  goal: "",
  action: ACTIONS[0],
};

export function AutomationsPanel() {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openDialogId, setOpenDialogId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchAutomations(), fetchAutomationRuns()])
      .then(([a, r]) => {
        setAutomations(a);
        setRuns(r);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate() {
    if (
      !form.name.trim() ||
      !form.trigger_description.trim() ||
      !form.target.trim() ||
      !form.goal.trim()
    ) {
      setError("Every field is required.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await createAutomation(form);
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleEnabled(automation: Automation) {
    setBusyId(automation.id);
    setError(null);
    try {
      await updateAutomation(automation.id, { enabled: !automation.enabled });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleConfirmDelete(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await deleteAutomation(id);
      setAutomations((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
      setOpenDialogId(null);
    }
  }

  const runsByAutomation = new Map<string, AutomationRun[]>();
  for (const run of runs) {
    const list = runsByAutomation.get(run.automation_id) ?? [];
    list.push(run);
    runsByAutomation.set(run.automation_id, list);
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Pre-approved automations — fire unattended off a geofence trigger from your phone, with no
          live confirmation (PLAN.md Phase 24). Registering one here does NOT arm it by itself; you
          still need to build the matching geofence Shortcut (PHONE_SETUP.md).
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card size="sm">
        <CardContent>
          <div className="flex flex-col gap-2">
            <Input
              placeholder="Name (e.g. Landing text to Mom)"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Input
              placeholder="Trigger (e.g. arrive at SFO)"
              value={form.trigger_description}
              onChange={(e) => setForm({ ...form, trigger_description: e.target.value })}
            />
            <Input
              placeholder="Target (e.g. Mom's phone number)"
              value={form.target}
              onChange={(e) => setForm({ ...form, target: e.target.value })}
            />
            <Textarea
              placeholder="Goal — what should the assistant accomplish (e.g. text them that I've landed)"
              value={form.goal}
              onChange={(e) => setForm({ ...form, goal: e.target.value })}
            />
            <select
              className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm"
              value={form.action}
              onChange={(e) => setForm({ ...form, action: e.target.value as AutomationAction })}
            >
              {ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
        <CardFooter>
          <Button size="sm" onClick={() => void handleCreate()} disabled={creating}>
            {creating ? "Creating…" : "Register automation"}
          </Button>
        </CardFooter>
      </Card>

      <ScrollArea className="min-h-0 flex-1 rounded-md border p-4">
        <div className="flex flex-col gap-2">
          {automations.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">No automations registered yet.</p>
          )}
          {automations.map((automation) => {
            const recentRuns = (runsByAutomation.get(automation.id) ?? []).slice(0, 3);
            return (
              <Card key={automation.id} size="sm" data-testid="automation-row">
                <CardContent>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{automation.name}</p>
                    <span
                      className={
                        automation.enabled
                          ? "text-xs font-medium text-primary"
                          : "text-xs text-muted-foreground"
                      }
                    >
                      {automation.enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Trigger: {automation.trigger_description} · Target: {automation.target} ·
                    Action: {automation.action}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">{automation.goal}</p>
                  {recentRuns.length > 0 && (
                    <div className="mt-2 border-t pt-2">
                      <p className="text-xs font-medium text-muted-foreground">Recent runs:</p>
                      {recentRuns.map((run) => (
                        <p key={run.id} className="font-mono text-xs text-muted-foreground">
                          {run.fired_at} — {run.outcome}
                          {run.detail ? `: ${run.detail}` : ""}
                        </p>
                      ))}
                    </div>
                  )}
                </CardContent>
                <CardFooter>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === automation.id}
                      onClick={() => void handleToggleEnabled(automation)}
                    >
                      {automation.enabled ? "Disable" : "Enable"}
                    </Button>
                    <AlertDialog
                      open={openDialogId === automation.id}
                      onOpenChange={(open) => setOpenDialogId(open ? automation.id : null)}
                    >
                      <AlertDialogTrigger
                        render={
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busyId === automation.id}
                          >
                            Delete
                          </Button>
                        }
                      />
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this automation?</AlertDialogTitle>
                          <AlertDialogDescription>
                            &ldquo;{automation.name}&rdquo; will no longer fire, even if its
                            geofence Shortcut still calls it — the endpoint will 404.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => void handleConfirmDelete(automation.id)}
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
