import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { CostSummaryCard } from "./CostSummaryCard";
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
    today: { ...emptyWindow },
    week: { ...emptyWindow, run_count: 40, total_tokens: 8_800_000, total_cost: 14.4888 },
    all_time: { ...emptyWindow },
  },
  rate_limited: null,
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("CostSummaryCard", () => {
  it("shows the week window's cost and token/run counts once loaded", async () => {
    mockedFetchCost.mockResolvedValue(sampleStats);

    render(<CostSummaryCard />);

    expect(await screen.findByText("$14.4888")).toBeInTheDocument();
    expect(screen.getByText(/8,800,000 tokens/)).toBeInTheDocument();
    expect(screen.getByText(/40 runs/)).toBeInTheDocument();
  });

  // The user's own direct ask, 2026-08-09 (twice): a live Langfuse rate
  // limit must never blank this widget. server.py's /cost now absorbs
  // this itself — a normal 200 whose `week` window carries the last
  // polled figures (`stale: true`) plus a top-level `rate_limited`
  // countdown target, no error class to mock anymore.
  it("shows a live countdown and the last polled figures when rate-limited", async () => {
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    mockedFetchCost.mockResolvedValue({
      ...sampleStats,
      windows: { ...sampleStats.windows, week: { ...sampleStats.windows.week, stale: true } },
      rate_limited: {
        message: "Rate limit exceeded",
        retry_after_seconds: 3600,
        reset_at: resetAt,
      },
    });

    render(<CostSummaryCard />);

    expect(await screen.findByText("$14.4888")).toBeInTheDocument();
    expect(screen.getByText(/Langfuse rate-limited/i)).toBeInTheDocument();
    expect(screen.getByText(/resets in/i)).toBeInTheDocument();
  });

  it("shows an em dash when the week window has never recorded anything", async () => {
    mockedFetchCost.mockResolvedValue({
      project: "langfuse",
      windows: {
        today: { ...emptyWindow, stale: true, no_data: true, read_at: null },
        week: { ...emptyWindow, stale: true, no_data: true, read_at: null },
        all_time: { ...emptyWindow, stale: true, no_data: true, read_at: null },
      },
      rate_limited: null,
    });

    render(<CostSummaryCard />);

    expect(await screen.findByText("—")).toBeInTheDocument();
    expect(screen.getByText("No data recorded yet")).toBeInTheDocument();
  });

  it("shows a plain unavailable message when Langfuse was never configured", async () => {
    mockedFetchCost.mockRejectedValue(new api.CostSourceNotConfiguredError("no key"));

    render(<CostSummaryCard />);

    expect(await screen.findByText("Cost data unavailable.")).toBeInTheDocument();
  });
});
