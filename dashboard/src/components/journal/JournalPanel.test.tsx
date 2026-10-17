import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JournalPanel } from "./JournalPanel";
import * as api from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchDiaryEntries: vi.fn(),
    saveDiaryEntry: vi.fn(),
    deleteDiaryEntry: vi.fn(),
  };
});

const mockedFetchDiaryEntries = vi.mocked(api.fetchDiaryEntries);
const mockedSaveDiaryEntry = vi.mocked(api.saveDiaryEntry);
const mockedDeleteDiaryEntry = vi.mocked(api.deleteDiaryEntry);

function todayIso(): string {
  return new Date().toLocaleDateString("en-CA");
}

const pastEntry = {
  date: "2026-09-01",
  content: "Started journaling with Oni today.",
  created_at: "2026-09-01T00:00:00+00:00",
  updated_at: null,
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("JournalPanel", () => {
  it("shows an empty state when there are no entries yet", async () => {
    mockedFetchDiaryEntries.mockResolvedValue([]);

    render(<JournalPanel />);

    expect(await screen.findByText(/no diary entries yet/i)).toBeInTheDocument();
  });

  it("shows a fetch error instead of a blank panel", async () => {
    mockedFetchDiaryEntries.mockRejectedValue(new Error("vault unreachable"));

    render(<JournalPanel />);

    expect(await screen.findByText(/vault unreachable/)).toBeInTheDocument();
  });

  it("lists past entries and pre-fills today's editor when one already exists", async () => {
    const todayEntry = {
      ...pastEntry,
      date: todayIso(),
      content: "Already wrote something today.",
    };
    mockedFetchDiaryEntries.mockResolvedValue([todayEntry, pastEntry]);

    render(<JournalPanel />);

    expect(await screen.findByText(pastEntry.content)).toBeInTheDocument();
    expect(screen.getByTestId("journal-entry-input")).toHaveValue(todayEntry.content);
  });

  it("saves a new entry and disables Save again until the text changes", async () => {
    const user = userEvent.setup();
    mockedFetchDiaryEntries.mockResolvedValue([]);
    mockedSaveDiaryEntry.mockResolvedValue({
      date: todayIso(),
      content: "First entry.",
      created_at: "2026-09-28T00:00:00+00:00",
      updated_at: null,
    });

    render(<JournalPanel />);
    await screen.findByText(/no diary entries yet/i);

    await user.type(screen.getByTestId("journal-entry-input"), "First entry.");
    await user.click(screen.getByTestId("journal-save-button"));

    expect(mockedSaveDiaryEntry).toHaveBeenCalledWith("First entry.", todayIso());
    expect(await screen.findByText(/^saved$/i)).toBeInTheDocument();
    expect(screen.getByTestId("journal-save-button")).toBeDisabled();
  });

  it("loads a past entry into the editor when clicked, and 'Back to today' returns", async () => {
    const user = userEvent.setup();
    mockedFetchDiaryEntries.mockResolvedValue([pastEntry]);

    render(<JournalPanel />);
    await screen.findByText(pastEntry.content);

    await user.click(screen.getByText(pastEntry.content));
    expect(screen.getByTestId("journal-entry-input")).toHaveValue(pastEntry.content);
    expect(screen.getByText(/past entry/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back to today/i }));
    expect(screen.getByTestId("journal-entry-input")).toHaveValue("");
  });

  it("requires confirmation before deleting — clicking Delete alone does not call the API", async () => {
    const user = userEvent.setup();
    mockedFetchDiaryEntries.mockResolvedValue([pastEntry]);

    render(<JournalPanel />);
    await screen.findByText(pastEntry.content);

    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(mockedDeleteDiaryEntry).not.toHaveBeenCalled();
  });

  it("deletes an entry once confirmed", async () => {
    const user = userEvent.setup();
    mockedFetchDiaryEntries.mockResolvedValue([pastEntry]);
    mockedDeleteDiaryEntry.mockResolvedValue(undefined);

    render(<JournalPanel />);
    await screen.findByText(pastEntry.content);

    await user.click(screen.getByRole("button", { name: /^delete$/i }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    expect(mockedDeleteDiaryEntry).toHaveBeenCalledWith(pastEntry.date);
  });
});
