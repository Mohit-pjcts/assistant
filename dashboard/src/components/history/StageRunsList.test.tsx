import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StageRunsList } from "./StageRunsList";
import { stageDetail, stageSummary } from "./testFixtures";
import * as api from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, fetchStageRuns: vi.fn(), fetchStageRun: vi.fn() };
});

const mockedFetchStageRuns = vi.mocked(api.fetchStageRuns);
const mockedFetchStageRun = vi.mocked(api.fetchStageRun);

const hotkeyRun = stageSummary({
  run_id: "run-hotkey-1",
  source: "hotkey",
  command: "open calculator",
  status: "finished",
  totals: {
    tasks: 1,
    done: 1,
    failed: 0,
    seconds: 4.5,
    decisionsUsd: 0,
    helperUsd: 0.0021,
    decisions: 3,
    actions: 3,
    medianDecideMs: 5,
  },
  tasks: [],
});

const apiRun = stageSummary({ run_id: "run-api-2", source: "api", command: "make a note" });

const oldRun = stageSummary({
  run_id: "run-old-3",
  source: null,
  client_run_id: null,
  command: "an old run from before sources were logged",
  status: "unfinished",
  totals: null,
  ended_at: null,
  tasks: [],
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("StageRunsList", () => {
  it("lists every run, in the order given, with where it came from and how it went", async () => {
    mockedFetchStageRuns.mockResolvedValue({ runs: [apiRun, hotkeyRun, oldRun], next: null });

    render(<StageRunsList />);

    const rows = await screen.findAllByTestId("stage-run-row");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => within(row).getByTestId("stage-source").textContent)).toEqual([
      "api",
      "hotkey",
      "unknown",
    ]);
    expect(within(rows[0]).getByText("make a note")).toBeInTheDocument();
    expect(within(rows[0]).getByText("partial")).toBeInTheDocument();
    expect(within(rows[0]).getByText("1/2 tasks")).toBeInTheDocument();
    expect(within(rows[0]).getByText("13.9 s")).toBeInTheDocument();
    expect(within(rows[0]).getByText("$0.00131")).toBeInTheDocument();

    expect(within(rows[1]).getByText("done")).toBeInTheDocument();
    expect(within(rows[1]).getByText("4.5 s")).toBeInTheDocument();
    expect(within(rows[1]).getByText("$0.0021")).toBeInTheDocument();

    expect(within(rows[2]).getByText("unfinished")).toBeInTheDocument();
  });

  it("asks for the first page of 50", async () => {
    mockedFetchStageRuns.mockResolvedValue({ runs: [], next: null });

    render(<StageRunsList />);

    await waitFor(() => expect(mockedFetchStageRuns).toHaveBeenCalledWith({ limit: 50 }));
  });

  it("opens a run on click, fetching its full log only then", async () => {
    const user = userEvent.setup();
    mockedFetchStageRuns.mockResolvedValue({ runs: [apiRun], next: null });
    mockedFetchStageRun.mockResolvedValue(stageDetail());

    render(<StageRunsList />);
    const row = await screen.findByTestId("stage-run-row");
    expect(mockedFetchStageRun).not.toHaveBeenCalled();

    const toggle = within(row).getByRole("button", { name: /make a note/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await within(row).findByTestId("stage-run-view")).toBeInTheDocument();
    expect(mockedFetchStageRun).toHaveBeenCalledWith("run-api-2");
    expect(within(row).getAllByTestId("stage-task")).toHaveLength(2);
  });

  it("closes an opened run again", async () => {
    const user = userEvent.setup();
    mockedFetchStageRuns.mockResolvedValue({ runs: [apiRun], next: null });
    mockedFetchStageRun.mockResolvedValue(stageDetail());

    render(<StageRunsList />);
    const toggle = await screen.findByRole("button", { name: /make a note/ });
    await user.click(toggle);
    await screen.findByTestId("stage-run-view");

    await user.click(toggle);

    expect(screen.queryByTestId("stage-run-view")).not.toBeInTheDocument();
  });

  it("shows an empty state when Stage has no runs", async () => {
    mockedFetchStageRuns.mockResolvedValue({ runs: [], next: null });

    render(<StageRunsList />);

    expect(await screen.findByText("No Stage runs yet.")).toBeInTheDocument();
  });

  describe("paging", () => {
    it("offers 'Load more' only while the backend says there is more", async () => {
      mockedFetchStageRuns.mockResolvedValue({ runs: [apiRun], next: null });

      render(<StageRunsList />);
      await screen.findByTestId("stage-run-row");

      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    });

    it("loads the next page with the cursor and appends it", async () => {
      const user = userEvent.setup();
      mockedFetchStageRuns
        .mockResolvedValueOnce({ runs: [apiRun], next: "run-api-2" })
        .mockResolvedValueOnce({ runs: [hotkeyRun], next: null });

      render(<StageRunsList />);
      await screen.findByTestId("stage-run-row");

      await user.click(screen.getByRole("button", { name: "Load more" }));

      await waitFor(() => expect(screen.getAllByTestId("stage-run-row")).toHaveLength(2));
      expect(mockedFetchStageRuns).toHaveBeenLastCalledWith({ limit: 50, before: "run-api-2" });
      expect(screen.getByText("open calculator")).toBeInTheDocument();
      // The older run lands after the newer one, and there's nothing further to load.
      expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    });

    it("doesn't show a run twice when a page boundary shifts under it", async () => {
      const user = userEvent.setup();
      mockedFetchStageRuns
        .mockResolvedValueOnce({ runs: [apiRun], next: "run-api-2" })
        .mockResolvedValueOnce({ runs: [apiRun, hotkeyRun], next: null });

      render(<StageRunsList />);
      await screen.findByTestId("stage-run-row");
      await user.click(screen.getByRole("button", { name: "Load more" }));

      await waitFor(() => expect(screen.getAllByTestId("stage-run-row")).toHaveLength(2));
    });
  });

  describe("failure states", () => {
    it("explains a 403 plainly", async () => {
      mockedFetchStageRuns.mockRejectedValue(new api.HistoryForbiddenError("403"));

      render(<StageRunsList />);

      expect(await screen.findByText(/only available on this Mac/i)).toBeInTheDocument();
      expect(screen.queryByText("No Stage runs yet.")).not.toBeInTheDocument();
    });

    it("shows any other error", async () => {
      mockedFetchStageRuns.mockRejectedValue(new Error("/stage/runs failed (500): disk on fire"));

      render(<StageRunsList />);

      expect(await screen.findByText(/disk on fire/)).toBeInTheDocument();
    });
  });

  it("shows a run with malformed data as an error in its own row, not a blank window", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...apiRun, run_id: "run-broken", totals: null, tasks: undefined } as never;
    mockedFetchStageRuns.mockResolvedValue({ runs: [broken, hotkeyRun], next: null });

    render(<StageRunsList />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't display this Stage run");
    expect(screen.getByText("open calculator")).toBeInTheDocument();
  });

  it("refetches the first page when Refresh is clicked", async () => {
    const user = userEvent.setup();
    mockedFetchStageRuns.mockResolvedValueOnce({ runs: [apiRun], next: null });

    render(<StageRunsList />);
    await screen.findByText("make a note");

    mockedFetchStageRuns.mockResolvedValueOnce({ runs: [hotkeyRun], next: null });
    await user.click(screen.getByRole("button", { name: /refresh/i }));

    expect(await screen.findByText("open calculator")).toBeInTheDocument();
    expect(screen.queryByText("make a note")).not.toBeInTheDocument();
  });
});
