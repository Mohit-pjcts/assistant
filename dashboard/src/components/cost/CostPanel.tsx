import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  fetchCost,
  LangSmithNotConfiguredError,
  type CostStats,
  type CostWindow,
} from "@/lib/api";

// PLAN.md Phase 9 step 6, the last of the initial panel set — real
// LangSmith token/cost aggregates (server.py's /cost), not a locally
// computed pricing estimate. CLAUDE.md's Cost section: flag spend, don't
// guess at it.
const WINDOW_LABELS: Record<keyof CostStats["windows"], string> = {
  today: "Today",
  week: "Last 7 days",
  all_time: "All time",
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function WindowCard({ label, stats }: { label: string; stats: CostWindow }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <p className="text-2xl font-semibold">{currencyFormatter.format(stats.total_cost)}</p>
        <p className="text-sm text-muted-foreground">
          {stats.total_tokens.toLocaleString()} tokens · {stats.run_count.toLocaleString()} runs
        </p>
        <p className="text-xs text-muted-foreground">
          {stats.prompt_tokens.toLocaleString()} prompt / {stats.completion_tokens.toLocaleString()}{" "}
          completion
        </p>
      </CardContent>
    </Card>
  );
}

export function CostPanel() {
  const [stats, setStats] = useState<CostStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    setNotConfigured(false);
    fetchCost()
      .then(setStats)
      .catch((err: unknown) => {
        if (err instanceof LangSmithNotConfiguredError) {
          setNotConfigured(true);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Real usage aggregates from LangSmith, not a local estimate.
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {notConfigured && (
        <p className="text-sm text-muted-foreground">
          LangSmith isn&apos;t configured (missing or invalid LANGSMITH_API_KEY) — cost tracking
          is unavailable until it is.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {stats && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(Object.keys(WINDOW_LABELS) as (keyof CostStats["windows"])[]).map((key) => (
            <WindowCard key={key} label={WINDOW_LABELS[key]} stats={stats.windows[key]} />
          ))}
        </div>
      )}
    </div>
  );
}
