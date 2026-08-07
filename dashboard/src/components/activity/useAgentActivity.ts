import { useCallback, useRef, useState } from "react";
import type { AgentActivityEvent } from "@/lib/api";

export interface TimelineEntry {
  id: string;
  agent: string;
  tool: string;
  status: "running" | "done";
  startedAt: number;
}

const MAX_TIMELINE_ENTRIES = 20;

// PLAN.md Phase 19: turns the raw tool_start/tool_end stream (server.py's
// `activity` SSE frame — both the supervisor->specialist boundary and a
// specialist's own inner tool calls, see supervisor.py's
// _AgentActivityRelay/call_specialist) into what the right rail needs: (1)
// the single MOST SPECIFIC thing currently running, for the activity
// graph's highlighted node and the header status pill, and (2) a capped
// recent-history list for the tool-call timeline.
//
// `inFlight` is a stack, not a set — the deepest (most recently pushed,
// not yet closed) entry is always the most specific thing happening right
// now: while only the outer supervisor->research_agent boundary is open,
// research_agent is "active" with no specific tool yet named; once its own
// inner tool_start arrives, THAT becomes the deepest entry instead, and
// popping back off it (tool_end) reveals the outer one again underneath.
export function useAgentActivity() {
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const inFlightRef = useRef<AgentActivityEvent[]>([]);

  const recompute = useCallback(() => {
    const deepest = inFlightRef.current[inFlightRef.current.length - 1] ?? null;
    if (!deepest) {
      setActiveAgent(null);
      setActiveTool(null);
      return;
    }
    // The outer supervisor->specialist boundary names the specialist in
    // its OWN `tool` field (call_specialist's dispatch is `agent:
    // "supervisor", tool: <specialist name>`) — surface that specialist as
    // the active agent with no specific tool yet, rather than literally
    // showing "supervisor" as active, which would be true but far less
    // useful for the graph/pill.
    if (deepest.agent === "supervisor") {
      setActiveAgent(deepest.tool);
      setActiveTool(null);
    } else {
      setActiveAgent(deepest.agent);
      setActiveTool(deepest.tool);
    }
  }, []);

  const handleActivity = useCallback(
    (event: AgentActivityEvent) => {
      if (event.phase === "tool_start") {
        inFlightRef.current = [...inFlightRef.current, event];
        setTimeline((prev) =>
          [
            {
              id: `${event.agent}:${event.tool}:${Date.now()}:${prev.length}`,
              agent: event.agent,
              tool: event.tool,
              status: "running" as const,
              startedAt: Date.now(),
            },
            ...prev,
          ].slice(0, MAX_TIMELINE_ENTRIES),
        );
      } else {
        const idx = inFlightRef.current.findIndex(
          (e) => e.agent === event.agent && e.tool === event.tool,
        );
        if (idx !== -1) {
          inFlightRef.current = [
            ...inFlightRef.current.slice(0, idx),
            ...inFlightRef.current.slice(idx + 1),
          ];
        }
        setTimeline((prev) => {
          const runningIdx = prev.findIndex(
            (e) => e.agent === event.agent && e.tool === event.tool && e.status === "running",
          );
          if (runningIdx === -1) return prev;
          const next = [...prev];
          next[runningIdx] = { ...next[runningIdx], status: "done" };
          return next;
        });
      }
      recompute();
    },
    [recompute],
  );

  // A turn can end WITHOUT a matching tool_end for everything still on the
  // stack: the SSE connection can die mid-tool-call (a backend process
  // restart — e.g. uvicorn --reload picking up an edited file — or a
  // network drop) with no chance to emit the closing frame, and a
  // user-requested stop deliberately cuts the stream the same way. Either
  // way, whatever ChatPanel was showing as "running" is no longer true, but
  // nothing in the event stream itself says so. ChatPanel's own
  // handleStreamError calls this once the sendChat/resumeChat promise
  // settles abnormally, so the graph/pill/timeline never get stuck showing
  // a tool call that quietly stopped existing minutes ago (the real,
  // live-observed bug this closes: a stale "coding_agent" staying
  // highlighted long after its turn had already ended).
  const resetActivity = useCallback(() => {
    inFlightRef.current = [];
    setActiveAgent(null);
    setActiveTool(null);
    setTimeline((prev) => prev.map((e) => (e.status === "running" ? { ...e, status: "done" } : e)));
  }, []);

  return { activeAgent, activeTool, timeline, handleActivity, resetActivity };
}
