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
};

const sampleStats = {
  project: "personal-assistant",
  windows: {
    today: { ...emptyWindow, run_count: 5, total_tokens: 12345, prompt_tokens: 10000, completion_tokens: 2345, total_cost: 1.2345 },
    week: { ...emptyWindow, run_count: 50, total_tokens: 123450, prompt_tokens: 100000, completion_tokens: 23450, total_cost: 12.345 },
    all_time: { ...emptyWindow, run_count: 500, total_tokens: 1234500, prompt_tokens: 1000000, completion_tokens: 234500, total_cost: 123.45 },
  },
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

  it("shows a distinct message when LangSmith isn't configured, not a generic error", async () => {
    mockedFetchCost.mockRejectedValue(new api.LangSmithNotConfiguredError("no key"));

    render(<CostPanel />);

    expect(await screen.findByText(/LangSmith isn.t configured/i)).toBeInTheDocument();
    expect(screen.queryByText("Today")).not.toBeInTheDocument();
  });

  it("shows a generic error banner for other failures", async () => {
    mockedFetchCost.mockRejectedValue(new Error("network down"));

    render(<CostPanel />);

    expect(await screen.findByText("network down")).toBeInTheDocument();
    expect(screen.queryByText(/LangSmith isn.t configured/i)).not.toBeInTheDocument();
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
});
