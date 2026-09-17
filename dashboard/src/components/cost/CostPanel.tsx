import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { InstrumentCard } from "@/components/ui/instrument-card";
import { CostTrace } from "@/components/cost/CostTrace";
import { RateLimitCountdown } from "@/components/cost/RateLimitCountdown";
import { relativeTime } from "@/lib/relativeTime";
import { useCountUp } from "@/lib/useCountUp";
import {
  fetchCost,
  CostSourceNotConfiguredError,
  type CostStats,
  type CostWindow,
} from "@/lib/api";

// PLAN.md Phase 9 step 6, the last of the initial panel set — real
// aggregate token/cost data (server.py's /cost, backed by Langfuse as of
// the 2026-07-25 LangSmith swap), not a locally computed pricing estimate.
// CLAUDE.md's Cost section: flag spend, don't guess at it.
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
//
// Each window carries its OWN `stale`/`no_data`/`read_at` now (server.py's
// `/cost`, 2026-08-09): a live Langfuse failure never blanks a card, it
// falls back to that window's own last-known-good snapshot and says so —
// the user's own direct ask, after an earlier fix still just replaced the
// whole grid with a bare error banner. `no_data` (never once successfully
// read) shows an em dash rather than a misleading "$0.00".
//
// `index` drives two staggers, mirroring NavRail's own boot stagger
// convention: the card's `.reveal` entrance (InstrumentCard's
// `revealDelayMs`) fires first, the decorative CostTrace draw-on follows
// ~200ms behind it so the line visibly traces in AFTER the card has
// already landed, not simultaneously with it.
function WindowCard({ label, stats, index }: { label: string; stats: CostWindow; index: number }) {
  const cost = useCountUp(stats.total_cost);
  const tokens = useCountUp(stats.total_tokens);
  const runs = useCountUp(stats.run_count);
  const promptTokens = useCountUp(stats.prompt_tokens);
  const completionTokens = useCountUp(stats.completion_tokens);
  const revealDelayMs = index * 90;
  const noData = stats.no_data;
  return (
    <InstrumentCard className="p-3" reveal revealDelayMs={revealDelayMs}>
      <div className="mb-1.5 flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
        <span
          aria-hidden
          className={
            stats.stale
              ? "size-1.5 rounded-full bg-muted-foreground/50"
              : "size-1.5 animate-pulse rounded-full bg-operator"
          }
        />
        {label}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline gap-2">
          <p className="font-mono text-2xl font-semibold text-foreground">
            {noData ? "—" : currencyFormatter.format(cost)}
          </p>
          {!noData && <CostTrace delayMs={revealDelayMs + 200} />}
        </div>
        {noData ? (
          <p className="font-mono text-sm text-muted-foreground">No data recorded yet.</p>
        ) : (
          <>
            <p className="font-mono text-sm tabular-nums text-muted-foreground">
              {Math.round(tokens).toLocaleString()} tokens · {Math.round(runs).toLocaleString()}{" "}
              runs
            </p>
            <p className="font-mono text-xs tabular-nums text-muted-foreground">
              {Math.round(promptTokens).toLocaleString()} prompt /{" "}
              {Math.round(completionTokens).toLocaleString()} completion
            </p>
          </>
        )}
        {stats.stale && stats.read_at && (
          <p className="text-[11px] text-muted-foreground">Read {relativeTime(stats.read_at)}.</p>
        )}
      </div>
    </InstrumentCard>
  );
}

export function CostPanel() {
  const [stats, setStats] = useState<CostStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  // A thrown Error (as opposed to a normal 200 response, even a degraded
  // one) means something else broke — this backend unreachable, a real
  // 500 — not a Langfuse rate limit, which server.py's `/cost` now
  // absorbs itself (see that endpoint's own docstring). Kept separate
  // from `stats` so a failed Refresh doesn't blank whatever grid is
  // already showing.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    setNotConfigured(false);
    fetchCost()
      .then(setStats)
      .catch((err: unknown) => {
        if (err instanceof CostSourceNotConfiguredError) {
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

  const rateLimited = stats?.rate_limited ?? null;

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Langfuse&apos;s own aggregate (its token counts × its maintained model price list) — not a
          locally computed guess, but also not a literal Anthropic invoice pull. Swapped off
          LangSmith on 2026-07-25 after LangSmith&apos;s own account-level trace-ingestion quota
          silently stopped accepting new traces; Langfuse is a separate pipeline unaffected by that.
          A window reading $0 with 0 runs means Langfuse has recorded nothing in that window, not
          necessarily that nothing ran (PLAN.md Phase 19/22).
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {notConfigured && (
        <p className="text-sm text-muted-foreground">
          Langfuse isn&apos;t configured (missing or invalid LANGFUSE_PUBLIC_KEY/
          LANGFUSE_SECRET_KEY) — cost tracking is unavailable until it is.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {rateLimited && (
        <div className="flex flex-wrap items-baseline gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          <span className="text-sm text-destructive">
            Langfuse rate-limited{rateLimited.message ? ` (${rateLimited.message})` : ""} — showing
            the last recorded figures below.
          </span>
          {rateLimited.reset_at && (
            <span className="flex items-baseline gap-1.5 text-sm text-muted-foreground">
              Resets in <RateLimitCountdown resetAt={rateLimited.reset_at} onExpire={load} />
            </span>
          )}
        </div>
      )}
      {stats && !notConfigured && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(Object.keys(WINDOW_LABELS) as (keyof CostStats["windows"])[]).map((key, index) => (
            <WindowCard
              key={key}
              label={WINDOW_LABELS[key]}
              stats={stats.windows[key]}
              index={index}
            />
          ))}
        </div>
      )}
    </div>
  );
}
