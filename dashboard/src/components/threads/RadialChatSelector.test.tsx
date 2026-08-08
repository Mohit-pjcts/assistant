import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RadialChatSelector } from "./RadialChatSelector";
import type { Project, ThreadSummary } from "@/lib/api";

// PLAN.md Phase 28 step 5. Focuses on the synchronous interaction logic
// (click-to-select, drag-doesn't-select, keyboard activation, Escape/
// close, settings toggles, group isolation) — these run directly inside
// their own event handlers, not gated on the physics tick loop, so
// they're deterministically testable without waiting on
// requestAnimationFrame. The one test that DOES depend on the tick loop
// (positions actually moving over real time) uses a generous real-timer
// `waitFor` rather than asserting frame-exact behavior. NOT covered
// here, same category of gap as AgentActivityGraph.test.tsx's own
// documented one: per-node dimming from search/isolation is applied
// inside the same tick loop, not synchronously on input change, and
// isn't independently asserted — the underlying `isDimmed` logic is
// exercised indirectly (search/isolation state changes correctly, per
// the tests below), just not the exact DOM class it produces.

const PROJECTS: Project[] = [
  { id: "p1", name: "Coding", color: "#9b87f5", created_at: "x" },
  { id: "p2", name: "Research", color: "#7c6bc9", created_at: "x" },
];

const THREADS: ThreadSummary[] = [
  { id: "t1", title: "Fix the bug", created_at: "x", last_active_at: "x", project_id: "p1" },
  { id: "t2", title: "Read the paper", created_at: "x", last_active_at: "x", project_id: "p2" },
  { id: "t3", title: "Loose thread", created_at: "x", last_active_at: "x", project_id: null },
];

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

// Same confirmed Node/jsdom gap as theme.test.tsx's own fakeLocalStorage
// (no --localstorage-file flag => a non-functional native stub shadows
// jsdom's real implementation) — the settings-persistence code under
// test calls getItem/setItem/removeItem directly, same as theme.tsx.
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
}

beforeEach(() => {
  mockReducedMotion(false);
  vi.stubGlobal("localStorage", fakeLocalStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSelector(overrides: Partial<Parameters<typeof RadialChatSelector>[0]> = {}) {
  const onSelectThread = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <RadialChatSelector
      projects={PROJECTS}
      threads={THREADS}
      activeThreadId="t1"
      onSelectThread={onSelectThread}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onSelectThread, onClose, ...utils };
}

describe("RadialChatSelector", () => {
  it("renders the hub, every project, and every thread (including ungrouped) as nodes", () => {
    renderSelector();
    expect(screen.getByTestId("radial-node-hub")).toBeInTheDocument();
    expect(screen.getByTestId("radial-node-p1")).toBeInTheDocument();
    expect(screen.getByTestId("radial-node-p2")).toBeInTheDocument();
    expect(screen.getByTestId("radial-node-t1")).toBeInTheDocument();
    expect(screen.getByTestId("radial-node-t2")).toBeInTheDocument();
    expect(screen.getByTestId("radial-node-t3")).toBeInTheDocument();
  });

  it("clicking a chat node (no drag) selects it and closes after a short delay", () => {
    vi.useFakeTimers();
    const { onSelectThread, onClose } = renderSelector();
    const node = screen.getByTestId("radial-node-t2");

    fireEvent.pointerDown(node, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(node, { pointerId: 1, clientX: 100, clientY: 100 });

    expect(onSelectThread).toHaveBeenCalledWith("t2");
    expect(onClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onClose).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("dragging a node past the movement threshold does not select it", () => {
    const { onSelectThread } = renderSelector();
    const node = screen.getByTestId("radial-node-t2");

    fireEvent.pointerDown(node, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(node, { pointerId: 1, clientX: 140, clientY: 140 });
    fireEvent.pointerUp(node, { pointerId: 1, clientX: 140, clientY: 140 });

    expect(onSelectThread).not.toHaveBeenCalled();
  });

  it("activates a chat node via keyboard (Enter)", () => {
    const { onSelectThread } = renderSelector();
    fireEvent.keyDown(screen.getByTestId("radial-node-t1"), { key: "Enter" });
    expect(onSelectThread).toHaveBeenCalledWith("t1");
  });

  it("clicking a project node isolates its group, without selecting a thread", () => {
    const { onSelectThread } = renderSelector();
    const node = screen.getByTestId("radial-node-p1");

    fireEvent.pointerDown(node, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(node, { pointerId: 1, clientX: 100, clientY: 100 });

    expect(onSelectThread).not.toHaveBeenCalled();
    expect(screen.getByTestId("radial-group-p1")).toHaveAttribute("data-isolated", "true");
  });

  it("the Groups panel isolates and un-isolates a project on repeated clicks", () => {
    renderSelector();
    const row = screen.getByTestId("radial-group-p1");

    fireEvent.click(row);
    expect(row).toHaveAttribute("data-isolated", "true");

    fireEvent.click(row);
    expect(row).toHaveAttribute("data-isolated", "false");
  });

  it("the Groups panel lists each project's real thread count", () => {
    renderSelector();
    const row = screen.getByTestId("radial-group-p1");
    expect(row).toHaveTextContent("1");
  });

  it("clicking the hub clears an isolated project", () => {
    renderSelector();
    fireEvent.click(screen.getByTestId("radial-group-p1"));
    expect(screen.getByTestId("radial-group-p1")).toHaveAttribute("data-isolated", "true");

    const hub = screen.getByTestId("radial-node-hub");
    fireEvent.pointerDown(hub, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(hub, { pointerId: 1, clientX: 50, clientY: 50 });

    expect(screen.getByTestId("radial-group-p1")).toHaveAttribute("data-isolated", "false");
  });

  it("the settings toggle button shows and hides the settings panel", () => {
    renderSelector();
    expect(screen.getByTestId("radial-settings-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("radial-settings-toggle"));
    expect(screen.queryByTestId("radial-settings-panel")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("radial-settings-toggle"));
    expect(screen.getByTestId("radial-settings-panel")).toBeInTheDocument();
  });

  it("closes on the close button and on Escape", () => {
    const { onClose, rerender } = renderSelector();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <RadialChatSelector
        projects={PROJECTS}
        threads={THREADS}
        activeThreadId="t1"
        onSelectThread={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("reset to defaults clears an isolated project and the search box", () => {
    renderSelector();
    fireEvent.click(screen.getByTestId("radial-group-p1"));
    const search = screen.getByTestId("radial-search") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "bug" } });
    expect(search.value).toBe("bug");

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));

    expect(screen.getByTestId("radial-group-p1")).toHaveAttribute("data-isolated", "false");
    expect(screen.getByTestId("radial-search")).toHaveValue("");
  });

  it("persists a display toggle across close/reopen (remount)", () => {
    const { unmount } = renderSelector();
    const toggle = screen.getByLabelText("Show numbers");
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    unmount();

    renderSelector();
    expect(screen.getByLabelText("Show numbers")).not.toBeChecked();
  });

  it("persists a force slider's value across close/reopen (remount)", () => {
    const { unmount } = renderSelector();
    const slider = screen.getByLabelText("Repel force") as HTMLInputElement;

    fireEvent.change(slider, { target: { value: "180" } });
    unmount();

    renderSelector();
    const reopened = screen.getByLabelText("Repel force") as HTMLInputElement;
    expect(Number(reopened.value)).toBeCloseTo(180, 5);
  });

  it("reset to defaults also clears persisted settings, so a later reopen shows real defaults", () => {
    const { unmount } = renderSelector();
    fireEvent.change(screen.getByLabelText("Node size"), { target: { value: "350" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    unmount();

    renderSelector();
    expect((screen.getByLabelText("Node size") as HTMLInputElement).value).toBe("100");
  });

  it("respects prefers-reduced-motion: renders without starting the drift/physics loop", () => {
    mockReducedMotion(true);
    expect(() => renderSelector()).not.toThrow();
    expect(screen.getByTestId("radial-node-hub")).toBeInTheDocument();
  });

  it("the physics simulation actually moves node positions over real time", async () => {
    renderSelector();
    const node = screen.getByTestId("radial-node-t1");
    const initialTransform = node.getAttribute("transform");

    await waitFor(
      () => {
        expect(node.getAttribute("transform")).not.toBe(initialTransform);
      },
      { timeout: 2000 },
    );
  });

  // FIX_PLAN.md's own node-volume diagnosis, resolved differently than
  // it proposed: at the user's explicit direction (matching real
  // Obsidian's own graph view), never hide data — instead let the
  // canvas grow with node count and add pan/zoom so a real 70+-thread
  // vault stays navigable without deleting any node from the DOM.
  describe("pan and zoom (never hide data — grow the canvas and let the user navigate it)", () => {
    it("wheel-zooms the view group without removing any node from the DOM", async () => {
      renderSelector();
      const svg = screen.getByTestId("radial-svg");
      const viewGroup = svg.querySelector("g");
      const initialTransform = viewGroup?.getAttribute("transform");

      fireEvent.wheel(svg, { deltaY: -200, clientX: 400, clientY: 300 });

      await waitFor(() => {
        expect(viewGroup?.getAttribute("transform")).not.toBe(initialTransform);
      });
      // still every node, still in the DOM — zoom is a view transform,
      // never a data-hiding mechanism.
      expect(screen.getByTestId("radial-node-t1")).toBeInTheDocument();
      expect(screen.getByTestId("radial-node-t2")).toBeInTheDocument();
      expect(screen.getByTestId("radial-node-t3")).toBeInTheDocument();
    });

    it("hides labels once zoomed out past the LOD threshold, and restores them on reset", async () => {
      renderSelector();
      const svg = screen.getByTestId("radial-svg");

      // Each wheel event applies one fixed zoom-out step (matching a
      // real scroll tick) — several are needed to cross
      // LABEL_ZOOM_THRESHOLD from the default k=1, same as a real user
      // scrolling out would need more than one tick.
      for (let i = 0; i < 12; i++) {
        fireEvent.wheel(svg, { deltaY: 100, clientX: 400, clientY: 300 });
      }

      await waitFor(() => {
        expect(svg).toHaveClass("radial-hide-labels");
      });

      fireEvent.click(screen.getByTestId("radial-reset-view"));

      await waitFor(() => {
        expect(svg).not.toHaveClass("radial-hide-labels");
      });
    });

    it("dragging the empty canvas background pans the view", async () => {
      renderSelector();
      const svg = screen.getByTestId("radial-svg");
      const viewGroup = svg.querySelector("g");
      const initialTransform = viewGroup?.getAttribute("transform");

      fireEvent.pointerDown(svg, { pointerId: 1, clientX: 200, clientY: 200 });
      fireEvent.pointerMove(svg, { pointerId: 1, clientX: 260, clientY: 240 });

      await waitFor(() => {
        expect(viewGroup?.getAttribute("transform")).not.toBe(initialTransform);
      });

      fireEvent.pointerUp(svg, { pointerId: 1, clientX: 260, clientY: 240 });
    });

    it("dragging a node does not also pan the background", async () => {
      renderSelector();
      const svg = screen.getByTestId("radial-svg");
      const viewGroup = svg.querySelector("g");
      const node = screen.getByTestId("radial-node-t1");

      // Let the tick loop run at least one frame first, so
      // `initialTransform` reflects the real steady-state identity
      // transform rather than the pre-mount `null` the attribute starts
      // with (the tick loop is what first sets it, not the initial render).
      await waitFor(() => {
        expect(viewGroup?.getAttribute("transform")).toBe("translate(0,0) scale(1)");
      });
      const initialTransform = viewGroup?.getAttribute("transform");

      // pointerdown targets the node itself, not the svg — React's
      // bubbling still runs the svg's own onPointerDown, but its
      // `event.target !== svgRef.current` guard should reject it.
      fireEvent.pointerDown(node, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(node, { pointerId: 1, clientX: 160, clientY: 140 });

      // give the tick loop a moment; the view transform must stay put
      // even though the node itself is being dragged.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(viewGroup?.getAttribute("transform")).toBe(initialTransform);

      fireEvent.pointerUp(node, { pointerId: 1, clientX: 160, clientY: 140 });
    });

    it("the reset-view button restores identity pan/zoom", async () => {
      renderSelector();
      const svg = screen.getByTestId("radial-svg");
      const viewGroup = svg.querySelector("g");

      fireEvent.wheel(svg, { deltaY: -200, clientX: 400, clientY: 300 });
      await waitFor(() => {
        expect(viewGroup?.getAttribute("transform")).not.toBe("translate(0,0) scale(1)");
      });

      fireEvent.click(screen.getByTestId("radial-reset-view"));

      await waitFor(() => {
        expect(viewGroup?.getAttribute("transform")).toBe("translate(0,0) scale(1)");
      });
    });
  });
});
