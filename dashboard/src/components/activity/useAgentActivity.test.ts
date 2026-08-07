import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAgentActivity } from "./useAgentActivity";

// PLAN.md Phase 19: the hook is what turns server.py's raw activity SSE
// frames (supervisor.py's _AgentActivityRelay/call_specialist, both
// dispatched with the same shape) into what the right rail needs — these
// tests exercise the stack-based "deepest in-flight entry is the most
// specific thing running" logic directly, without needing a real SSE
// stream or ChatPanel.
describe("useAgentActivity", () => {
  it("starts idle with no timeline entries", () => {
    const { result } = renderHook(() => useAgentActivity());
    expect(result.current.activeAgent).toBeNull();
    expect(result.current.activeTool).toBeNull();
    expect(result.current.timeline).toEqual([]);
  });

  it("surfaces the outer supervisor->specialist boundary as the active agent with no tool yet", () => {
    const { result } = renderHook(() => useAgentActivity());
    act(() => {
      result.current.handleActivity({
        phase: "tool_start",
        agent: "supervisor",
        tool: "research_agent",
      });
    });
    expect(result.current.activeAgent).toBe("research_agent");
    expect(result.current.activeTool).toBeNull();
  });

  it("surfaces a specialist's own inner tool as the deepest/most specific active thing", () => {
    const { result } = renderHook(() => useAgentActivity());
    act(() => {
      result.current.handleActivity({
        phase: "tool_start",
        agent: "supervisor",
        tool: "research_agent",
      });
      result.current.handleActivity({
        phase: "tool_start",
        agent: "research_agent",
        tool: "tavily_search",
      });
    });
    expect(result.current.activeAgent).toBe("research_agent");
    expect(result.current.activeTool).toBe("tavily_search");
  });

  it("reveals the outer boundary again once the inner tool closes, then goes idle once the outer closes", () => {
    const { result } = renderHook(() => useAgentActivity());
    act(() => {
      result.current.handleActivity({
        phase: "tool_start",
        agent: "supervisor",
        tool: "research_agent",
      });
      result.current.handleActivity({
        phase: "tool_start",
        agent: "research_agent",
        tool: "tavily_search",
      });
      result.current.handleActivity({
        phase: "tool_end",
        agent: "research_agent",
        tool: "tavily_search",
      });
    });
    expect(result.current.activeAgent).toBe("research_agent");
    expect(result.current.activeTool).toBeNull();

    act(() => {
      result.current.handleActivity({
        phase: "tool_end",
        agent: "supervisor",
        tool: "research_agent",
      });
    });
    expect(result.current.activeAgent).toBeNull();
    expect(result.current.activeTool).toBeNull();
  });

  it("accumulates a most-recent-first timeline and marks entries done on their matching tool_end", () => {
    const { result } = renderHook(() => useAgentActivity());
    act(() => {
      result.current.handleActivity({
        phase: "tool_start",
        agent: "supervisor",
        tool: "research_agent",
      });
      result.current.handleActivity({
        phase: "tool_start",
        agent: "research_agent",
        tool: "tavily_search",
      });
      result.current.handleActivity({
        phase: "tool_end",
        agent: "research_agent",
        tool: "tavily_search",
      });
    });
    expect(result.current.timeline).toHaveLength(2);
    // Most-recent-first: the inner tavily_search call was dispatched after
    // the outer research_agent one, so it's the first entry.
    expect(result.current.timeline[0]).toMatchObject({
      agent: "research_agent",
      tool: "tavily_search",
      status: "done",
    });
    expect(result.current.timeline[1]).toMatchObject({
      agent: "supervisor",
      tool: "research_agent",
      status: "running",
    });
  });

  // A real, live-observed bug (STEPS.md): a stream can die mid-tool-call
  // (backend restart, network drop, a user-requested stop) with no
  // matching tool_end ever arriving. Without resetActivity, activeAgent and
  // the timeline's "running" entry would stay stuck forever.
  it("resetActivity clears in-flight state and marks stuck-running entries done", () => {
    const { result } = renderHook(() => useAgentActivity());
    act(() => {
      result.current.handleActivity({
        phase: "tool_start",
        agent: "supervisor",
        tool: "coding_agent",
      });
      result.current.handleActivity({
        phase: "tool_start",
        agent: "coding_agent",
        tool: "execute_shell_command",
      });
    });
    expect(result.current.activeAgent).toBe("coding_agent");
    expect(result.current.activeTool).toBe("execute_shell_command");

    act(() => {
      result.current.resetActivity();
    });
    expect(result.current.activeAgent).toBeNull();
    expect(result.current.activeTool).toBeNull();
    expect(result.current.timeline.every((e) => e.status === "done")).toBe(true);

    // A subsequent tool_start after the reset behaves normally — the
    // cleared stack isn't left in some broken state.
    act(() => {
      result.current.handleActivity({
        phase: "tool_start",
        agent: "supervisor",
        tool: "research_agent",
      });
    });
    expect(result.current.activeAgent).toBe("research_agent");
  });
});
