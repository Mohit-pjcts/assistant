import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistoryPanel } from "./HistoryPanel";
import * as api from "@/lib/api";

// Unlike ChatPanel.test.tsx (which proves synthetic/tool/empty messages are
// HIDDEN), this proves HistoryPanel does the opposite on purpose: shows
// everything, honestly labeled. Both are real requirements from the same
// /history endpoint, for two different consumers (PLAN.md Phase 9 step 4).
//
// Thread management (list/switch/create/rename/delete) briefly lived
// inline in this panel, then moved to the persistent `ThreadSidebar` —
// see ThreadSidebar.test.tsx for that coverage.

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, fetchHistory: vi.fn() };
});

const mockedFetchHistory = vi.mocked(api.fetchHistory);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("HistoryPanel", () => {
  it("shows every message, including tool/system rows and empty-content turns the chat view hides", async () => {
    mockedFetchHistory.mockResolvedValue([
      { role: "user", content: "hello", synthetic: false, name: null },
      { role: "assistant", content: "", synthetic: false, name: "supervisor" },
      {
        role: "tool",
        content: "Transferred to coding_agent.",
        synthetic: false,
        name: "transfer_to_coding_agent",
      },
      { role: "assistant", content: "done", synthetic: false, name: "coding_agent" },
    ]);

    render(<HistoryPanel />);

    expect(await screen.findByText("hello")).toBeInTheDocument();
    expect(await screen.findByText("Transferred to coding_agent.")).toBeInTheDocument();
    expect(await screen.findByText("done")).toBeInTheDocument();
    // The empty-content assistant turn still gets a row (unlike ChatPanel).
    expect(screen.getByText("(empty)")).toBeInTheDocument();
    // The tool's actual name is surfaced as a label, not just the "tool" role.
    expect(screen.getByText("transfer_to_coding_agent")).toBeInTheDocument();
    expect(screen.getByText("coding_agent")).toBeInTheDocument();
    expect(screen.getAllByTestId("history-row")).toHaveLength(4);
  });

  it("labels synthetic (graph-inserted) messages as internal instead of hiding them", async () => {
    mockedFetchHistory.mockResolvedValue([
      { role: "user", content: "real question", synthetic: false, name: null },
      {
        role: "user",
        content: "[Routing note, not from the user] The specialist above has finished...",
        synthetic: true,
        name: null,
      },
    ]);

    render(<HistoryPanel />);

    expect(await screen.findByText("real question")).toBeInTheDocument();
    // Shown, not hidden — this is the key difference from ChatPanel.
    expect(await screen.findByText(/Routing note, not from the user/)).toBeInTheDocument();
    expect(screen.getByText("internal")).toBeInTheDocument();
  });

  it("refetches when the Refresh button is clicked", async () => {
    const user = userEvent.setup();
    mockedFetchHistory.mockResolvedValue([
      { role: "user", content: "first", synthetic: false, name: null },
    ]);

    render(<HistoryPanel />);
    expect(await screen.findByText("first")).toBeInTheDocument();
    expect(mockedFetchHistory).toHaveBeenCalledTimes(1);

    mockedFetchHistory.mockResolvedValue([
      { role: "user", content: "second", synthetic: false, name: null },
    ]);
    await user.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(mockedFetchHistory).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("second")).toBeInTheDocument();
  });

  it("shows an error message if the fetch fails", async () => {
    mockedFetchHistory.mockRejectedValue(new Error("network down"));

    render(<HistoryPanel />);

    expect(await screen.findByText(/network down/)).toBeInTheDocument();
  });
});
