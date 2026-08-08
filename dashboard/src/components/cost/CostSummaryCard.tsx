import { useEffect, useState } from "react";
import { fetchCost, type CostStats } from "@/lib/api";
import { useCountUp } from "@/lib/useCountUp";

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

  // Hooks called unconditionally, ABOVE the unavailable/loading early
  // returns below (falling back to 0 with no `stats` yet) — count-up must
  // stay a stable hook call across every render of this component.
  const week = stats?.windows.week;
  const cost = useCountUp(week?.total_cost ?? 0);
  const tokens = useCountUp(week?.total_tokens ?? 0);
  const runs = useCountUp(week?.run_count ?? 0);

  if (unavailable) {
    return <p className="text-xs text-muted-foreground">Cost data unavailable.</p>;
  }
  if (!stats) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="font-mono text-xl font-semibold text-foreground">
        {currencyFormatter.format(cost)}
      </p>
      <p className="font-mono text-[11px] text-muted-foreground">
        {Math.round(tokens).toLocaleString()} tokens · {Math.round(runs).toLocaleString()} runs
      </p>
    </div>
  );
}
