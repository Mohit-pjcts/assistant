import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActiveTurnBanner } from "./ActiveTurnBanner";
import * as api from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchActiveTurns: vi.fn(),
    fetchLiveClaudeCodeSessions: vi.fn(),
    stopClaudeCodeSession: vi.fn(),
  };
});

const mockedFetchActiveTurns = vi.mocked(api.fetchActiveTurns);
const mockedFetchLiveClaudeCodeSessions = vi.mocked(api.fetchLiveClaudeCodeSessions);
const mockedStopClaudeCodeSession = vi.mocked(api.stopClaudeCodeSession);

const liveSession: api.LiveClaudeCodeSession = {
  session_id: "session-a",
  prompt_preview: "Fix the failing test in test_disk_tools.py",
  elapsed_seconds: 45,
};

const runningTurn: api.ActiveTurnInfo = {
  thread_id: "t1",
  channel: "voice",
  agent: "supervisor",
  elapsed_seconds: 12,
  seconds_since_update: 1,
  step_count: 2,
  current_tool: "web_search",
  consecutive_failures: 0,
  stuck: false,
};

const stuckTurn: api.ActiveTurnInfo = {
  thread_id: "t2",
  channel: "dashboard",
  agent: "supervisor",
  elapsed_seconds: 105,
  seconds_since_update: 2,
  step_count: 4,
  current_tool: "render_ui",
  consecutive_failures: 4,
  stuck: true,
};

const erroredTurn: api.RecentlyEndedTurn = {
  thread_id: "t3",
  channel: "phone",
  agent: "phone_agent",
  outcome: "error",
  elapsed_seconds: 8,
  seconds_since_ended: 5,
};

const cancelledTurn: api.RecentlyEndedTurn = {
  thread_id: "t4",
  channel: "voice",
  agent: "supervisor",
  outcome: "cancelled",
  elapsed_seconds: 3,
  seconds_since_ended: 2,
};

const completedTurn: api.RecentlyEndedTurn = {
  thread_id: "t5",
  channel: "automation",
  agent: "life_admin_agent",
  outcome: "completed",
  elapsed_seconds: 4,
  seconds_since_ended: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  mockedFetchLiveClaudeCodeSessions.mockResolvedValue([]);
});

describe("ActiveTurnBanner", () => {
  it("renders nothing when no turn is active and nothing recently ended abnormally", async () => {
    mockedFetchActiveTurns.mockResolvedValue({ active: [], recentlyEnded: [] });

    const { container } = render(<ActiveTurnBanner />);

    // Wait for the initial fetch to resolve before asserting emptiness.
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a running turn with its channel, agent, and elapsed time", async () => {
    mockedFetchActiveTurns.mockResolvedValue({ active: [runningTurn], recentlyEnded: [] });

    render(<ActiveTurnBanner />);

    expect(await screen.findByTestId("active-turn-running")).toBeInTheDocument();
    expect(screen.getByText("Voice")).toBeInTheDocument();
    expect(screen.getByText("supervisor")).toBeInTheDocument();
    expect(screen.getByText("web_search")).toBeInTheDocument();
    expect(screen.getByText("12s")).toBeInTheDocument();
    expect(screen.queryByTestId("active-turn-stuck")).not.toBeInTheDocument();
  });

  it("visibly flags a stuck (repeatedly-retrying) turn, distinct from a normal one", async () => {
    mockedFetchActiveTurns.mockResolvedValue({ active: [stuckTurn], recentlyEnded: [] });

    render(<ActiveTurnBanner />);

    expect(await screen.findByTestId("active-turn-stuck")).toBeInTheDocument();
    expect(screen.getByText(/retried 4x in a row, may be stuck/)).toBeInTheDocument();
    expect(screen.getByText("1m 45s")).toBeInTheDocument();
  });

  // The actual follow-up this file is here for: a turn started on a
  // channel other than this browser tab (phone/voice/automation) that
  // ended abnormally must not just silently vanish — this is the ONLY
  // place a turn like that ever becomes visible to someone not watching
  // that specific channel when it happened.
  it("shows a phone turn that ended with an error, distinct from a currently-running one", async () => {
    mockedFetchActiveTurns.mockResolvedValue({ active: [], recentlyEnded: [erroredTurn] });

    render(<ActiveTurnBanner />);

    expect(await screen.findByTestId("recently-ended-error")).toBeInTheDocument();
    expect(screen.getByText("Phone")).toBeInTheDocument();
    expect(screen.getByText("phone_agent")).toBeInTheDocument();
    expect(screen.getByText("ended with an error")).toBeInTheDocument();
    expect(screen.queryByTestId("active-turn-running")).not.toBeInTheDocument();
  });

  it("shows a cancelled turn distinctly from an errored one", async () => {
    mockedFetchActiveTurns.mockResolvedValue({ active: [], recentlyEnded: [cancelledTurn] });

    render(<ActiveTurnBanner />);

    expect(await screen.findByTestId("recently-ended-cancelled")).toBeInTheDocument();
    expect(screen.getByText("cancelled")).toBeInTheDocument();
    expect(screen.queryByTestId("recently-ended-error")).not.toBeInTheDocument();
  });

  it("does not show a notice for a turn that completed normally", async () => {
    mockedFetchActiveTurns.mockResolvedValue({ active: [], recentlyEnded: [completedTurn] });

    const { container } = render(<ActiveTurnBanner />);

    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a running turn and a recently-failed turn together", async () => {
    mockedFetchActiveTurns.mockResolvedValue({
      active: [runningTurn],
      recentlyEnded: [erroredTurn],
    });

    render(<ActiveTurnBanner />);

    expect(await screen.findByTestId("active-turn-running")).toBeInTheDocument();
    expect(screen.getByTestId("recently-ended-error")).toBeInTheDocument();
  });

  // STEPS.md 149: a run_claude_code session can run up to 30 min fully
  // unattended — this is the same standing "never let a background
  // process run silently" rule as the turn-visibility tests above, for a
  // real OS subprocess rather than a graph turn.
  it("shows a live Claude Code session with its prompt preview and elapsed time", async () => {
    mockedFetchActiveTurns.mockResolvedValue({ active: [], recentlyEnded: [] });
    mockedFetchLiveClaudeCodeSessions.mockResolvedValue([liveSession]);

    render(<ActiveTurnBanner />);

    expect(await screen.findByTestId("active-claude-code-session")).toBeInTheDocument();
    expect(screen.getByText(/Fix the failing test in test_disk_tools\.py/)).toBeInTheDocument();
    expect(screen.getByText("45s")).toBeInTheDocument();
  });

  it("calls stopClaudeCodeSession when its Stop button is clicked", async () => {
    const user = userEvent.setup();
    mockedFetchActiveTurns.mockResolvedValue({ active: [], recentlyEnded: [] });
    mockedFetchLiveClaudeCodeSessions.mockResolvedValue([liveSession]);
    mockedStopClaudeCodeSession.mockResolvedValue(undefined);

    render(<ActiveTurnBanner />);
    await user.click(await screen.findByRole("button", { name: /stop/i }));

    expect(mockedStopClaudeCodeSession).toHaveBeenCalledWith("session-a");
  });
});
