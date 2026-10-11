import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchHistoryTrace, type TraceTurn } from "@/lib/api";
import { cn } from "@/lib/utils";
import { HistoryErrorNotice } from "./HistoryErrorNotice";
import { TraceTimeline } from "./TraceTimeline";
import { toError } from "./errors";
import { filterTurns } from "./traceFilter";

// How many turns one request brings. The latest page loads first; "Load
// earlier turns" walks backwards a page at a time, because a long-lived
// thread's full trace (every tool output, in full) is far too much to pull
// in one go.
const PAGE_SIZE = 30;

// Where to put the scroll position once newly loaded turns have rendered.
// A fresh load lands on the newest turn (the end of the list, what you came
// to see); prepending older turns instead keeps the turn you were reading
// where it was — WebKit, which the Tauri window runs on, doesn't do scroll
// anchoring by itself, so without this the page would jump on every click.
type PendingScroll = { kind: "bottom" } | { kind: "keep"; height: number; top: number };

function sortTurns(turns: TraceTurn[]): TraceTurn[] {
  return [...turns].sort((a, b) => a.index - b.index);
}

function ToggleChip({
  pressed,
  onToggle,
  children,
}: {
  pressed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        pressed
          ? "border-accent-signal bg-accent-signal/10 text-accent-signal"
          : "border-graphite/40 text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// The History panel's Conversation tab: the active thread's full trace.
// STEPS.md 158 — unlike the old panel (which listed checkpointed messages),
// this shows every tool call with its arguments and output, and what each
// specialist did inside its delegation.
//
// `threadId` is optional on purpose: App.tsx remounts this panel per active
// thread, so leaving it out (the backend then answers for the active thread)
// is how it follows the sidebar. The id the backend resolved is remembered
// and used for "load earlier", so a thread switch in another window can't
// splice two threads' turns together mid-scroll.
export function ConversationTab({ threadId }: { threadId?: string }) {
  const [turns, setTurns] = useState<TraceTurn[]>([]);
  const [totalTurns, setTotalTurns] = useState(0);
  const [resolvedThreadId, setResolvedThreadId] = useState<string | undefined>(threadId);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // True once a "load earlier" came back with nothing new, so the button
  // goes away even if the backend's total says there should be more.
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [query, setQuery] = useState("");
  const [showThinking, setShowThinking] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<PendingScroll | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchHistoryTrace(threadId, { limit: PAGE_SIZE })
      .then((trace) => {
        pendingScroll.current = { kind: "bottom" };
        setTurns(sortTurns(trace.turns));
        setTotalTurns(trace.total_turns);
        setResolvedThreadId(trace.thread_id);
        setExhausted(false);
      })
      .catch((err: unknown) => setError(toError(err)))
      .finally(() => {
        setLoading(false);
        setLoaded(true);
      });
  }, [threadId]);

  useEffect(() => {
    load();
  }, [load]);

  // Runs after the new turns are in the DOM (layout effect, so there's no
  // frame where the list shows at the wrong scroll position).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const job = pendingScroll.current;
    pendingScroll.current = null;
    if (!el || !job) return;
    el.scrollTop = job.kind === "bottom" ? el.scrollHeight : el.scrollHeight - job.height + job.top;
  }, [turns]);

  function loadEarlier() {
    if (turns.length === 0) return;
    const el = scrollRef.current;
    setLoadingEarlier(true);
    setError(null);
    // Refresh and this button are each disabled while the other is running,
    // so `turns` here is still the list this response will be merged into.
    fetchHistoryTrace(resolvedThreadId, { limit: PAGE_SIZE, before: turns[0].index })
      .then((trace) => {
        const known = new Set(turns.map((turn) => turn.index));
        const fresh = trace.turns.filter((turn) => !known.has(turn.index));
        setExhausted(fresh.length === 0);
        setTotalTurns(trace.total_turns);
        if (el)
          pendingScroll.current = { kind: "keep", height: el.scrollHeight, top: el.scrollTop };
        setTurns(sortTurns([...fresh, ...turns]));
      })
      .catch((err: unknown) => setError(toError(err)))
      .finally(() => setLoadingEarlier(false));
  }

  // Deferred so typing stays instant while a long history re-filters.
  const deferredQuery = useDeferredValue(query);
  const filtering = deferredQuery.trim() !== "";
  const visibleTurns = useMemo(() => filterTurns(turns, deferredQuery), [turns, deferredQuery]);
  const hasEarlier = turns.length < totalTurns && !exhausted;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Every message, tool call and delegation in this conversation — including what each
        specialist did and said inside its delegation. Click a call to see its full input and
        output.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Filter conversation"
          placeholder="Filter by tool, input, output or text…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 w-full max-w-xs flex-1"
        />
        <ToggleChip pressed={showThinking} onToggle={() => setShowThinking((value) => !value)}>
          Show thinking
        </ToggleChip>
        <ToggleChip pressed={showContext} onToggle={() => setShowContext((value) => !value)}>
          Show context
        </ToggleChip>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={load}
          disabled={loading || loadingEarlier}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {loaded && turns.length > 0 && (
        <p className="font-mono text-[0.7rem] text-muted-foreground" data-testid="trace-summary">
          {`${turns.length} of ${totalTurns} turns loaded`}
          {filtering &&
            ` · ${visibleTurns.length} ${visibleTurns.length === 1 ? "turn matches" : "turns match"}${hasEarlier ? " (older turns are searched once loaded)" : ""}`}
        </p>
      )}
      <HistoryErrorNotice error={error} />
      {/* A plain scrolling div rather than ScrollArea: the scroll position
          has to be set from code (jump to the newest turn, hold place when
          older turns are prepended), which needs a real ref to the scroller.
          min-h-0 — see ChatPanel.tsx's comment on the same pattern. */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto rounded-md border p-4">
        {!loaded && <p className="text-sm text-muted-foreground">Loading conversation…</p>}
        {hasEarlier && (
          <Button
            variant="outline"
            size="sm"
            className="mb-5"
            onClick={loadEarlier}
            disabled={loading || loadingEarlier}
          >
            {loadingEarlier
              ? "Loading earlier turns…"
              : `Load earlier turns (${totalTurns - turns.length} more)`}
          </Button>
        )}
        {loaded && turns.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">No turns in this conversation yet.</p>
        )}
        {turns.length > 0 && visibleTurns.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {`No loaded turn matches “${deferredQuery.trim()}”.`}
          </p>
        )}
        <TraceTimeline turns={visibleTurns} showThinking={showThinking} showContext={showContext} />
      </div>
    </div>
  );
}
