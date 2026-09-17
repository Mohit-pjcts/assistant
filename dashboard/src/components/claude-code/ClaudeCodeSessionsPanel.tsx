import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  fetchClaudeCodeSessions,
  fetchClaudeCodeSession,
  stopClaudeCodeSession,
  type ClaudeCodeSessionSummary,
  type ClaudeCodeSessionDetail,
  type ClaudeCodeSessionBlock,
} from "@/lib/api";

// Same 4s cadence as the session-list poll below — while a session is
// still live, its detail view (once expanded) needs to keep refreshing
// too, not fetch once and freeze; the .jsonl transcript is confirmed to
// grow incrementally while the real process is still running (STEPS.md
// 149), so a frozen view would silently stop showing real progress.
const DETAIL_POLL_MS = 4000;

// run_claude_code (assistant/claude_code_tool.py, 2026-08-06) delegates
// coding_agent's real work to a separate, nested Claude Code session —
// but that session is tagged entrypoint="sdk-cli" internally, which makes
// Claude Code's own interactive session browser filter it out entirely.
// This panel is the only place these sessions are visible at all. Polls
// GET /claude-code-sessions on the same un-aggressive 4s cadence as
// useActiveTurns (api.ts) — a new session can land at any time from a
// turn this browser tab didn't start, so auto-update (not a manual
// Refresh button, not SSE) is the point.
const POLL_MS = 4000;

function formatTimestamp(ts: string | null): string {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString();
}

function BlockView({ block }: { block: ClaudeCodeSessionBlock }) {
  if (block.type === "text") {
    return (
      <p className="whitespace-pre-wrap rounded-md border bg-muted p-2 text-xs">{block.text}</p>
    );
  }
  if (block.type === "tool_use") {
    return (
      <div className="rounded-md border bg-muted p-2 text-xs" data-testid="claude-code-tool-use">
        <p className="font-medium">Tool: {block.name}</p>
        <pre className="mt-1 whitespace-pre-wrap font-mono">
          {JSON.stringify(block.input, null, 2)}
        </pre>
      </div>
    );
  }
  return (
    <div
      className={
        "rounded-md border p-2 text-xs font-mono whitespace-pre-wrap " +
        (block.is_error ? "border-destructive bg-destructive/10" : "bg-muted")
      }
      data-testid="claude-code-tool-result"
    >
      {typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2)}
    </div>
  );
}

function SessionDetailView({ detail }: { detail: ClaudeCodeSessionDetail }) {
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="claude-code-session-detail">
      {detail.turns.map((turn, i) => (
        <div key={i} className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">{turn.role}</p>
          {turn.blocks.map((block, j) => (
            <BlockView key={j} block={block} />
          ))}
        </div>
      ))}
    </div>
  );
}

function SessionRow({ session }: { session: ClaudeCodeSessionSummary }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ClaudeCodeSessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  function handleStop(e: React.MouseEvent) {
    e.stopPropagation();
    setStopping(true);
    stopClaudeCodeSession(session.session_id).catch(() => {
      // Best-effort — the next list poll will just keep showing it as
      // live if this failed, and the button re-enables via `stopping`
      // resetting on the next render once is_live flips.
    });
  }

  useEffect(() => {
    if (!expanded) return;
    setLoading(!detail);
    setError(null);

    function poll() {
      fetchClaudeCodeSession(session.session_id)
        .then(setDetail)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setLoading(false));
    }

    poll();
    // Only keep re-polling the DETAIL view while the session is still
    // live — once it's finished, the transcript can't change anymore, so
    // there's nothing to gain from refetching it repeatedly.
    if (!session.is_live) return;
    const interval = setInterval(poll, DETAIL_POLL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, session.session_id, session.is_live]);

  return (
    <Card size="sm" data-testid="claude-code-session-row">
      <CardContent>
        {/* A real nested <button> inside this row's own toggle <button>
            would be invalid HTML (browsers/jsdom handle nested buttons
            unpredictably) — the Stop button is a SIBLING positioned over
            the same row via flex layout, not a descendant of the toggle. */}
        <div className="flex w-full items-center justify-between gap-2">
          <button
            type="button"
            onClick={toggle}
            className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{session.title}</p>
              <p className="truncate text-xs text-muted-foreground">{session.prompt_preview}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {session.is_live && (
                <Badge variant="default" data-testid="claude-code-session-live-badge">
                  <span
                    aria-hidden
                    className="mr-1 inline-block size-1.5 animate-pulse rounded-full bg-current"
                  />
                  Live
                </Badge>
              )}
              <Badge variant="secondary">{session.event_count} events</Badge>
              <span className="text-xs text-muted-foreground">
                {formatTimestamp(session.started_at)}
              </span>
            </div>
          </button>
          {session.is_live && (
            <button
              type="button"
              onClick={handleStop}
              disabled={stopping}
              className="shrink-0 rounded border border-destructive/40 px-2 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
        </div>
        {expanded && (
          <>
            {loading && <p className="mt-2 text-xs text-muted-foreground">Loading…</p>}
            {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
            {detail && <SessionDetailView detail={detail} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function ClaudeCodeSessionsPanel() {
  const [sessions, setSessions] = useState<ClaudeCodeSessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    function poll() {
      fetchClaudeCodeSessions()
        .then((result) => {
          if (!cancelled) {
            setSessions(result);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="flex h-full flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Nested Claude Code sessions run_claude_code delegated coding_agent's real work to — these
        never appear in Claude Code's own interactive session browser (they're tagged as
        non-interactive), so this is the only place to see them. Updates automatically.
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <ScrollArea className="min-h-0 flex-1 rounded-md border p-4">
        <div className="flex flex-col gap-3">
          {sessions.length === 0 && !error && (
            <p className="text-sm text-muted-foreground">No Claude Code sessions yet.</p>
          )}
          {sessions.map((session) => (
            <SessionRow key={session.session_id} session={session} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
