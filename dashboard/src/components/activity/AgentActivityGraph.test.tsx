import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { AgentActivityGraph } from "./AgentActivityGraph";

// PLAN.md Phase 28 step 4 — this component never had a dedicated unit
// test file before (only exercised indirectly via
// test_activity_frames_surface_across_the_delegated_specialist_boundary-
// style integration tests at the SSE/supervisor level). These focus on
// what the physics upgrade actually needs to get right: the real
// activeAgent/activeTool prop is what drives highlighting and
// dispatch/response particles — never a timer, never simulated — plus
// hover-to-highlight. The organic-drift rAF loop itself is a visual
// polish detail, not asserted pixel-exact here; reduced-motion mode
// (which skips it entirely, along with particles/pings) is what's
// actually tested for correctness.

function mockReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  mockReducedMotion(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AgentActivityGraph", () => {
  it("renders the supervisor and all five specialists", () => {
    render(<AgentActivityGraph activeAgent={null} activeTool={null} />);
    expect(screen.getByText("supervisor")).toBeInTheDocument();
    for (const label of ["coding", "research", "life_admin", "mac_control", "phone"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("highlights the active specialist's spoke", () => {
    render(<AgentActivityGraph activeAgent="research_agent" activeTool={null} />);
    expect(screen.getByTestId("spoke-research_agent")).toHaveAttribute("data-highlighted", "true");
    expect(screen.getByTestId("spoke-coding_agent")).toHaveAttribute("data-highlighted", "false");
  });

  it("spawns a dispatch particle when a specialist becomes active, and a response particle when it stops", () => {
    const { rerender } = render(<AgentActivityGraph activeAgent={null} activeTool={null} />);
    expect(screen.queryByTestId("particle-dispatch")).not.toBeInTheDocument();

    rerender(<AgentActivityGraph activeAgent="coding_agent" activeTool={null} />);
    expect(screen.getByTestId("particle-dispatch")).toBeInTheDocument();
    expect(screen.getByTestId("supervisor-ping")).toBeInTheDocument();

    rerender(<AgentActivityGraph activeAgent={null} activeTool={null} />);
    expect(screen.getByTestId("particle-response")).toBeInTheDocument();
  });

  // Not tested here: a particle removing itself on its CSS animation's
  // `animationend`. Confirmed directly (not just assumed) that this
  // jsdom environment has no `window.AnimationEvent` at all, which is
  // what React's onAnimationEnd delegation itself feature-detects on —
  // no way to construct an event here that would actually reach the
  // handler, in this environment or any other lacking that constructor.
  // The mechanism (a plain onAnimationEnd callback filtering component
  // state) is standard and low-risk; the real thing worth testing —
  // that a particle actually APPEARS tied to a real prop transition, not
  // a timer — is covered above.

  it("reveals the active tool name, scrambling through intermediate frames before settling", () => {
    vi.useFakeTimers();
    const { rerender } = render(<AgentActivityGraph activeAgent={null} activeTool={null} />);
    rerender(<AgentActivityGraph activeAgent="coding_agent" activeTool="write_file" />);

    act(() => {
      vi.advanceTimersByTime(26 * 10 + 5);
    });

    expect(screen.getByText("write_file")).toBeInTheDocument();
  });

  it("truncates a long tool name before scrambling it in", () => {
    vi.useFakeTimers();
    const { rerender } = render(<AgentActivityGraph activeAgent={null} activeTool={null} />);
    rerender(
      <AgentActivityGraph
        activeAgent="mac_control_agent"
        activeTool="an_extremely_long_tool_name_here"
      />,
    );

    act(() => {
      vi.advanceTimersByTime(26 * 10 + 5);
    });

    expect(screen.getByText("an_extremely_lo…")).toBeInTheDocument();
  });

  it("hovering a specialist node highlights its spoke", () => {
    render(<AgentActivityGraph activeAgent={null} activeTool={null} />);
    const node = screen.getByTestId("node-research_agent");

    fireEvent.mouseEnter(node);
    expect(screen.getByTestId("spoke-research_agent")).toHaveAttribute("data-highlighted", "true");

    fireEvent.mouseLeave(node);
    expect(screen.getByTestId("spoke-research_agent")).toHaveAttribute("data-highlighted", "false");
  });

  it("hovering the supervisor highlights every spoke", () => {
    render(<AgentActivityGraph activeAgent={null} activeTool={null} />);
    const supervisorHit = screen.getByTestId("supervisor-hit");

    fireEvent.mouseEnter(supervisorHit.parentElement as Element);

    for (const id of [
      "coding_agent",
      "research_agent",
      "life_admin_agent",
      "mac_control_agent",
      "phone_agent",
    ]) {
      expect(screen.getByTestId(`spoke-${id}`)).toHaveAttribute("data-highlighted", "true");
    }
  });

  it("respects prefers-reduced-motion: shows the final tool name immediately and never spawns particles", () => {
    mockReducedMotion(true);
    const { rerender } = render(<AgentActivityGraph activeAgent={null} activeTool={null} />);

    rerender(<AgentActivityGraph activeAgent="coding_agent" activeTool="write_file" />);

    expect(screen.getByText("write_file")).toBeInTheDocument();
    expect(screen.queryByTestId("particle-dispatch")).not.toBeInTheDocument();
    expect(screen.queryByTestId("supervisor-ping")).not.toBeInTheDocument();
  });
});
