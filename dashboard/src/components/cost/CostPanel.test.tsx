import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CostPanel } from "./CostPanel";
import * as api from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, fetchCost: vi.fn() };
});

const mockedFetchCost = vi.mocked(api.fetchCost);

const emptyWindow = {
  run_count: 0,
  total_tokens: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_cost: 0,
  prompt_cost: 0,
  completion_cost: 0,
  stale: false,
  no_data: false,
  read_at: "2026-08-09T12:00:00.000Z",
};

const sampleStats = {
  project: "langfuse",
  windows: {
    today: {
      ...emptyWindow,
      run_count: 5,
      total_tokens: 12345,
      prompt_tokens: 10000,
      completion_tokens: 2345,
      total_cost: 1.2345,
    },
    week: {
      ...emptyWindow,
      run_count: 50,
      total_tokens: 123450,
      prompt_tokens: 100000,
      completion_tokens: 23450,
      total_cost: 12.345,
    },
    all_time: {
      ...emptyWindow,
      run_count: 500,
      total_tokens: 1234500,
      prompt_tokens: 1000000,
      completion_tokens: 234500,
      total_cost: 123.45,
    },
  },
  rate_limited: null,
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("CostPanel", () => {
  it("renders all three window cards with formatted cost and token counts", async () => {
    mockedFetchCost.mockResolvedValue(sampleStats);

    render(<CostPanel />);

    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Last 7 days")).toBeInTheDocument();
    expect(screen.getByText("All time")).toBeInTheDocument();

    // Currency formatting.
    expect(screen.getByText("$1.2345")).toBeInTheDocument();
    expect(screen.getByText("$123.45")).toBeInTheDocument();
    // Token count formatting (thousands separators).
    expect(screen.getByText(/12,345 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/1,234,500 tokens/)).toBeInTheDocument();
  });

  it("shows a distinct message when Langfuse isn't configured, not a generic error", async () => {
    mockedFetchCost.mockRejectedValue(new api.CostSourceNotConfiguredError("no key"));

    render(<CostPanel />);

    expect(await screen.findByText(/Langfuse isn.t configured/i)).toBeInTheDocument();
    expect(screen.queryByText("Today")).not.toBeInTheDocument();
  });

  it("shows a generic error banner for other failures", async () => {
    mockedFetchCost.mockRejectedValue(new Error("network down"));

    render(<CostPanel />);

    expect(await screen.findByText("network down")).toBeInTheDocument();
    expect(screen.queryByText(/Langfuse isn.t configured/i)).not.toBeInTheDocument();
  });

  it("refetches when Refresh is clicked", async () => {
    const user = userEvent.setup();
    mockedFetchCost.mockResolvedValue(sampleStats);

    render(<CostPanel />);
    await screen.findByText("Today");
    expect(mockedFetchCost).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(mockedFetchCost).toHaveBeenCalledTimes(2));
  });

  // The user's own direct ask, 2026-08-09 (twice — a first fix still just
  // showed a bare error banner): a live Langfuse rate limit must never
  // blank the grid. server.py's /cost now absorbs this itself, returning
  // a normal 200 whose windows carry the last recorded figures
  // (`stale: true`) plus a top-level `rate_limited` countdown target —
  // there is no error class to mock anymore, just a degraded response.
  it("shows the rate-limited banner, a countdown, and the last recorded figures", async () => {
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    mockedFetchCost.mockResolvedValue({
      ...sampleStats,
      windows: {
        today: { ...sampleStats.windows.today, stale: true },
        week: { ...sampleStats.windows.week, stale: true },
        all_time: { ...sampleStats.windows.all_time, stale: true },
      },
      rate_limited: {
        message: "Rate limit exceeded",
        retry_after_seconds: 3600,
        reset_at: resetAt,
      },
    });

    render(<CostPanel />);

    expect(await screen.findByText(/Langfuse rate-limited/i)).toBeInTheDocument();
    expect(screen.getByText(/Resets in/i)).toBeInTheDocument();
    // The stat cards are still on screen, not blanked by the failure.
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("$1.2345")).toBeInTheDocument();
    expect(screen.getAllByText(/^Read /).length).toBeGreaterThan(0);
  });

  it("shows an em-dash placeholder for a window that has never recorded anything", async () => {
    mockedFetchCost.mockResolvedValue({
      project: "langfuse",
      windows: {
        today: { ...emptyWindow, stale: true, no_data: true, read_at: null },
        week: { ...emptyWindow, stale: true, no_data: true, read_at: null },
        all_time: { ...emptyWindow, stale: true, no_data: true, read_at: null },
      },
      rate_limited: { message: "Rate limit exceeded", retry_after_seconds: 60, reset_at: null },
    });

    render(<CostPanel />);

    expect(await screen.findByText("Today")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBe(3);
    expect(screen.getAllByText(/No data recorded yet/i).length).toBe(3);
  });
});
