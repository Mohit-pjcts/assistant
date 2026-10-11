import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolCallRow } from "./ToolCallRow";
import { STAGE_RUN_ID, modelTurn, stageDetail, surface, tool } from "./testFixtures";
import * as api from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, fetchStageRun: vi.fn() };
});

const mockedFetchStageRun = vi.mocked(api.fetchStageRun);

beforeEach(() => {
  vi.resetAllMocks();
});

function headerButton(name: RegExp | string) {
  return screen.getByRole("button", { name });
}

describe("ToolCallRow header", () => {
  it("shows who called what, how it went, and how long it took", () => {
    render(<ToolCallRow event={tool({ agent: "supervisor", name: "web_search" })} />);

    const header = headerButton(/web_search/);
    expect(within(header).getByText("supervisor")).toBeInTheDocument();
    expect(within(header).getByText("web_search")).toBeInTheDocument();
    expect(within(header).getByText("ok")).toBeInTheDocument();
    expect(within(header).getByText("1.2 s")).toBeInTheDocument();
  });

  it.each(["ok", "error", "interrupted", "pending"] as const)("shows the %s status", (status) => {
    render(<ToolCallRow event={tool({ status })} />);

    expect(screen.getByTestId("tool-row")).toHaveAttribute("data-status", status);
    expect(within(headerButton(/web_search/)).getByText(status)).toBeInTheDocument();
  });

  it("leaves out the duration when none was recorded (a call from before call tracing)", () => {
    render(<ToolCallRow event={tool({ duration_ms: null, started_at: null, ended_at: null })} />);

    expect(within(headerButton(/web_search/)).queryByText(/ms$|\ss$/)).not.toBeInTheDocument();
  });

  it("marks a delegation (the backend names its tool), and only a delegation", () => {
    const { rerender } = render(
      <ToolCallRow event={tool({ name: "research_agent", delegation: "research_agent" })} />,
    );
    expect(screen.getByText("delegation")).toBeInTheDocument();

    rerender(<ToolCallRow event={tool({ name: "web_search", delegation: null })} />);
    expect(screen.queryByText("delegation")).not.toBeInTheDocument();
  });

  it("shows the specialist's name as the badge on one of its inner calls", () => {
    render(<ToolCallRow event={tool({ agent: "research_agent", name: "web_fetch" })} />);
    expect(within(headerButton(/web_fetch/)).getByText("research_agent")).toBeInTheDocument();
  });

  it("peeks at the arguments on one line while collapsed", () => {
    render(<ToolCallRow event={tool({ input: { query: "weather in Austin" } })} />);
    expect(screen.getByText('{"query":"weather in Austin"}')).toBeInTheDocument();
  });
});

describe("ToolCallRow expansion", () => {
  it("is collapsed by default and opens on click, showing the full input and output", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallRow
        event={tool({
          id: "toolu_abc",
          input: { query: "weather in Austin", max_results: 3 },
          output: "72F and sunny",
        })}
      />,
    );
    const header = headerButton(/web_search/);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("72F and sunny")).not.toBeInTheDocument();

    await user.click(header);

    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(header).toHaveAttribute("aria-controls");
    expect(screen.getByText(/"max_results": 3/)).toBeInTheDocument();
    expect(screen.getByText("72F and sunny")).toBeInTheDocument();
    expect(screen.getByText("call toolu_abc")).toBeInTheDocument();
    // The one-line peek is only for the collapsed state — no duplicate once open.
    expect(
      screen.queryByText('{"query":"weather in Austin","max_results":3}'),
    ).not.toBeInTheDocument();
  });

  it("closes again on a second click", async () => {
    const user = userEvent.setup();
    render(<ToolCallRow event={tool({ output: "72F and sunny" })} />);
    const header = headerButton(/web_search/);

    await user.click(header);
    await user.click(header);

    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("72F and sunny")).not.toBeInTheDocument();
  });

  it("has a copy button on each of input and output that copies the exact text", async () => {
    const user = userEvent.setup();
    render(<ToolCallRow event={tool({ input: { a: 1 }, output: "exact output" })} />);
    await user.click(headerButton(/web_search/));

    await user.click(screen.getByRole("button", { name: "Copy input" }));
    expect(await navigator.clipboard.readText()).toBe('{\n  "a": 1\n}');

    await user.click(screen.getByRole("button", { name: "Copy output" }));
    expect(await navigator.clipboard.readText()).toBe("exact output");
  });

  it("collapses a very long output to a preview with its character count", async () => {
    const user = userEvent.setup();
    render(<ToolCallRow event={tool({ output: "z".repeat(12_345) })} />);
    await user.click(headerButton(/web_search/));

    expect(screen.getByRole("button", { name: "show all (12,345 chars)" })).toBeInTheDocument();
  });

  it.each([
    ["pending", /no result yet/],
    ["interrupted", /confirmation gate/],
    ["error", /no output recorded/],
  ] as const)("explains a missing output for a %s call honestly", async (status, message) => {
    const user = userEvent.setup();
    render(<ToolCallRow event={tool({ status, output: null })} />);
    await user.click(headerButton(/web_search/));

    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("tells a tool that returned nothing apart from one with no recorded output", async () => {
    const user = userEvent.setup();
    render(<ToolCallRow event={tool({ output: "" })} />);
    await user.click(headerButton(/web_search/));

    expect(screen.getByText("(empty output)")).toBeInTheDocument();
  });
});

describe("ToolCallRow inner steps", () => {
  const delegation = tool({
    id: "d1",
    name: "research_agent",
    delegation: "research_agent",
    children: [
      tool({
        id: "c1",
        agent: "research_agent",
        name: "web_search",
        children: [tool({ id: "g1", agent: "research_agent", name: "nested_grandchild" })],
      }),
      tool({ id: "c2", agent: "research_agent", name: "web_fetch", status: "error" }),
    ],
  });

  it("nests every inner call under its delegation, recursively, without needing a click", () => {
    render(<ToolCallRow event={delegation} />);

    expect(screen.getAllByTestId("tool-row")).toHaveLength(4);
    expect(screen.getByRole("button", { name: /web_search/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /web_fetch/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /nested_grandchild/ })).toBeInTheDocument();
  });

  it("labels the group with the specialist and how many steps it took", () => {
    render(<ToolCallRow event={delegation} />);
    expect(screen.getByRole("button", { name: "inside research_agent (2 steps)" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("says '1 step' for a single step", () => {
    render(
      <ToolCallRow
        event={tool({
          name: "research_agent",
          delegation: "research_agent",
          children: [tool({ id: "c1", agent: "research_agent", name: "web_fetch" })],
        })}
      />,
    );
    expect(
      screen.getByRole("button", { name: "inside research_agent (1 step)" }),
    ).toBeInTheDocument();
  });

  it("falls back to the first step's agent, then the tool's own name, to name the group", () => {
    const { rerender } = render(
      <ToolCallRow
        event={tool({
          name: "some_tool",
          delegation: null,
          children: [tool({ id: "c1", agent: "coding_agent", name: "run_claude_code" })],
        })}
      />,
    );
    expect(
      screen.getByRole("button", { name: "inside coding_agent (1 step)" }),
    ).toBeInTheDocument();

    rerender(
      <ToolCallRow
        event={tool({
          name: "some_tool",
          delegation: null,
          children: [modelTurn({ id: "m1", agent: undefined })],
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "inside some_tool (1 step)" })).toBeInTheDocument();
  });

  it("hides and shows the inner steps with that toggle", async () => {
    const user = userEvent.setup();
    render(<ToolCallRow event={delegation} />);

    await user.click(screen.getByRole("button", { name: "inside research_agent (2 steps)" }));
    expect(screen.getAllByTestId("tool-row")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "inside research_agent (2 steps)" }));
    expect(screen.getAllByTestId("tool-row")).toHaveLength(4);
  });

  it("lets an inner call be opened on its own", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallRow
        event={tool({
          name: "research_agent",
          delegation: "research_agent",
          output: "parent output",
          children: [
            tool({ id: "c1", agent: "research_agent", name: "web_fetch", output: "child output" }),
          ],
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: /web_fetch/ }));

    expect(screen.getByText("child output")).toBeInTheDocument();
    expect(screen.queryByText("parent output")).not.toBeInTheDocument();
  });

  it("has no inner-steps group for a call with no children", () => {
    render(<ToolCallRow event={tool({ children: [] })} />);
    expect(screen.queryByRole("button", { name: /^inside / })).not.toBeInTheDocument();
  });

  it("copes with a call whose children are missing or null (rows from before inner steps were traced)", () => {
    const { children: _omitted, ...older } = tool();
    const { rerender } = render(<ToolCallRow event={older} />);
    expect(screen.getByTestId("tool-row")).toBeInTheDocument();

    rerender(<ToolCallRow event={tool({ children: null })} />);
    expect(screen.getByTestId("tool-row")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^inside / })).not.toBeInTheDocument();
  });
});

describe("ToolCallRow Stage run", () => {
  const backstage = tool({
    id: "b1",
    name: "backstage",
    delegation: "backstage",
    input: { instruction: "compute 2+2 in Calculator" },
    output: `Backstage run ${STAGE_RUN_ID} (finished): 1/2 done`,
    stage_run_id: STAGE_RUN_ID,
  });

  it("offers the Stage run but doesn't fetch it until asked", () => {
    render(<ToolCallRow event={backstage} />);

    expect(
      screen.getByRole("button", { name: new RegExp(`Stage run ${STAGE_RUN_ID}`) }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(mockedFetchStageRun).not.toHaveBeenCalled();
  });

  it("fetches and shows the run on expand: header, tasks, steps and helper lines", async () => {
    const user = userEvent.setup();
    mockedFetchStageRun.mockResolvedValue(stageDetail());
    render(<ToolCallRow event={backstage} />);

    await user.click(screen.getByRole("button", { name: new RegExp(`Stage run ${STAGE_RUN_ID}`) }));

    expect(await screen.findByTestId("stage-run-view")).toBeInTheDocument();
    expect(mockedFetchStageRun).toHaveBeenCalledWith(STAGE_RUN_ID);
    expect(mockedFetchStageRun).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("stage-task")).toHaveLength(2);
    expect(screen.getAllByTestId("stage-step").length).toBeGreaterThan(0);
    expect(screen.getByTestId("stage-helper")).toBeInTheDocument();
  });

  it("shows a loading note while the run is fetched", async () => {
    const user = userEvent.setup();
    mockedFetchStageRun.mockReturnValue(new Promise(() => {}));
    render(<ToolCallRow event={backstage} />);

    await user.click(screen.getByRole("button", { name: new RegExp(`Stage run ${STAGE_RUN_ID}`) }));

    expect(await screen.findByText(/loading stage run/i)).toBeInTheDocument();
  });

  it("shows the error if the run can't be fetched, with a way to retry", async () => {
    const user = userEvent.setup();
    mockedFetchStageRun.mockRejectedValueOnce(new Error("/stage/runs failed (500): boom"));
    render(<ToolCallRow event={backstage} />);

    await user.click(screen.getByRole("button", { name: new RegExp(`Stage run ${STAGE_RUN_ID}`) }));
    expect(await screen.findByText(/boom/)).toBeInTheDocument();

    mockedFetchStageRun.mockResolvedValueOnce(stageDetail());
    await user.click(screen.getByRole("button", { name: /reload run/i }));
    expect(await screen.findByTestId("stage-run-view")).toBeInTheDocument();
  });

  it("explains a 403 instead of showing an error", async () => {
    const user = userEvent.setup();
    mockedFetchStageRun.mockRejectedValue(new api.HistoryForbiddenError("403"));
    render(<ToolCallRow event={backstage} />);

    await user.click(screen.getByRole("button", { name: new RegExp(`Stage run ${STAGE_RUN_ID}`) }));

    expect(await screen.findByText(/only available on this Mac/i)).toBeInTheDocument();
  });

  it("has no Stage run section on a call that didn't start one", () => {
    render(<ToolCallRow event={tool({ stage_run_id: null })} />);
    expect(screen.queryByRole("button", { name: /Stage run/ })).not.toBeInTheDocument();
  });

  it("shows a run that is still going with a reload button", async () => {
    const user = userEvent.setup();
    const detail = stageDetail();
    mockedFetchStageRun.mockResolvedValue({
      ...detail,
      summary: { ...detail.summary, status: "unfinished", totals: null, ended_at: null },
    });
    render(<ToolCallRow event={backstage} />);

    await user.click(screen.getByRole("button", { name: new RegExp(`Stage run ${STAGE_RUN_ID}`) }));

    expect(await screen.findByRole("button", { name: /reload run/i })).toBeInTheDocument();
  });
});

describe("ToolCallRow cards", () => {
  it("draws the A2UI card a call produced, under the row, without opening anything", () => {
    render(
      <ToolCallRow
        event={tool({ name: "render_ui", surfaces: [surface("hello from history")] })}
      />,
    );

    expect(screen.getByTestId("a2ui-surface")).toBeInTheDocument();
    expect(screen.getByText("hello from history")).toBeInTheDocument();
    expect(headerButton(/render_ui/)).toHaveAttribute("aria-expanded", "false");
  });

  it("draws every card the call carried, in order", () => {
    render(
      <ToolCallRow
        event={tool({ surfaces: [surface("first card", "s1"), surface("second card", "s2")] })}
      />,
    );

    const cards = screen.getAllByTestId("a2ui-surface");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText("first card")).toBeInTheDocument();
    expect(within(cards[1]).getByText("second card")).toBeInTheDocument();
  });

  it("shows the cards a delegation's specialist rendered on the delegation itself", () => {
    render(
      <ToolCallRow
        event={tool({
          name: "research_agent",
          delegation: "research_agent",
          surfaces: [surface("the specialist's table")],
        })}
      />,
    );

    expect(screen.getByText("the specialist's table")).toBeInTheDocument();
  });

  it("keeps the card visible while the row is open, below its input and output", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallRow
        event={tool({ output: "72F and sunny", surfaces: [surface("weather card")] })}
      />,
    );

    await user.click(headerButton(/web_search/));

    const output = screen.getByText("72F and sunny");
    const card = screen.getByText("weather card");
    expect(output.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([[undefined], [null], [[]]])("has no card area when surfaces is %s", (surfaces) => {
    render(<ToolCallRow event={tool({ surfaces: surfaces as never })} />);

    expect(screen.queryByTestId("tool-surfaces")).not.toBeInTheDocument();
    expect(screen.queryByTestId("a2ui-surface")).not.toBeInTheDocument();
  });
});

describe("ToolCallRow error and attached data", () => {
  it("shows the exception text of a call that raised, in the expanded row", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallRow
        event={tool({ status: "error", output: null, error: "RuntimeError: gmail timed out" })}
      />,
    );
    expect(screen.queryByText(/gmail timed out/)).not.toBeInTheDocument();

    await user.click(headerButton(/web_search/));

    expect(screen.getByText("RuntimeError: gmail timed out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy error" })).toBeInTheDocument();
  });

  it.each([[undefined], [null], [""]])("has no Error block when error is %s", async (error) => {
    const user = userEvent.setup();
    render(<ToolCallRow event={tool({ error: error as never })} />);

    await user.click(headerButton(/web_search/));

    expect(screen.queryByText("Error")).not.toBeInTheDocument();
  });

  it("shows whatever else the call's result carried as 'Attached data'", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallRow
        event={tool({
          name: "open_url_on_phone",
          extras: { phone_action: [{ type: "open_url", url: "https://example.com/a" }] },
        })}
      />,
    );

    await user.click(headerButton(/open_url_on_phone/));

    expect(screen.getByText("Attached data")).toBeInTheDocument();
    expect(screen.getByText(/"type": "open_url"/)).toBeInTheDocument();
    expect(screen.getByText(/"url": "https:\/\/example.com\/a"/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy attached data" }));
    expect(await navigator.clipboard.readText()).toContain("open_url");
  });

  it.each([[{}], [undefined], [null]])(
    "has no Attached data block when extras is %s",
    async (extras) => {
      const user = userEvent.setup();
      render(<ToolCallRow event={tool({ extras: extras as never })} />);

      await user.click(headerButton(/web_search/));

      expect(screen.queryByText("Attached data")).not.toBeInTheDocument();
    },
  );

  it("lays the expanded row out in reading order: input, error, output, attached data", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallRow
        event={tool({
          status: "error",
          error: "boom",
          output: "partial output",
          extras: { note: "x" },
        })}
      />,
    );

    await user.click(headerButton(/web_search/));

    const labels = screen
      .getAllByText(/^(Input|Error|Output|Attached data)$/)
      .map((el) => el.textContent);
    expect(labels).toEqual(["Input", "Error", "Output", "Attached data"]);
  });
});

describe("ToolCallRow invalid calls", () => {
  // Arguments the model got wrong never parse into an object, so the backend
  // sends the raw string it received, on a call with status "error".
  const raw = '{"query": "weather in Austin"';

  it("shows the raw string the model sent, both as the peek and as the input", async () => {
    const user = userEvent.setup();
    render(
      <ToolCallRow
        event={tool({
          status: "error",
          input: raw,
          output: null,
          error: "ValidationError: arguments are not valid JSON",
        })}
      />,
    );
    expect(within(headerButton(/web_search/)).getByText("error")).toBeInTheDocument();
    expect(screen.getByText(raw)).toBeInTheDocument();

    await user.click(headerButton(/web_search/));

    // The peek goes away once open; the Input block now holds the same text.
    expect(screen.getByText(raw)).toBeInTheDocument();
    expect(screen.getByText("ValidationError: arguments are not valid JSON")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy input" })).toBeInTheDocument();
  });
});

describe("ToolCallRow inner model turns", () => {
  const mixed = tool({
    id: "d1",
    name: "research_agent",
    delegation: "research_agent",
    children: [
      modelTurn({ id: "m1", text: "I'll search first.", thinking: "need fresh data" }),
      tool({ id: "c1", agent: "research_agent", name: "web_search", output: "3 results" }),
      modelTurn({
        id: "m2",
        text: "Found three options.",
        duration_ms: 1500,
        usage: {
          input_tokens: 2000,
          output_tokens: 80,
          cache_read_tokens: 1800,
          cache_creation_tokens: 150,
        },
      }),
      tool({ id: "c2", agent: "research_agent", name: "web_fetch" }),
    ],
  });

  it("shows the specialist's calls and its own turns together, in the order they happened", () => {
    render(<ToolCallRow event={mixed} />);

    const text = screen.getAllByTestId("tool-row")[0].textContent ?? "";
    const positions = ["I'll search first.", "web_search", "Found three options.", "web_fetch"].map(
      (snippet) => text.indexOf(snippet),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(screen.getAllByTestId("tool-row")).toHaveLength(3);
    expect(screen.getAllByTestId("trace-assistant")).toHaveLength(2);
  });

  it("counts both kinds of step in the group label", () => {
    render(<ToolCallRow event={mixed} />);
    expect(
      screen.getByRole("button", { name: "inside research_agent (4 steps)" }),
    ).toBeInTheDocument();
  });

  it("gives a model turn a line with its agent, model, duration and token use", () => {
    render(<ToolCallRow event={mixed} />);

    const second = within(screen.getAllByTestId("trace-model-meta")[1]);
    expect(second.getByText("research_agent")).toBeInTheDocument();
    expect(second.getByText("claude-sonnet-5")).toBeInTheDocument();
    expect(second.getByText("1.5 s")).toBeInTheDocument();
    expect(
      second.getByText("2,000 in / 80 out · cache read 1,800 · cache write 150"),
    ).toBeInTheDocument();
  });

  it("doesn't label a specialist's turn as the supervisor's ('Oni')", () => {
    render(<ToolCallRow event={mixed} />);
    expect(screen.queryByText("Oni")).not.toBeInTheDocument();
  });

  it("keeps a model turn's thinking behind a toggle", async () => {
    const user = userEvent.setup();
    render(<ToolCallRow event={mixed} />);
    const first = within(screen.getAllByTestId("trace-assistant")[0]);
    expect(first.queryByText("need fresh data")).not.toBeInTheDocument();

    await user.click(first.getByRole("button", { name: "thinking" }));

    expect(first.getByText("need fresh data")).toBeInTheDocument();
  });

  it("opens every model turn's thinking when the global switch is on", () => {
    render(<ToolCallRow event={mixed} showThinking />);
    expect(screen.getByText("need fresh data")).toBeInTheDocument();
  });

  it("passes the global thinking switch down through nested delegations", () => {
    render(
      <ToolCallRow
        showThinking
        event={tool({
          id: "outer",
          name: "research_agent",
          delegation: "research_agent",
          children: [
            tool({
              id: "inner",
              agent: "research_agent",
              name: "coding_agent",
              delegation: "coding_agent",
              children: [
                modelTurn({ id: "deep", agent: "coding_agent", thinking: "deep thought" }),
              ],
            }),
          ],
        })}
      />,
    );

    expect(screen.getByText("deep thought")).toBeInTheDocument();
  });

  it("shows a failed model turn as an error, with the error text", () => {
    render(
      <ToolCallRow
        event={tool({
          name: "research_agent",
          delegation: "research_agent",
          children: [
            modelTurn({ id: "m3", status: "error", error: "RateLimitError: 429", text: "" }),
          ],
        })}
      />,
    );

    const turn = within(screen.getByTestId("trace-assistant"));
    expect(turn.getByText("error")).toBeInTheDocument();
    expect(turn.getByText("RateLimitError: 429")).toBeInTheDocument();
    expect(turn.getByRole("button", { name: "Copy error" })).toBeInTheDocument();
  });

  it("copes with a model turn that has no model, usage or timing recorded", () => {
    render(
      <ToolCallRow
        event={tool({
          name: "research_agent",
          delegation: "research_agent",
          children: [
            modelTurn({
              id: "bare",
              model: null,
              usage: null,
              duration_ms: null,
              started_at: null,
              ended_at: null,
            }),
          ],
        })}
      />,
    );

    const meta = within(screen.getByTestId("trace-model-meta"));
    expect(meta.getByText("research_agent")).toBeInTheDocument();
    expect(screen.getByText("I'll search for flights first.")).toBeInTheDocument();
  });

  it("keeps an inner call open when the delegation is reloaded with an earlier step added", async () => {
    const user = userEvent.setup();
    const call = tool({
      id: "c1",
      agent: "research_agent",
      name: "web_search",
      output: "3 results",
    });
    const before = tool({
      id: "d1",
      name: "research_agent",
      delegation: "research_agent",
      children: [modelTurn({ id: "m1" }), call],
    });
    const { rerender } = render(<ToolCallRow event={before} />);
    await user.click(screen.getByRole("button", { name: /web_search/ }));
    expect(screen.getByText("3 results")).toBeInTheDocument();

    rerender(
      <ToolCallRow
        event={{
          ...before,
          children: [
            modelTurn({ id: "m0", text: "an earlier thought" }),
            modelTurn({ id: "m1" }),
            call,
          ],
        }}
      />,
    );

    expect(screen.getByText("an earlier thought")).toBeInTheDocument();
    // Still open: its state followed its id, not its position in the list.
    expect(screen.getByText("3 results")).toBeInTheDocument();
  });

  it("shows an inner step it doesn't recognize whole, instead of dropping it", async () => {
    const user = userEvent.setup();
    const future = { kind: "reasoning_summary", id: "x1", detail: "new backend field" } as never;
    render(
      <ToolCallRow
        event={tool({
          name: "research_agent",
          delegation: "research_agent",
          children: [future],
        })}
      />,
    );

    const unknown = screen.getByTestId("trace-unknown");
    expect(within(unknown).getByText("reasoning_summary")).toBeInTheDocument();
    await user.click(within(unknown).getByRole("button", { name: "raw" }));
    expect(within(unknown).getByText(/new backend field/)).toBeInTheDocument();
  });

  it("contains a malformed inner step to itself", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ToolCallRow
        event={tool({
          name: "research_agent",
          delegation: "research_agent",
          children: [null as never, tool({ id: "ok", agent: "research_agent", name: "web_fetch" })],
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't display this step");
    expect(screen.getByRole("button", { name: /web_fetch/ })).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
