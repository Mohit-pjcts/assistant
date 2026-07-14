import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPanel } from "./ChatPanel";
import * as api from "@/lib/api";

// No way to visually verify a real Tauri window from an agent session
// (STEPS.md 56) — this is the real behavioral verification for the
// interrupt-gate UI instead: mocked-fetch component tests, not a
// screenshot. The Python side (assistant/server.py) is already verified
// against the real graph in tests/test_server.py; these tests verify the
// React side's CONTRACT with that server's response shapes is honored
// correctly, especially the load-bearing verbatim-fact requirement
// (STEPS.md 54).

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchHistory: vi.fn(),
    sendChat: vi.fn(),
    resumeChat: vi.fn(),
  };
});

const mockedFetchHistory = vi.mocked(api.fetchHistory);
const mockedSendChat = vi.mocked(api.sendChat);
const mockedResumeChat = vi.mocked(api.resumeChat);

beforeEach(() => {
  vi.resetAllMocks();
  mockedFetchHistory.mockResolvedValue([]);
});

describe("ChatPanel", () => {
  it("loads and displays existing history on mount", async () => {
    mockedFetchHistory.mockResolvedValue([
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ]);

    render(<ChatPanel />);

    expect(await screen.findByText("earlier question")).toBeInTheDocument();
    expect(await screen.findByText("earlier answer")).toBeInTheDocument();
  });

  it("hides synthetic graph-inserted messages (routing bridges, recalled facts, compaction summaries)", async () => {
    // Real shape server.py's /history returns (STEPS.md 57) — a routing
    // bridge carries role "user" but must never render as if the real user
    // typed it.
    mockedFetchHistory.mockResolvedValue([
      { role: "user", content: "real question from the user" },
      {
        role: "user",
        content: "[Routing note, not from the user] The specialist above has finished...",
        synthetic: true,
      },
      { role: "assistant", content: "real answer" },
    ]);

    render(<ChatPanel />);

    expect(await screen.findByText("real question from the user")).toBeInTheDocument();
    expect(await screen.findByText("real answer")).toBeInTheDocument();
    expect(screen.queryByText(/Routing note, not from the user/)).not.toBeInTheDocument();
  });

  it("sends a message and renders the assistant's reply", async () => {
    const user = userEvent.setup();
    mockedSendChat.mockResolvedValue({ type: "message", content: "pong" });

    render(<ChatPanel />);
    await waitFor(() => expect(mockedFetchHistory).toHaveBeenCalled());

    await user.type(screen.getByPlaceholderText(/message the assistant/i), "ping");
    await user.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText("pong")).toBeInTheDocument();
    expect(screen.getByText("ping")).toBeInTheDocument();
    expect(mockedSendChat).toHaveBeenCalledWith("ping");
  });

  it("shows the interrupt gate for a generic gated tool and resolves on approve", async () => {
    const user = userEvent.setup();
    mockedSendChat.mockResolvedValue({
      type: "interrupt",
      payload: {
        action: "send_test_notification",
        message: "hello from test",
        spoken_prompt: "Permission to send a notification saying 'hello from test'?",
      },
    });
    mockedResumeChat.mockResolvedValue({ type: "message", content: "Notification sent." });

    render(<ChatPanel />);
    await waitFor(() => expect(mockedFetchHistory).toHaveBeenCalled());

    await user.type(screen.getByPlaceholderText(/message the assistant/i), "notify me");
    await user.click(screen.getByRole("button", { name: /send/i }));

    expect(
      await screen.findByText("Permission to send a notification saying 'hello from test'?"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /approve/i }));

    expect(mockedResumeChat).toHaveBeenCalledWith(true);
    expect(await screen.findByText("Notification sent.")).toBeInTheDocument();
    expect(screen.queryByTestId("interrupt-gate")).not.toBeInTheDocument();
  });

  it("shows a memory-write interrupt's fact VERBATIM, with no voice affordance, and resolves on decline", async () => {
    const user = userEvent.setup();
    const verbatimFact = "User prefers window seats when flying, especially on long-haul routes.";
    mockedSendChat.mockResolvedValue({
      type: "interrupt",
      payload: {
        action: "save_memory",
        fact: verbatimFact,
        provenance: null,
        voice_approvable: false,
      },
    });
    mockedResumeChat.mockResolvedValue({ type: "message", content: "Not saved." });

    render(<ChatPanel />);
    await waitFor(() => expect(mockedFetchHistory).toHaveBeenCalled());

    await user.type(screen.getByPlaceholderText(/message the assistant/i), "remember something");
    await user.click(screen.getByRole("button", { name: /send/i }));

    const factElement = await screen.findByTestId("interrupt-fact-verbatim");
    // Exact string match, not "contains" — this is the load-bearing
    // requirement (STEPS.md 54): no re-summarization, no truncation, no
    // markdown reinterpretation of the approved fact text.
    expect(factElement.textContent).toBe(verbatimFact);

    // The Phase 7 red-team requirement this gate must never violate: no
    // speak/voice affordance for a memory-write confirmation.
    expect(screen.queryByText(/speak/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/voice/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /decline/i }));

    expect(mockedResumeChat).toHaveBeenCalledWith(false);
    expect(await screen.findByText("Not saved.")).toBeInTheDocument();
  });
});
