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
});
