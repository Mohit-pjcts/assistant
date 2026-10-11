import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HistoryTrace } from "@/lib/api";
import { HistoryPanel } from "./HistoryPanel";
import { modelTurn, onstageEntry, stageSummary, surface, tool, turn } from "./testFixtures";
import * as api from "@/lib/api";

// STEPS.md 158: the panel is now three tabs over the trace/Stage endpoints.
// (Its earlier tests showed raw /history messages; the one that re-rendered a
// persisted A2UI surface on the row that produced it lives on below as "draws
// a call's card inline", now fed by the trace's own `surfaces`. The thread
// picker those tests once covered moved to ThreadSidebar long before, see
// ThreadSidebar.test.tsx.)

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchHistoryTrace: vi.fn(),
    fetchStageRuns: vi.fn(),
    fetchStageRun: vi.fn(),
    fetchOnstageJournal: vi.fn(),
  };
});

const mockedFetchHistoryTrace = vi.mocked(api.fetchHistoryTrace);
const mockedFetchStageRuns = vi.mocked(api.fetchStageRuns);
const mockedFetchOnstageJournal = vi.mocked(api.fetchOnstageJournal);

function trace(turns: HistoryTrace["turns"], totalTurns = turns.length): HistoryTrace {
  return { thread_id: "thread-1", total_turns: totalTurns, turns };
}

const flightTurn = turn(0, {
  user: { content: "find me a flight to SF", synthetic: false },
  events: [
    { kind: "assistant", text: "Checking flights.", thinking: "prefer morning departures" },
    tool({
      id: "d1",
      name: "research_agent",
      delegation: "research_agent",
      input: { instruction: "flights to SF next Friday" },
      output: "United 9am, $240",
      children: [
        tool({
          id: "c1",
          agent: "research_agent",
          name: "web_search",
          input: { query: "SFO flights friday" },
          output: "3 results",
        }),
      ],
    }),
    { kind: "context", label: "recalled facts", content: "Prefers window seats." },
    { kind: "assistant", text: "The 9am United is cheapest.", thinking: null },
  ],
});

const emailTurn = turn(1, {
  user: { content: "email dana the details", synthetic: false },
  events: [
    tool({
      id: "e1",
      name: "life_admin_agent",
      delegation: "life_admin_agent",
      status: "interrupted",
      output: null,
      children: [],
    }),
  ],
});

beforeEach(() => {
  vi.resetAllMocks();
  mockedFetchStageRuns.mockResolvedValue({ runs: [], next: null });
  mockedFetchOnstageJournal.mockResolvedValue([]);
});

describe("HistoryPanel tabs", () => {
  it("offers Conversation, Stage and Onstage, opening on Conversation", async () => {
    mockedFetchHistoryTrace.mockResolvedValue(trace([flightTurn]));

    render(<HistoryPanel />);

    expect(screen.getByRole("tab", { name: "Conversation" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Stage" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Onstage" })).toHaveAttribute("aria-selected", "false");
    await screen.findByText("find me a flight to SF");
  });

  it("doesn't pull Stage's logs until someone opens the Stage tab", async () => {
    const user = userEvent.setup();
    mockedFetchHistoryTrace.mockResolvedValue(trace([flightTurn]));
    mockedFetchStageRuns.mockResolvedValue({
      runs: [stageSummary({ command: "open calculator" })],
      next: null,
    });

    render(<HistoryPanel />);
    await screen.findByText("find me a flight to SF");
    expect(mockedFetchStageRuns).not.toHaveBeenCalled();
    expect(mockedFetchOnstageJournal).not.toHaveBeenCalled();

    await user.click(screen.getByRole("tab", { name: "Stage" }));

    expect(await screen.findByText("open calculator")).toBeInTheDocument();
    expect(mockedFetchStageRuns).toHaveBeenCalledTimes(1);
    expect(mockedFetchOnstageJournal).not.toHaveBeenCalled();
  });

  it("opens the Onstage tab on demand too", async () => {
    const user = userEvent.setup();
    mockedFetchHistoryTrace.mockResolvedValue(trace([flightTurn]));
    mockedFetchOnstageJournal.mockResolvedValue([onstageEntry()]);

    render(<HistoryPanel />);
    await screen.findByText("find me a flight to SF");
    await user.click(screen.getByRole("tab", { name: "Onstage" }));

    expect(await screen.findByText("what does this button do?")).toBeInTheDocument();
  });

  it("keeps the conversation's filter and open rows when you visit another tab and come back", async () => {
    const user = userEvent.setup();
    mockedFetchHistoryTrace.mockResolvedValue(trace([flightTurn, emailTurn]));

    render(<HistoryPanel />);
    await screen.findByText("find me a flight to SF");
    await user.type(screen.getByRole("textbox", { name: "Filter conversation" }), "web_search");
    await user.click(await screen.findByRole("button", { name: /web_search/ }));
    expect(screen.getByText("3 results")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Stage" }));
    await screen.findByText("No Stage runs yet.");
    await user.click(screen.getByRole("tab", { name: "Conversation" }));

    expect(screen.getByRole("textbox", { name: "Filter conversation" })).toHaveValue("web_search");
    expect(screen.getByText("3 results")).toBeInTheDocument();
    // …and it didn't refetch just because the tab was left.
    expect(mockedFetchHistoryTrace).toHaveBeenCalledTimes(1);
  });
});

describe("HistoryPanel conversation", () => {
  it("asks for the active thread's latest page unless it's told which thread", async () => {
    mockedFetchHistoryTrace.mockResolvedValue(trace([flightTurn]));

    const { unmount } = render(<HistoryPanel />);
    await screen.findByText("find me a flight to SF");
    expect(mockedFetchHistoryTrace).toHaveBeenCalledWith(undefined, { limit: 30 });
    unmount();

    render(<HistoryPanel threadId="thread-9" />);
    await waitFor(() =>
      expect(mockedFetchHistoryTrace).toHaveBeenLastCalledWith("thread-9", { limit: 30 }),
    );
  });

  it("shows every turn with its events in order, including tool calls and their inner calls", async () => {
    mockedFetchHistoryTrace.mockResolvedValue(trace([flightTurn, emailTurn]));

    render(<HistoryPanel />);

    await screen.findByText("find me a flight to SF");
    expect(screen.getAllByTestId("trace-turn")).toHaveLength(2);
    expect(screen.getByText("Checking flights.")).toBeInTheDocument();
    // The delegation (called by the supervisor)…
    expect(screen.getByRole("button", { name: /supervisor\s+research_agent/ })).toBeInTheDocument();
    // …and the specialist's own call inside it, visible without opening anything.
    expect(screen.getByRole("button", { name: /research_agent\s+web_search/ })).toBeInTheDocument();
    expect(screen.getByText("The 9am United is cheapest.")).toBeInTheDocument();
    expect(screen.getByText("email dana the details")).toBeInTheDocument();
    expect(screen.getByText("interrupted")).toBeInTheDocument();
  });

  it("puts turns in chronological order even if the backend sends them otherwise", async () => {
    mockedFetchHistoryTrace.mockResolvedValue(trace([emailTurn, flightTurn]));

    render(<HistoryPanel />);

    await screen.findByText("find me a flight to SF");
    const labels = screen.getAllByTestId("trace-turn").map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual(["Turn 1", "Turn 2"]);
  });

  it("opens a tool call to its full input and output", async () => {
    const user = userEvent.setup();
    mockedFetchHistoryTrace.mockResolvedValue(trace([flightTurn]));

    render(<HistoryPanel />);
    await user.click(await screen.findByRole("button", { name: /web_search/ }));

    expect(screen.getByText(/"query": "SFO flights friday"/)).toBeInTheDocument();
    expect(screen.getByText("3 results")).toBeInTheDocument();
  });

  it("reports how much of the conversation is loaded", async () => {
    mockedFetchHistoryTrace.mockResolvedValue(trace([flightTurn, emailTurn], 5));

    render(<HistoryPanel />);

    expect(await screen.findByTestId("trace-summary")).toHaveTextContent("2 of 5 turns loaded");
  });

  it("shows a loading note until the first response", async () => {
    mockedFetchHistoryTrace.mockReturnValue(new Promise(() => {}));

    render(<HistoryPanel />);

    expect(screen.getByText("Loading conversation…")).toBeInTheDocument();
  });

  it("refetches when Refresh is clicked", async () => {
    const user = userEvent.setup();
    mockedFetchHistoryTrace.mockResolvedValueOnce(trace([turn(0, { user: { content: "first" } })]));

    render(<HistoryPanel />);
    await screen.findByText("first");

    mockedFetchHistoryTrace.mockResolvedValueOnce(
      trace([turn(0, { user: { content: "second" } })]),
    );
    await user.click(screen.getByRole("button", { name: /refresh/i }));

    expect(await screen.findByText("second")).toBeInTheDocument();
    expect(mockedFetchHistoryTrace).toHaveBeenCalledTimes(2);
  });

  describe("thinking and context", () => {
    it("keeps them collapsed until the switches are turned on", async () => {
      const user = userEvent.setup();
      mockedFetchHistoryTrace.mockResolvedValue(trace([flightTurn]));

      render(<HistoryPanel />);
      await screen.findByText("Checking flights.");
      expect(screen.queryByText("prefer morning departures")).not.toBeInTheDocument();
      expect(screen.queryByText("Prefers window seats.")).not.toBeInTheDocument();

      const showThinking = screen.getByRole("button", { name: "Show thinking" });
      expect(showThinking).toHaveAttribute("aria-pressed", "false");
      await user.click(showThinking);
      expect(showThinking).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("prefer morning departures")).toBeInTheDocument();
      expect(screen.queryByText("Prefers window seats.")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Show context" }));
      expect(screen.getByText("Prefers window seats.")).toBeInTheDocument();
    });
  });

  describe("filter", () => {
    it("narrows to the turns and calls that contain the text", async () => {
      const user = userEvent.setup();
      mockedFetchHistoryTrace.mockResolvedValue(trace([flightTurn, emailTurn]));

      render(<HistoryPanel />);
      await screen.findByText("find me a flight to SF");

      await user.type(screen.getByRole("textbox", { name: "Filter conversation" }), "life_admin");

      await waitFor(() => expect(screen.getAllByTestId("trace-turn")).toHaveLength(1));
      expect(screen.getByText("email dana the details")).toBeInTheDocument();
      expect(screen.queryByText("find me a flight to SF")).not.toBeInTheDocument();
      expect(screen.getByTestId("trace-summary")).toHaveTextContent("1 turn matches");
    });

    it("matches text inside a call's arguments and output, not just its name", async () => {
      const user = userEvent.setup();
      mockedFetchHistoryTrace.mockResolvedValue(trace([flightTurn, emailTurn]));

      render(<HistoryPanel />);
      await screen.findByText("find me a flight to SF");

      await user.type(screen.getByRole("textbox", { name: "Filter conversation" }), "united 9am");

      await waitFor(() => expect(screen.getAllByTestId("trace-turn")).toHaveLength(1));
      expect(
        screen.getByRole("button", { name: /supervisor\s+research_agent/ }),
      ).toBeInTheDocument();
      // Only the matching events of the turn are kept.
      expect(screen.queryByText("Checking flights.")).not.toBeInTheDocument();
    });

    it("doesn't let one call's open state spill onto another when the filter changes what's shown", async () => {
      const user = userEvent.setup();
      mockedFetchHistoryTrace.mockResolvedValue(
        trace([
          turn(0, {
            events: [
              tool({ id: "a", name: "alpha_tool", output: "alpha out" }),
              tool({ id: "b", name: "beta_tool", output: "beta out" }),
            ],
          }),
        ]),
      );

      render(<HistoryPanel />);
      await user.click(await screen.findByRole("button", { name: /alpha_tool/ }));
      expect(screen.getByText("alpha out")).toBeInTheDocument();

      await user.type(screen.getByRole("textbox", { name: "Filter conversation" }), "beta_tool");

      await waitFor(() =>
        expect(screen.queryByRole("button", { name: /alpha_tool/ })).not.toBeInTheDocument(),
      );
      // beta_tool now sits where alpha_tool did. It must not inherit its open state.
      expect(screen.getByRole("button", { name: /beta_tool/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(screen.queryByText("beta out")).not.toBeInTheDocument();
    });

    it("counts matches in the plural too", async () => {
      const user = userEvent.setup();
      mockedFetchHistoryTrace.mockResolvedValue(trace([turn(0), turn(1), turn(2)]));

      render(<HistoryPanel />);
      await screen.findByText("question 0");
      await user.type(screen.getByRole("textbox", { name: "Filter conversation" }), "question");

      await waitFor(() =>
        expect(screen.getByTestId("trace-summary")).toHaveTextContent("3 turns match"),
      );
    });

    it("shows a message in the tab, not a blank window, if the data can't be filtered", async () => {
      const user = userEvent.setup();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const broken = { index: 0, user: null, reply: null } as never;
      mockedFetchHistoryTrace.mockResolvedValue(trace([broken]));

      render(<HistoryPanel />);
      // Unfiltered, the bad turn is caught on its own…
      expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't display turn 1");

      // …and filtering walks every turn's events, so there it takes the tab.
      await user.type(screen.getByRole("textbox", { name: "Filter conversation" }), "x");

      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("Couldn't display the conversation"),
      );
      // The other tabs are untouched.
      expect(screen.getByRole("tab", { name: "Stage" })).toBeInTheDocument();
    });

    it("says when nothing matches, and restores everything when cleared", async () => {
      const user = userEvent.setup();
      mockedFetchHistoryTrace.mockResolvedValue(trace([flightTurn, emailTurn]));

      render(<HistoryPanel />);
      await screen.findByText("find me a flight to SF");
      const input = screen.getByRole("textbox", { name: "Filter conversation" });

      await user.type(input, "zebra");
      expect(await screen.findByText("No loaded turn matches “zebra”.")).toBeInTheDocument();

      await user.clear(input);
      await waitFor(() => expect(screen.getAllByTestId("trace-turn")).toHaveLength(2));
      expect(screen.queryByText(/No loaded turn matches/)).not.toBeInTheDocument();
    });
  });

  describe("loading earlier turns", () => {
    const newer = [turn(3), turn(4)];
    const older = [turn(0), turn(1), turn(2)];

    it("offers it only while there are earlier turns, with how many", async () => {
      mockedFetchHistoryTrace.mockResolvedValue(trace(newer, 5));

      render(<HistoryPanel />);

      expect(
        await screen.findByRole("button", { name: "Load earlier turns (3 more)" }),
      ).toBeInTheDocument();
    });

    it("doesn't offer it when everything is already loaded", async () => {
      mockedFetchHistoryTrace.mockResolvedValue(trace(older, 3));

      render(<HistoryPanel />);
      await screen.findByText("question 0");

      expect(screen.queryByRole("button", { name: /Load earlier turns/ })).not.toBeInTheDocument();
    });

    it("fetches the page before the oldest loaded turn, in the same thread, and prepends it", async () => {
      const user = userEvent.setup();
      mockedFetchHistoryTrace
        .mockResolvedValueOnce(trace(newer, 5))
        .mockResolvedValueOnce(trace(older, 5));

      render(<HistoryPanel />);
      await user.click(await screen.findByRole("button", { name: /Load earlier turns/ }));

      await waitFor(() => expect(screen.getAllByTestId("trace-turn")).toHaveLength(5));
      expect(mockedFetchHistoryTrace).toHaveBeenLastCalledWith("thread-1", {
        limit: 30,
        before: 3,
      });
      const labels = screen.getAllByTestId("trace-turn").map((el) => el.getAttribute("aria-label"));
      expect(labels).toEqual(["Turn 1", "Turn 2", "Turn 3", "Turn 4", "Turn 5"]);
      expect(screen.queryByRole("button", { name: /Load earlier turns/ })).not.toBeInTheDocument();
      expect(screen.getByTestId("trace-summary")).toHaveTextContent("5 of 5 turns loaded");
    });

    it("stops offering it if an earlier page comes back empty", async () => {
      const user = userEvent.setup();
      mockedFetchHistoryTrace
        .mockResolvedValueOnce(trace(newer, 5))
        .mockResolvedValueOnce(trace([], 5));

      render(<HistoryPanel />);
      await user.click(await screen.findByRole("button", { name: /Load earlier turns/ }));

      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: /Load earlier turns/ }),
        ).not.toBeInTheDocument(),
      );
    });

    it("doesn't show a turn twice if pages overlap", async () => {
      const user = userEvent.setup();
      mockedFetchHistoryTrace
        .mockResolvedValueOnce(trace(newer, 5))
        .mockResolvedValueOnce(trace([turn(2), turn(3)], 5));

      render(<HistoryPanel />);
      await user.click(await screen.findByRole("button", { name: /Load earlier turns/ }));

      await waitFor(() => expect(screen.getAllByTestId("trace-turn")).toHaveLength(3));
    });

    it("keeps the filter hint honest while older turns are unloaded", async () => {
      const user = userEvent.setup();
      mockedFetchHistoryTrace.mockResolvedValue(trace(newer, 5));

      render(<HistoryPanel />);
      await screen.findByText("question 3");
      await user.type(screen.getByRole("textbox", { name: "Filter conversation" }), "question 3");

      await waitFor(() =>
        expect(screen.getByTestId("trace-summary")).toHaveTextContent(
          "older turns are searched once loaded",
        ),
      );
    });
  });

  describe("states", () => {
    it("shows an empty state for a thread with no turns", async () => {
      mockedFetchHistoryTrace.mockResolvedValue(trace([]));

      render(<HistoryPanel />);

      expect(await screen.findByText("No turns in this conversation yet.")).toBeInTheDocument();
    });

    it("says history is only available on this Mac for a 403, not an error", async () => {
      mockedFetchHistoryTrace.mockRejectedValue(new api.HistoryForbiddenError("403"));

      render(<HistoryPanel />);

      expect(await screen.findByTestId("history-forbidden")).toHaveTextContent(
        /only available on this Mac/i,
      );
      expect(screen.queryByText("No turns in this conversation yet.")).not.toBeInTheDocument();
    });

    it("shows any other fetch error", async () => {
      mockedFetchHistoryTrace.mockRejectedValue(new Error("network down"));

      render(<HistoryPanel />);

      expect(await screen.findByText(/network down/)).toBeInTheDocument();
    });

    it("lets Refresh recover from an error", async () => {
      const user = userEvent.setup();
      mockedFetchHistoryTrace.mockRejectedValueOnce(new Error("network down"));

      render(<HistoryPanel />);
      await screen.findByText(/network down/);

      mockedFetchHistoryTrace.mockResolvedValueOnce(trace([flightTurn]));
      await user.click(screen.getByRole("button", { name: /refresh/i }));

      expect(await screen.findByText("find me a flight to SF")).toBeInTheDocument();
      expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
    });
  });

  it("keeps a 403 on one tab from affecting another", async () => {
    const user = userEvent.setup();
    mockedFetchHistoryTrace.mockResolvedValue(trace([flightTurn]));
    mockedFetchStageRuns.mockRejectedValue(new api.HistoryForbiddenError("403"));

    render(<HistoryPanel />);
    await screen.findByText("find me a flight to SF");
    await user.click(screen.getByRole("tab", { name: "Stage" }));

    const stagePanel = within(screen.getByRole("tabpanel", { name: "Stage" }));
    expect(await stagePanel.findByTestId("history-forbidden")).toBeInTheDocument();
    expect(screen.queryByText("No turns in this conversation yet.")).not.toBeInTheDocument();
  });
});

describe("HistoryPanel cards, errors and a specialist's own turns", () => {
  // A delegation the way the backend now sends one: the specialist's calls
  // and its own model turns interleaved, in the order they happened.
  const refundTurn = turn(0, {
    user: { content: "can I get a refund?", synthetic: false },
    events: [
      tool({
        id: "d1",
        name: "research_agent",
        delegation: "research_agent",
        output: "Refunds are allowed within 24 hours.",
        children: [
          modelTurn({
            id: "m1",
            text: "Checking the airline's refund policy page.",
            thinking: "the fare class decides whether it is refundable",
          }),
          tool({
            id: "c1",
            agent: "research_agent",
            name: "web_fetch",
            output: "Policy: 24-hour free cancellation.",
          }),
          modelTurn({ id: "m2", text: "The policy allows a refund within a day." }),
        ],
      }),
    ],
  });

  it("draws a call's card inline on the row that produced it", async () => {
    mockedFetchHistoryTrace.mockResolvedValue(
      trace([
        turn(0, {
          user: { content: "show me today", synthetic: false },
          events: [
            tool({
              id: "r1",
              name: "render_ui",
              input: { components: [] },
              output: "[UI presented: 1 component(s) (Text) — hello from history]",
              surfaces: [surface("hello from history")],
            }),
            { kind: "assistant", text: "There you go.", thinking: null },
          ],
        }),
      ]),
    );

    render(<HistoryPanel />);

    expect(await screen.findByTestId("a2ui-surface")).toBeInTheDocument();
    expect(screen.getByText("hello from history")).toBeInTheDocument();
  });

  it("shows what a specialist said between its calls, in order, under the delegation", async () => {
    mockedFetchHistoryTrace.mockResolvedValue(trace([refundTurn]));

    render(<HistoryPanel />);

    expect(
      await screen.findByText("Checking the airline's refund policy page."),
    ).toBeInTheDocument();
    const row = screen.getAllByTestId("tool-row")[0].textContent ?? "";
    expect(row.indexOf("Checking the airline's refund policy page.")).toBeLessThan(
      row.indexOf("web_fetch"),
    );
    expect(row.indexOf("web_fetch")).toBeLessThan(
      row.indexOf("The policy allows a refund within a day."),
    );
    expect(
      screen.getByRole("button", { name: "inside research_agent (3 steps)" }),
    ).toBeInTheDocument();
  });

  it("opens a specialist's thinking with 'Show thinking', as it does the supervisor's", async () => {
    const user = userEvent.setup();
    mockedFetchHistoryTrace.mockResolvedValue(trace([refundTurn]));

    render(<HistoryPanel />);
    await screen.findByText("Checking the airline's refund policy page.");
    expect(screen.queryByText(/fare class decides/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show thinking" }));

    expect(screen.getByText("the fare class decides whether it is refundable")).toBeInTheDocument();
  });

  it("finds a turn by something only the specialist said", async () => {
    const user = userEvent.setup();
    mockedFetchHistoryTrace.mockResolvedValue(trace([flightTurn, refundTurn]));

    render(<HistoryPanel />);
    await screen.findByText("find me a flight to SF");

    await user.type(screen.getByRole("textbox", { name: "Filter conversation" }), "fare class");

    await waitFor(() => expect(screen.getAllByTestId("trace-turn")).toHaveLength(1));
    expect(screen.getByText("can I get a refund?")).toBeInTheDocument();
    // The match was in the specialist's thinking, so it's the delegation that's kept.
    expect(screen.getByRole("button", { name: /supervisor\s+research_agent/ })).toBeInTheDocument();
  });

  it("finds a call by its error text, and shows the text when it's opened", async () => {
    const user = userEvent.setup();
    mockedFetchHistoryTrace.mockResolvedValue(
      trace([
        flightTurn,
        turn(1, {
          user: { content: "check my inbox", synthetic: false },
          events: [
            tool({
              id: "g1",
              name: "search_gmail",
              status: "error",
              output: null,
              error: "RuntimeError: gmail timed out",
            }),
          ],
        }),
      ]),
    );

    render(<HistoryPanel />);
    await screen.findByText("find me a flight to SF");
    await user.type(screen.getByRole("textbox", { name: "Filter conversation" }), "timed out");

    await waitFor(() => expect(screen.getAllByTestId("trace-turn")).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: /search_gmail/ }));
    expect(screen.getByText("RuntimeError: gmail timed out")).toBeInTheDocument();
  });
});
