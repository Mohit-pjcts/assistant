import { useEffect, useState } from "react";
import { CostSourceNotConfiguredError, fetchCost } from "@/lib/api";
import type { CostStats } from "@/lib/api";
import { relativeTime } from "@/lib/relativeTime";
import { useCountUp } from "@/lib/useCountUp";
import { CostTrace } from "@/components/cost/CostTrace";
import { RateLimitCountdown } from "@/components/cost/RateLimitCountdown";

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
//
// Polls every 30 minutes. THIS WIDGET IS ALWAYS MOUNTED (App.tsx's right
// rail, outside the Tabs — not gated on the Cost tab being open), so
// whatever interval it polls at runs for as long as Oni's window is open,
// which in practice is most of the day. A real, live-diagnosed incident
// (2026-09-23): this used to poll every 60s, and `/cost` burns 3 Langfuse
// metrics-API requests per call (one per window) — 60s meant ~180
// requests/hour of pure background overhead, which exhausted Langfuse's
// own ~100-request cooldown window within the first hour of the app being
// open, every single day, leaving this card (and the Cost tab) stuck
// showing a stale/rate-limited snapshot for the ~20-hour cooldown that
// follows. This is almost certainly what was actually behind "the cost
// page is very inaccurate" — not a calculation bug. 30 minutes keeps the
// figure reasonably fresh for a slowly-changing weekly aggregate while
// keeping this card's own steady-state burn (3 req every 30 min) well
// clear of the cap even across a full day left open, with headroom left
// over for actual visits to the Cost tab (CostPanel.tsx's own on-mount
// fetch) and any other Langfuse metrics-API traffic.
//
// Server-side (server.py's `/cost`) separately absorbs a real,
// live-observed Langfuse rate limit itself — falling back to its own
// durable last-known-good snapshot per window (`stale`/`no_data`/
// `read_at`) and reporting a top-level `rate_limited` countdown target —
// so `fetchCost` basically never throws for that case anymore. A thrown
// Error here means something else broke (this backend unreachable), in
// which case this simply keeps showing whatever `stats` it already has
// rather than blanking the widget.
const POLL_INTERVAL_MS = 30 * 60_000;

export function CostSummaryCard() {
  const [stats, setStats] = useState<CostStats | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetchCost()
        .then((result) => {
          if (cancelled) return;
          setStats(result);
          setNotConfigured(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof CostSourceNotConfiguredError) setNotConfigured(true);
        });
    };
    poll();
    const interval = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  // Hooks called unconditionally, ABOVE the notConfigured/loading early
  // returns below (falling back to 0 with no `stats` yet) — count-up must
  // stay a stable hook call across every render of this component.
  const week = stats?.windows.week;
  const cost = useCountUp(week?.total_cost ?? 0);
  const tokens = useCountUp(week?.total_tokens ?? 0);
  const runs = useCountUp(week?.run_count ?? 0);

  if (notConfigured) {
    return <p className="text-xs text-muted-foreground">Cost data unavailable.</p>;
  }
  if (!stats || !week) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }

  const rateLimited = stats.rate_limited;
  const noData = week.no_data;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        {/* Live indicator: breathing while fresh, static/dim once this
            window has fallen back to a stale, cached read — same "live"
            convention StatusPill.tsx already uses for an in-flight turn. */}
        <span
          aria-hidden
          className={
            week.stale
              ? "size-1.5 rounded-full bg-muted-foreground/50"
              : "size-1.5 animate-pulse rounded-full bg-operator"
          }
        />
        <p className="font-mono text-xl font-semibold text-foreground">
          {noData ? "—" : currencyFormatter.format(cost)}
        </p>
        {!noData && <CostTrace />}
      </div>
      <p className="font-mono text-[11px] text-muted-foreground">
        {noData
          ? "No data recorded yet"
          : `${Math.round(tokens).toLocaleString()} tokens · ${Math.round(runs).toLocaleString()} runs`}
      </p>
      {rateLimited?.reset_at ? (
        <div className="flex flex-col gap-0.5">
          <p className="text-[11px] text-muted-foreground">Langfuse rate-limited, resets in</p>
          <RateLimitCountdown resetAt={rateLimited.reset_at} />
        </div>
      ) : (
        week.stale &&
        week.read_at && (
          <p className="text-[11px] text-muted-foreground">
            Showing figures read {relativeTime(week.read_at)}.
          </p>
        )
      )}
    </div>
  );
}
