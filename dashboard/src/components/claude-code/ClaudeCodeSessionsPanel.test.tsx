import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClaudeCodeSessionsPanel } from "./ClaudeCodeSessionsPanel";
import * as api from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchClaudeCodeSessions: vi.fn(),
    fetchClaudeCodeSession: vi.fn(),
  };
});

const mockedFetchSessions = vi.mocked(api.fetchClaudeCodeSessions);
const mockedFetchSession = vi.mocked(api.fetchClaudeCodeSession);

const sampleSession: api.ClaudeCodeSessionSummary = {
  session_id: "session-a",
  title: "Execute shell command and report output",
  prompt_preview: "Run echo hello and report the output.",
  started_at: "2026-08-06T11:50:36.000Z",
  ended_at: "2026-08-06T11:50:47.000Z",
  event_count: 12,
};

const sampleDetail: api.ClaudeCodeSessionDetail = {
  session_id: "session-a",
  title: "Execute shell command and report output",
  turns: [
    { role: "user", blocks: [{ type: "text", text: "Run echo hello" }], timestamp: null },
    {
      role: "assistant",
      blocks: [{ type: "tool_use", name: "Bash", input: { command: "echo hello" } }],
      timestamp: null,
    },
    {
      role: "user",
      blocks: [{ type: "tool_result", content: "hello", is_error: false }],
      timestamp: null,
    },
    { role: "assistant", blocks: [{ type: "text", text: "hello" }], timestamp: null },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ClaudeCodeSessionsPanel", () => {
  it("shows an empty state when there are no sessions", async () => {
    mockedFetchSessions.mockResolvedValue([]);

    render(<ClaudeCodeSessionsPanel />);

    expect(await screen.findByText(/no claude code sessions yet/i)).toBeInTheDocument();
  });

  it("lists a session with its title, preview, and event count", async () => {
    mockedFetchSessions.mockResolvedValue([sampleSession]);

    render(<ClaudeCodeSessionsPanel />);

    expect(await screen.findByText("Execute shell command and report output")).toBeInTheDocument();
    expect(screen.getByText("Run echo hello and report the output.")).toBeInTheDocument();
    expect(screen.getByText("12 events")).toBeInTheDocument();
  });

  it("fetches and shows the full transcript when a session row is clicked", async () => {
    const user = userEvent.setup({ delay: null });
    mockedFetchSessions.mockResolvedValue([sampleSession]);
    mockedFetchSession.mockResolvedValue(sampleDetail);

    render(<ClaudeCodeSessionsPanel />);
    await screen.findByText("Execute shell command and report output");

    await user.click(screen.getByRole("button"));

    expect(await screen.findByTestId("claude-code-session-detail")).toBeInTheDocument();
    expect(mockedFetchSession).toHaveBeenCalledWith("session-a");
    expect(screen.getByTestId("claude-code-tool-use")).toHaveTextContent("Bash");
    expect(screen.getByTestId("claude-code-tool-result")).toHaveTextContent("hello");
  });

  it("polls for new sessions automatically without a manual refresh action", async () => {
    mockedFetchSessions.mockResolvedValueOnce([]).mockResolvedValueOnce([sampleSession]);

    render(<ClaudeCodeSessionsPanel />);
    expect(await screen.findByText(/no claude code sessions yet/i)).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(4000);

    expect(await screen.findByText("Execute shell command and report output")).toBeInTheDocument();
    expect(mockedFetchSessions).toHaveBeenCalledTimes(2);
  });
});
