import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TraceEvent, TraceTurn } from "@/lib/api";
import { TraceTimeline } from "./TraceTimeline";
import { modelTurn, surface, tool, turn } from "./testFixtures";

function renderTimeline(
  turns: TraceTurn[],
  flags: { showThinking?: boolean; showContext?: boolean } = {},
) {
  return render(
    <TraceTimeline
      turns={turns}
      showThinking={flags.showThinking ?? false}
      showContext={flags.showContext ?? false}
    />,
  );
}

describe("TraceTimeline", () => {
  it("shows each turn as the user's message followed by its events, in order", () => {
    renderTimeline([
      turn(0, {
        user: { content: "find me a flight", synthetic: false },
        events: [
          { kind: "assistant", text: "Let me look that up.", thinking: null },
          tool({ id: "a", name: "web_search" }),
          { kind: "assistant", text: "Here is the cheapest one.", thinking: null },
        ],
      }),
    ]);

    const text = screen.getByTestId("trace-turn").textContent ?? "";
    const positions = [
      "find me a flight",
      "Let me look that up.",
      "web_search",
      "Here is the cheapest one.",
    ].map((snippet) => text.indexOf(snippet));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("numbers turns from 1 and labels each section for assistive tech", () => {
    renderTimeline([turn(0), turn(1)]);

    expect(screen.getByRole("region", { name: "Turn 1" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Turn 2" })).toBeInTheDocument();
  });

  it("keeps turns in the order it was given", () => {
    renderTimeline([turn(4), turn(5), turn(6)]);

    const labels = screen.getAllByTestId("trace-turn").map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual(["Turn 5", "Turn 6", "Turn 7"]);
  });

  it("shows graph activity that precedes the first message without inventing a user", () => {
    renderTimeline([turn(0, { user: null })]);

    expect(screen.getByText("Before the first message")).toBeInTheDocument();
    expect(screen.queryByText("You")).not.toBeInTheDocument();
  });

  it("flags a user message the graph itself inserted", () => {
    renderTimeline([turn(0, { user: { content: "routing bridge", synthetic: true } })]);
    expect(screen.getByText("internal")).toBeInTheDocument();
  });

  it("renders a tool call as a row, with a delegation's inner calls nested", () => {
    renderTimeline([
      turn(0, {
        events: [
          tool({
            id: "d",
            name: "research_agent",
            delegation: "research_agent",
            children: [tool({ id: "c", agent: "research_agent", name: "web_fetch" })],
          }),
        ],
      }),
    ]);

    expect(screen.getAllByTestId("tool-row")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /web_fetch/ })).toBeInTheDocument();
  });

  it("draws a call's card inside its turn", () => {
    renderTimeline([
      turn(0, {
        events: [
          tool({ id: "r1", name: "render_ui", surfaces: [surface("a card from the turn")] }),
        ],
      }),
    ]);

    expect(
      within(screen.getByTestId("trace-turn")).getByText("a card from the turn"),
    ).toBeInTheDocument();
  });

  it("shows a delegation's own model turns among its calls, and opens their thinking with the switch", () => {
    const delegation = tool({
      id: "d",
      name: "research_agent",
      delegation: "research_agent",
      children: [
        modelTurn({ id: "m1", text: "Let me look.", thinking: "start with the airline site" }),
        tool({ id: "c", agent: "research_agent", name: "web_fetch" }),
      ],
    });
    const { rerender } = renderTimeline([turn(0, { events: [delegation] })]);

    expect(screen.getByText("Let me look.")).toBeInTheDocument();
    expect(screen.queryByText("start with the airline site")).not.toBeInTheDocument();

    rerender(
      <TraceTimeline
        turns={[turn(0, { events: [delegation] })]}
        showThinking
        showContext={false}
      />,
    );
    expect(screen.getByText("start with the airline site")).toBeInTheDocument();
  });

  describe("thinking", () => {
    const withThinking = turn(0, {
      events: [{ kind: "assistant", text: "Done.", thinking: "the user wants it short" }],
    });

    it("sits behind a 'thinking' toggle, closed by default", () => {
      renderTimeline([withThinking]);

      expect(screen.getByRole("button", { name: "thinking" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(screen.queryByText("the user wants it short")).not.toBeInTheDocument();
    });

    it("opens one block on click, and closes it again", async () => {
      const user = userEvent.setup();
      renderTimeline([withThinking]);

      await user.click(screen.getByRole("button", { name: "thinking" }));
      expect(screen.getByText("the user wants it short")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "thinking" }));
      expect(screen.queryByText("the user wants it short")).not.toBeInTheDocument();
    });

    it("has no toggle when the turn has no thinking", () => {
      renderTimeline([turn(0)]);
      expect(screen.queryByRole("button", { name: "thinking" })).not.toBeInTheDocument();
    });

    it("opens every block when 'show thinking' is on, and an individual block can still be closed", async () => {
      const user = userEvent.setup();
      const { rerender } = renderTimeline([withThinking], { showThinking: false });

      rerender(<TraceTimeline turns={[withThinking]} showThinking showContext={false} />);
      expect(screen.getByText("the user wants it short")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "thinking" }));
      expect(screen.queryByText("the user wants it short")).not.toBeInTheDocument();

      // Turning the global switch off and on again re-applies it to every block.
      rerender(<TraceTimeline turns={[withThinking]} showThinking={false} showContext={false} />);
      rerender(<TraceTimeline turns={[withThinking]} showThinking showContext={false} />);
      expect(screen.getByText("the user wants it short")).toBeInTheDocument();
    });
  });

  describe("context", () => {
    const withContext = turn(0, {
      events: [{ kind: "context", label: "recalled facts", content: "User prefers window seats." }],
    });

    it("shows a labelled, collapsed row", () => {
      renderTimeline([withContext]);

      const toggle = screen.getByRole("button", { name: "context recalled facts" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("User prefers window seats.")).not.toBeInTheDocument();
    });

    it("opens on click", async () => {
      const user = userEvent.setup();
      renderTimeline([withContext]);

      await user.click(screen.getByRole("button", { name: "context recalled facts" }));

      expect(screen.getByText("User prefers window seats.")).toBeInTheDocument();
    });

    it("opens every context block when 'show context' is on", () => {
      renderTimeline([withContext], { showContext: true });
      expect(screen.getByText("User prefers window seats.")).toBeInTheDocument();
    });
  });

  it("shows an event kind it doesn't know whole, instead of dropping it", async () => {
    const user = userEvent.setup();
    const future = {
      kind: "reasoning_summary",
      detail: "new backend field",
    } as unknown as TraceEvent;
    renderTimeline([turn(0, { events: [future] })]);

    const unknown = screen.getByTestId("trace-unknown");
    expect(within(unknown).getByText("reasoning_summary")).toBeInTheDocument();
    await user.click(within(unknown).getByRole("button", { name: "raw" }));
    expect(within(unknown).getByText(/new backend field/)).toBeInTheDocument();
  });

  it("renders nothing at all for no turns", () => {
    renderTimeline([]);
    expect(screen.queryByTestId("trace-turn")).not.toBeInTheDocument();
  });

  describe("a turn the backend sent malformed", () => {
    beforeEach(() => {
      // React and RenderBoundary both log a caught render error.
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("is replaced by a message, and the turns around it still render", () => {
      const broken = { index: 1, user: null, reply: null } as unknown as TraceTurn;
      renderTimeline([turn(0), broken, turn(2)]);

      expect(screen.getByText("question 0")).toBeInTheDocument();
      expect(screen.getByText("question 2")).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't display turn 2");
    });
  });
});
