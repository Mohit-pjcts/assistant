import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { InstrumentCard } from "@/components/ui/instrument-card";
import { fetchStageRuns, type StageRunSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { HistoryErrorNotice } from "./HistoryErrorNotice";
import { RenderBoundary } from "./RenderBoundary";
import { SourceBadge } from "./StageRunView";
import { StageRunLoader } from "./StageRunLoader";
import { toError } from "./errors";
import { TONE_CLASSES, formatSeconds, formatTimestamp, formatUsd } from "./format";
import { runCostUsd, runOutcome, runSeconds, runTally } from "./stageSummary";

const PAGE_SIZE = 50;

// One run: a card-shaped summary line you click to open the whole run. The
// card is only the header — the opened run sits below it, outside the card,
// because InstrumentCard tilts under the pointer and a run's full log is
// far too tall to have swaying while you read it.
function StageRunRow({ run }: { run: StageRunSummary }) {
  const [open, setOpen] = useState(false);
  const outcome = runOutcome(run);
  const tally = runTally(run);
  const seconds = formatSeconds(runSeconds(run));
  const cost = formatUsd(runCostUsd(run));

  return (
    <div className="flex flex-col gap-2">
      <InstrumentCard className="p-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 p-3 text-left"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          {/* Literal spaces between the parts: for the button's accessible
              name only (flex `gap` does the visual spacing) — see
              ToolCallRow's header for the same thing. */}
          <span
            className="shrink-0 font-mono text-[0.7rem] text-muted-foreground"
            title={run.started_at ?? undefined}
          >
            {formatTimestamp(run.started_at) || "unknown time"}
          </span>{" "}
          <SourceBadge source={run.source} />{" "}
          <span className="min-w-0 flex-1 basis-48 truncate text-sm">{run.command}</span>{" "}
          <Chip className={TONE_CLASSES[outcome.tone]}>{outcome.label}</Chip>{" "}
          <span className="shrink-0 font-mono text-[0.7rem] text-muted-foreground">
            {`${tally.done}/${tally.total} tasks`}
          </span>{" "}
          {seconds && (
            <>
              <span className="shrink-0 font-mono text-[0.7rem] text-muted-foreground">
                {seconds}
              </span>{" "}
            </>
          )}
          {cost && (
            <span className="shrink-0 font-mono text-[0.7rem] text-muted-foreground">{cost}</span>
          )}
        </button>
      </InstrumentCard>
      {open && (
        <div className="ml-3 border-l border-graphite/30 pl-3">
          <StageRunLoader runId={run.run_id} />
        </div>
      )}
    </div>
  );
}

// The History panel's Stage tab: every Stage run, newest first — the ones
// started with the hotkey or from Stage's own panel as well as the ones Oni
// started ("api"), since Stage logs them all to the same place and a run you
// kicked off yourself is just as much part of "what happened" as one Oni did.
export function StageRunsList() {
  const [runs, setRuns] = useState<StageRunSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchStageRuns({ limit: PAGE_SIZE })
      .then((page) => {
        setRuns(page.runs);
        setNext(page.next);
      })
      .catch((err: unknown) => setError(toError(err)))
      .finally(() => {
        setLoading(false);
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function loadMore() {
    if (!next) return;
    setLoadingMore(true);
    setError(null);
    fetchStageRuns({ limit: PAGE_SIZE, before: next })
      .then((page) => {
        // A run that started between the two requests can shift the page
        // boundary; drop anything already on screen rather than show it twice.
        setRuns((prev) => {
          const known = new Set(prev.map((run) => run.run_id));
          return [...prev, ...page.runs.filter((run) => !known.has(run.run_id))];
        });
        setNext(page.next);
      })
      .catch((err: unknown) => setError(toError(err)))
      .finally(() => setLoadingMore(false));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Every Stage run, newest first — started by the hotkey, Stage&apos;s own panel, or Oni
          (&ldquo;api&rdquo;). Click a run for its tasks, every step and every helper call.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={load}
          disabled={loading || loadingMore}
          className="shrink-0"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <HistoryErrorNotice error={error} />
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border p-4">
        {!loaded && <p className="text-sm text-muted-foreground">Loading Stage runs…</p>}
        {loaded && runs.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">No Stage runs yet.</p>
        )}
        <ul className="flex flex-col gap-3">
          {runs.map((run) => (
            <li key={run.run_id} data-testid="stage-run-row">
              <RenderBoundary what="this Stage run">
                <StageRunRow run={run} />
              </RenderBoundary>
            </li>
          ))}
        </ul>
        {next && (
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={loadMore}
            disabled={loading || loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>
    </div>
  );
}
