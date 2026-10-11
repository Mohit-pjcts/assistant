import { HistoryForbiddenError } from "@/lib/api";

// One place for how every History tab says "that failed". The 403 case is
// special: the backend only serves these endpoints to the Mac it runs on, so
// opening the dashboard from the phone lands here — an explainable state,
// not an error to be shown in alarm red.
export function HistoryErrorNotice({ error }: { error: Error | null }) {
  if (!error) return null;
  if (error instanceof HistoryForbiddenError) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="history-forbidden">
        History is only available on this Mac. It holds full tool output and Stage screen contents,
        so the backend doesn&apos;t serve it to other devices.
      </p>
    );
  }
  return <p className="text-sm text-destructive">{error.message}</p>;
}
