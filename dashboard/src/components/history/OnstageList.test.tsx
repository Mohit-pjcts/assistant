import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OnstageList } from "./OnstageList";
import { onstageEntry } from "./testFixtures";
import * as api from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, fetchOnstageJournal: vi.fn() };
});

const mockedFetchOnstageJournal = vi.mocked(api.fetchOnstageJournal);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("OnstageList", () => {
  it("shows each question with where it was asked and every spoken step, in order", async () => {
    mockedFetchOnstageJournal.mockResolvedValue([onstageEntry()]);

    render(<OnstageList />);

    const entry = within(await screen.findByTestId("onstage-entry"));
    expect(entry.getByText("what does this button do?")).toBeInTheDocument();
    expect(entry.getByText("Calendar · Week of Oct 4")).toBeInTheDocument();
    const steps = entry.getAllByTestId("onstage-step");
    expect(steps).toHaveLength(2);
    expect(within(steps[0]).getByText("1.")).toBeInTheDocument();
    expect(within(steps[0]).getByText("That's the Today button.")).toBeInTheDocument();
    expect(within(steps[1]).getByText("2.")).toBeInTheDocument();
    expect(within(steps[1]).getByText("It jumps back to the current week.")).toBeInTheDocument();
  });

  it("notes how many shapes a step drew, and nothing for a step that drew none", async () => {
    mockedFetchOnstageJournal.mockResolvedValue([onstageEntry()]);

    render(<OnstageList />);

    const steps = await screen.findAllByTestId("onstage-step");
    expect(within(steps[0]).getByText("1 drawn")).toBeInTheDocument();
    expect(within(steps[1]).queryByText(/drawn/)).not.toBeInTheDocument();
  });

  it("shows the model, cost and timings", async () => {
    mockedFetchOnstageJournal.mockResolvedValue([onstageEntry()]);

    render(<OnstageList />);

    expect(
      await screen.findByText(
        "claude-haiku · 41 controls seen · capture 340 ms · answer 2.1 s · $0.00231",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the whole journal line behind a raw toggle", async () => {
    const user = userEvent.setup();
    mockedFetchOnstageJournal.mockResolvedValue([onstageEntry({ extra_field: "kept" })]);

    render(<OnstageList />);
    const entry = within(await screen.findByTestId("onstage-entry"));

    await user.click(entry.getByRole("button", { name: "raw" }));

    expect(entry.getByText(/"extra_field": "kept"/)).toBeInTheDocument();
    expect(entry.getByText(/"captureMs": 340/)).toBeInTheDocument();
  });

  it("copes with an entry that has no steps, app or numbers", async () => {
    mockedFetchOnstageJournal.mockResolvedValue([
      { t: "2026-10-04T19:20:00.000Z", question: "bare question" },
    ]);

    render(<OnstageList />);

    expect(await screen.findByText("bare question")).toBeInTheDocument();
    expect(screen.queryByTestId("onstage-step")).not.toBeInTheDocument();
  });

  it("lists entries in the order given (the backend sends newest first)", async () => {
    mockedFetchOnstageJournal.mockResolvedValue([
      onstageEntry({ question: "newer one" }),
      onstageEntry({ question: "older one", t: "2026-10-03T10:00:00.000Z" }),
    ]);

    render(<OnstageList />);

    const entries = await screen.findAllByTestId("onstage-entry");
    expect(within(entries[0]).getByText("newer one")).toBeInTheDocument();
    expect(within(entries[1]).getByText("older one")).toBeInTheDocument();
  });

  it("shows an entry with malformed data as an error in its own card", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { t: "2026-10-04T19:20:00.000Z", question: "x", steps: "not a list" } as never;
    mockedFetchOnstageJournal.mockResolvedValue([broken, onstageEntry({ question: "fine one" })]);

    render(<OnstageList />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't display this Onstage entry",
    );
    expect(screen.getByText("fine one")).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    mockedFetchOnstageJournal.mockResolvedValue([]);

    render(<OnstageList />);

    expect(await screen.findByText("No Onstage questions yet.")).toBeInTheDocument();
  });

  it("explains a 403 plainly", async () => {
    mockedFetchOnstageJournal.mockRejectedValue(new api.HistoryForbiddenError("403"));

    render(<OnstageList />);

    expect(await screen.findByText(/only available on this Mac/i)).toBeInTheDocument();
  });

  it("shows any other error", async () => {
    mockedFetchOnstageJournal.mockRejectedValue(new Error("journal unreadable"));

    render(<OnstageList />);

    expect(await screen.findByText(/journal unreadable/)).toBeInTheDocument();
  });

  it("refetches on Refresh", async () => {
    const user = userEvent.setup();
    mockedFetchOnstageJournal.mockResolvedValueOnce([onstageEntry({ question: "first" })]);

    render(<OnstageList />);
    await screen.findByText("first");

    mockedFetchOnstageJournal.mockResolvedValueOnce([onstageEntry({ question: "second" })]);
    await user.click(screen.getByRole("button", { name: /refresh/i }));

    expect(await screen.findByText("second")).toBeInTheDocument();
    expect(mockedFetchOnstageJournal).toHaveBeenCalledTimes(2);
  });
});
