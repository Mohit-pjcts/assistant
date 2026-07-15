import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchCost, LangSmithNotConfiguredError, type CostStats, type CostWindow } from "@/lib/api";

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

// Stat-tile contract (dataviz skill): label in sentence case, value in the
// data typeface (never the display face — this project's IBM Plex Mono
// grammar for all figures elsewhere stands in for the skill's "Sans
// semibold" rule), text stays in text tokens rather than the accent color
// ("text never wears the data color" — the accent is a marker BESIDE the
// label, not a tint on the number itself). No sparkline/delta: Today / Last
// 7 days / All time are overlapping windows, not points on a timeline, so a
// trend line would misrepresent them rather than inform.
function WindowCard({ label, stats }: { label: string; stats: CostWindow }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-operator" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        <p className="font-mono text-2xl font-semibold text-foreground">
          {currencyFormatter.format(stats.total_cost)}
        </p>
        <p className="font-mono text-sm tabular-nums text-muted-foreground">
          {stats.total_tokens.toLocaleString()} tokens · {stats.run_count.toLocaleString()} runs
        </p>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
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
          LangSmith isn&apos;t configured (missing or invalid LANGSMITH_API_KEY) — cost tracking is
          unavailable until it is.
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
