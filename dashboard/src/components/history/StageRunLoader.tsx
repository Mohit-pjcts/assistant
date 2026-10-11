import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchStageRun, type StageRunDetail } from "@/lib/api";
import { HistoryErrorNotice } from "./HistoryErrorNotice";
import { RenderBoundary } from "./RenderBoundary";
import { StageRunView } from "./StageRunView";
import { toError } from "./errors";

// Fetches one Stage run's full log when it mounts and shows it. Mounted only
// once a row has been expanded (the Stage tab's rows, a Backstage call in
// the Conversation tab), so a run's log — which can be megabytes of screen
// contents — is never pulled until someone asks to look at it.
export function StageRunLoader({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<StageRunDetail | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchStageRun(runId)
      .then(setDetail)
      .catch((err: unknown) => setError(toError(err)))
      .finally(() => setLoading(false));
  }, [runId]);

  useEffect(() => {
    load();
  }, [load]);

  // A run that hasn't written its end line may still be going; reloading is
  // how you see what it has logged since. A failed load gets the same button.
  const canReload = error !== null || detail?.summary.status === "unfinished";

  return (
    <div className="flex flex-col gap-2" data-testid="stage-run-loader">
      {loading && <p className="text-xs text-muted-foreground">Loading Stage run…</p>}
      <HistoryErrorNotice error={error} />
      {canReload && (
        <Button
          variant="outline"
          size="xs"
          className="self-start"
          onClick={load}
          disabled={loading}
        >
          Reload run
        </Button>
      )}
      {detail && (
        <RenderBoundary what="this Stage run">
          <StageRunView detail={detail} />
        </RenderBoundary>
      )}
    </div>
  );
}
