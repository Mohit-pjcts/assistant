import { useEffect, useState } from "react";
import { fetchCost, type CostStats } from "@/lib/api";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

// Compact right-rail counterpart to the full Cost tab (CostPanel.tsx) —
// just the 7-day window, matching the redesign's rail widget. Reuses the
// same /cost endpoint and estimate framing (Langfuse's own token counts ×
// its price list, as of the 2026-07-25 LangSmith->Langfuse swap); see
// CostPanel.tsx for the full three-window view and the complete disclaimer
// about what this dollar figure actually represents (PLAN.md Phase 19).
export function CostSummaryCard() {
  const [stats, setStats] = useState<CostStats | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchCost()
      .then((result) => {
        if (!cancelled) setStats(result);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (unavailable) {
    return <p className="text-xs text-muted-foreground">Cost data unavailable.</p>;
  }
  if (!stats) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }

  const week = stats.windows.week;
  return (
    <div className="flex flex-col gap-1">
      <p className="font-mono text-xl font-semibold text-foreground">
        {currencyFormatter.format(week.total_cost)}
      </p>
      <p className="font-mono text-[11px] text-muted-foreground">
        {week.total_tokens.toLocaleString()} tokens · {week.run_count.toLocaleString()} runs
      </p>
    </div>
  );
}
