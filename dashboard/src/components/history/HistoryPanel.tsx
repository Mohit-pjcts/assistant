import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchHistory, type HistoryMessage } from "@/lib/api";

// PLAN.md Phase 9 step 4 — the full-fidelity counterpart to the chat panel.
// ChatPanel deliberately HIDES tool/system messages, empty-content turns,
// and synthetic graph-inserted messages (STEPS.md 57/58) to keep the live
// chat readable; this panel shows ALL of it, labeled honestly, since that's
// exactly the transparency a "what did the assistant actually do" view is
// for. No fetch-on-a-timer / real-time sync — a manual refresh is enough
// for a view you open to inspect, not to watch live (that's the chat tab's
// job).
export function HistoryPanel() {
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchHistory()
      .then(setMessages)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Full graph state, including internal messages the chat view hides.
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <ScrollArea className="flex-1 rounded-md border p-4">
        <div className="flex flex-col gap-2">
          {messages.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">No messages yet.</p>
          )}
          {messages.map((message, index) => (
            <div key={index} className="rounded-md border p-2 text-sm" data-testid="history-row">
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <Badge variant={message.role === "user" ? "default" : "secondary"}>
                  {message.role}
                </Badge>
                {message.name && <Badge variant="outline">{message.name}</Badge>}
                {message.synthetic && (
                  <Badge variant="outline" className="text-muted-foreground">
                    internal
                  </Badge>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words">
                {message.content || <span className="italic text-muted-foreground">(empty)</span>}
              </p>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
