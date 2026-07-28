import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryPanel } from "./MemoryPanel";
import * as api from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchMemoryFacts: vi.fn(),
    deleteMemoryFact: vi.fn(),
    createMemoryFact: vi.fn(),
    updateMemoryFact: vi.fn(),
    fetchPendingFacts: vi.fn(),
    approvePendingFact: vi.fn(),
    declinePendingFact: vi.fn(),
    triggerMemoryReview: vi.fn(),
  };
});

const mockedFetchMemoryFacts = vi.mocked(api.fetchMemoryFacts);
const mockedDeleteMemoryFact = vi.mocked(api.deleteMemoryFact);
const mockedCreateMemoryFact = vi.mocked(api.createMemoryFact);
const mockedUpdateMemoryFact = vi.mocked(api.updateMemoryFact);
const mockedFetchPendingFacts = vi.mocked(api.fetchPendingFacts);
const mockedApprovePendingFact = vi.mocked(api.approvePendingFact);
const mockedDeclinePendingFact = vi.mocked(api.declinePendingFact);
const mockedTriggerMemoryReview = vi.mocked(api.triggerMemoryReview);

const sampleFact = {
  id: 42,
  content: "User prefers window seats when flying.",
  provenance: null,
  created_at: "2026-07-14T00:00:00+00:00",
};

const samplePending = {
  id: 7,
  content: "user is vegetarian",
  provenance: "nightly review",
  created_at: "2026-07-28T00:00:00+00:00",
};

beforeEach(() => {
  vi.resetAllMocks();
  // Every render calls load(), which fetches both facts and pending
  // proposals together — default pending to empty so tests that don't
  // care about the review queue aren't forced to mock it individually.
  mockedFetchPendingFacts.mockResolvedValue([]);
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

  it("adds a user-typed fact and shows it without a fetch round trip", async () => {
    const user = userEvent.setup();
    mockedFetchMemoryFacts.mockResolvedValue([]);
    mockedCreateMemoryFact.mockResolvedValue({
      id: 99,
      content: "user's favorite color is teal",
      provenance: "user",
      created_at: "2026-07-28T00:00:00+00:00",
    });

    render(<MemoryPanel />);
    await screen.findByText(/no facts stored yet/i);

    await user.type(screen.getByTestId("new-fact-input"), "user's favorite color is teal");
    await user.click(screen.getByTestId("new-fact-submit"));

    await waitFor(() =>
      expect(mockedCreateMemoryFact).toHaveBeenCalledWith("user's favorite color is teal"),
    );
    expect(await screen.findByText("user's favorite color is teal")).toBeInTheDocument();
  });

  it("edits an existing fact in place", async () => {
    const user = userEvent.setup();
    mockedFetchMemoryFacts.mockResolvedValue([sampleFact]);
    mockedUpdateMemoryFact.mockResolvedValue(undefined);

    render(<MemoryPanel />);
    await screen.findByText(sampleFact.content);

    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    const editBox = screen.getByTestId("edit-fact-input");
    await user.clear(editBox);
    await user.type(editBox, "User prefers aisle seats when flying.");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(mockedUpdateMemoryFact).toHaveBeenCalledWith(
        sampleFact.id,
        "User prefers aisle seats when flying.",
      ),
    );
    expect(await screen.findByText("User prefers aisle seats when flying.")).toBeInTheDocument();
  });

  it("cancelling an edit leaves the original content in place", async () => {
    const user = userEvent.setup();
    mockedFetchMemoryFacts.mockResolvedValue([sampleFact]);

    render(<MemoryPanel />);
    await screen.findByText(sampleFact.content);

    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    const editBox = screen.getByTestId("edit-fact-input");
    await user.clear(editBox);
    await user.type(editBox, "something else entirely");
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(mockedUpdateMemoryFact).not.toHaveBeenCalled();
    expect(screen.getByText(sampleFact.content)).toBeInTheDocument();
  });

  it("shows pending review cards from the nightly scan", async () => {
    mockedFetchMemoryFacts.mockResolvedValue([]);
    mockedFetchPendingFacts.mockResolvedValue([samplePending]);

    render(<MemoryPanel />);

    expect(await screen.findByText(samplePending.content)).toBeInTheDocument();
    expect(screen.getByText(/source: nightly review/i)).toBeInTheDocument();
  });

  it("approving a pending fact saves it and moves it out of the review queue", async () => {
    const user = userEvent.setup();
    mockedFetchMemoryFacts.mockResolvedValue([]);
    mockedFetchPendingFacts.mockResolvedValue([samplePending]);
    mockedApprovePendingFact.mockResolvedValue({
      id: 101,
      content: samplePending.content,
      provenance: samplePending.provenance,
      created_at: samplePending.created_at,
    });

    render(<MemoryPanel />);
    await screen.findByText(samplePending.content);

    await user.click(screen.getByRole("button", { name: /^approve$/i }));

    await waitFor(() => expect(mockedApprovePendingFact).toHaveBeenCalledWith(samplePending.id));
    // Moved into the real facts list, and the pending card (with its
    // Approve/Decline pair) is gone — only the one row is left.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument(),
    );
    expect(screen.getByText(samplePending.content)).toBeInTheDocument();
  });

  it("declining a pending fact discards it without saving", async () => {
    const user = userEvent.setup();
    mockedFetchMemoryFacts.mockResolvedValue([]);
    mockedFetchPendingFacts.mockResolvedValue([samplePending]);
    mockedDeclinePendingFact.mockResolvedValue(undefined);

    render(<MemoryPanel />);
    await screen.findByText(samplePending.content);

    await user.click(screen.getByRole("button", { name: /^decline$/i }));

    await waitFor(() => expect(mockedDeclinePendingFact).toHaveBeenCalledWith(samplePending.id));
    await waitFor(() => expect(screen.queryByText(samplePending.content)).not.toBeInTheDocument());
    expect(mockedApprovePendingFact).not.toHaveBeenCalled();
  });

  it("Check now triggers a review pass and refreshes the pending queue", async () => {
    const user = userEvent.setup();
    mockedFetchMemoryFacts.mockResolvedValue([]);
    mockedFetchPendingFacts.mockResolvedValueOnce([]).mockResolvedValueOnce([samplePending]);
    mockedTriggerMemoryReview.mockResolvedValue(1);

    render(<MemoryPanel />);
    await screen.findByText(/no facts stored yet/i);

    await user.click(screen.getByTestId("memory-check-now"));

    await waitFor(() => expect(mockedTriggerMemoryReview).toHaveBeenCalled());
    expect(await screen.findByText(samplePending.content)).toBeInTheDocument();
  });
});
