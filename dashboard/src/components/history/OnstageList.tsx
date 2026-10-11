import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { InstrumentCard } from "@/components/ui/instrument-card";
import { fetchOnstageJournal, type OnstageEntry } from "@/lib/api";
import { Disclosure } from "./Disclosure";
import { HistoryErrorNotice } from "./HistoryErrorNotice";
import { JsonBlock } from "./JsonBlock";
import { RenderBoundary } from "./RenderBoundary";
import { toError } from "./errors";
import { formatDuration, formatTimestamp, formatUsd } from "./format";

const LIMIT = 50;

function OnstageEntryCard({ entry }: { entry: OnstageEntry }) {
  const steps = entry.steps ?? [];
  const where = [entry.app, entry.window].filter(Boolean).join(" · ");
  const cost = formatUsd(entry.usd);
  // The small facts about how it was answered, in the order they happened:
  // the screen capture, the model, the controls it saw, the answer's cost.
  const facts = [
    entry.model,
    typeof entry.controls === "number" ? `${entry.controls} controls seen` : null,
    typeof entry.captureMs === "number" ? `capture ${formatDuration(entry.captureMs)}` : null,
    typeof entry.ms === "number" ? `answer ${formatDuration(entry.ms)}` : null,
    cost,
  ].filter((fact): fact is string => Boolean(fact));

  return (
    <InstrumentCard
      className="p-3"
      eyebrow={<span title={entry.t}>{formatTimestamp(entry.t)}</span>}
      data-testid="onstage-entry"
    >
      <div className="flex flex-col gap-2">
        <p className="whitespace-pre-wrap break-words text-sm font-medium">{entry.question}</p>
        {where && <p className="break-words font-mono text-xs text-muted-foreground">{where}</p>}
        {steps.length > 0 && (
          <ol className="flex flex-col gap-1.5">
            {steps.map((step, index) => (
              <li key={index} className="flex gap-2 text-sm" data-testid="onstage-step">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {`${index + 1}.`}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{step.say}</span>
                {typeof step.shapes === "number" && step.shapes > 0 && (
                  <Chip className="shrink-0 self-start">{`${step.shapes} drawn`}</Chip>
                )}
              </li>
            ))}
          </ol>
        )}
        {facts.length > 0 && (
          <p className="font-mono text-[0.7rem] text-muted-foreground">{facts.join(" · ")}</p>
        )}
        <Disclosure label="raw">
          <JsonBlock value={entry} copyLabel="raw onstage entry" />
        </Disclosure>
      </div>
    </InstrumentCard>
  );
}

// The History panel's Onstage tab: each question Stage's explain mode was
// asked and what it said back, newest first — read straight from Stage's
// explain journal. The steps are the spoken text, in order.
export function OnstageList() {
  const [entries, setEntries] = useState<OnstageEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchOnstageJournal(LIMIT)
      .then(setEntries)
      .catch((err: unknown) => setError(toError(err)))
      .finally(() => {
        setLoading(false);
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Questions asked of Onstage (Stage&apos;s explain-my-screen mode) and what it said back,
          newest first.
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="shrink-0">
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <HistoryErrorNotice error={error} />
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border p-4">
        {!loaded && <p className="text-sm text-muted-foreground">Loading Onstage journal…</p>}
        {loaded && entries.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">No Onstage questions yet.</p>
        )}
        <div className="flex flex-col gap-3">
          {entries.map((entry, index) => (
            <RenderBoundary key={`${entry.t}-${index}`} what="this Onstage entry">
              <OnstageEntryCard entry={entry} />
            </RenderBoundary>
          ))}
        </div>
      </div>
    </div>
  );
}
