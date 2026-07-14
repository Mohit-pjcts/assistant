import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryPanel } from "./MemoryPanel";
import * as api from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, fetchMemoryFacts: vi.fn(), deleteMemoryFact: vi.fn() };
});

const mockedFetchMemoryFacts = vi.mocked(api.fetchMemoryFacts);
const mockedDeleteMemoryFact = vi.mocked(api.deleteMemoryFact);

const sampleFact = {
  id: 42,
  content: "User prefers window seats when flying.",
  provenance: null,
  created_at: "2026-07-14T00:00:00+00:00",
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("MemoryPanel", () => {
  it("lists stored facts verbatim", async () => {
    mockedFetchMemoryFacts.mockResolvedValue([sampleFact]);

    render(<MemoryPanel />);

    expect(await screen.findByText(sampleFact.content)).toBeInTheDocument();
    expect(screen.getByText(sampleFact.created_at)).toBeInTheDocument();
  });

  it("shows an empty state when there are no facts", async () => {
    mockedFetchMemoryFacts.mockResolvedValue([]);

    render(<MemoryPanel />);

    expect(await screen.findByText(/no facts stored yet/i)).toBeInTheDocument();
  });

  it("shows a fetch error instead of a blank panel", async () => {
    mockedFetchMemoryFacts.mockRejectedValue(new Error("db unreachable"));

    render(<MemoryPanel />);

    expect(await screen.findByText(/db unreachable/)).toBeInTheDocument();
  });

  it("requires confirmation before deleting — clicking Delete alone does not call the API", async () => {
    const user = userEvent.setup();
    mockedFetchMemoryFacts.mockResolvedValue([sampleFact]);

    render(<MemoryPanel />);
    await screen.findByText(sampleFact.content);

    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    // The confirm dialog is now open, but nothing has been deleted yet.
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(mockedDeleteMemoryFact).not.toHaveBeenCalled();
    expect(screen.getByText(sampleFact.content)).toBeInTheDocument();
  });

  it("cancelling the confirm dialog leaves the fact in place", async () => {
    const user = userEvent.setup();
    mockedFetchMemoryFacts.mockResolvedValue([sampleFact]);

    render(<MemoryPanel />);
    await screen.findByText(sampleFact.content);
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    expect(mockedDeleteMemoryFact).not.toHaveBeenCalled();
    expect(screen.getByText(sampleFact.content)).toBeInTheDocument();
  });

  it("confirming the dialog calls deleteMemoryFact and removes the row", async () => {
    const user = userEvent.setup();
    mockedFetchMemoryFacts.mockResolvedValue([sampleFact]);
    mockedDeleteMemoryFact.mockResolvedValue(undefined);

    render(<MemoryPanel />);
    await screen.findByText(sampleFact.content);
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(mockedDeleteMemoryFact).toHaveBeenCalledWith(sampleFact.id));
    await waitFor(() => expect(screen.queryByText(sampleFact.content)).not.toBeInTheDocument());
  });

  it("shows an error and keeps the fact if deletion fails", async () => {
    const user = userEvent.setup();
    mockedFetchMemoryFacts.mockResolvedValue([sampleFact]);
    mockedDeleteMemoryFact.mockRejectedValue(new Error("delete failed"));

    render(<MemoryPanel />);
    await screen.findByText(sampleFact.content);
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByText(/delete failed/)).toBeInTheDocument();
    expect(screen.getByText(sampleFact.content)).toBeInTheDocument();
  });

  it("refetches when Refresh is clicked", async () => {
    const user = userEvent.setup();
    mockedFetchMemoryFacts.mockResolvedValue([sampleFact]);

    render(<MemoryPanel />);
    await screen.findByText(sampleFact.content);
    expect(mockedFetchMemoryFacts).toHaveBeenCalledTimes(1);

    mockedFetchMemoryFacts.mockResolvedValue([]);
    await user.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(mockedFetchMemoryFacts).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/no facts stored yet/i)).toBeInTheDocument();
  });
});
