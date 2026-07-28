import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkflowsPanel } from "./WorkflowsPanel";
import * as api from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchWorkflows: vi.fn(),
  };
});

const mockedFetchWorkflows = vi.mocked(api.fetchWorkflows);

const completedRun: api.WorkflowRun = {
  id: "run-1",
  thread_id: "thread-1",
  goal: "Flight check-in",
  status: "completed",
  created_at: "2026-07-28T00:00:00+00:00",
  completed_at: "2026-07-28T00:01:00+00:00",
  steps: [
    {
      step_index: 0,
      action: "calendar_create_event",
      planned_summary: "Create 'Flight to SF' on July 30, 9am-11am",
      executed_args: { title: "Flight to SF", start: "2026-07-30T09:00:00" },
      outcome: "success",
      detail: "Created event 'Flight to SF' (id=abc123)",
      executed_at: "2026-07-28T00:00:30+00:00",
      diverged: false,
    },
    {
      step_index: 1,
      action: "send_imessage",
      planned_summary: "Text Rishabh: landed, see you soon",
      executed_args: { recipient: "Rishabh", message: "landed, see you soon" },
      outcome: "success",
      detail: "Sent",
      executed_at: "2026-07-28T00:00:45+00:00",
      diverged: false,
    },
  ],
};

const failedRun: api.WorkflowRun = {
  id: "run-2",
  thread_id: "thread-1",
  goal: "Bad reminder list",
  status: "failed",
  created_at: "2026-07-28T01:00:00+00:00",
  completed_at: "2026-07-28T01:00:10+00:00",
  steps: [
    {
      step_index: 0,
      action: "calendar_create_event",
      planned_summary: "Create the event",
      executed_args: { title: "X" },
      outcome: "failed",
      detail: "Error: osascript failed",
      executed_at: "2026-07-28T01:00:05+00:00",
      diverged: false,
    },
    {
      step_index: 1,
      action: "send_imessage",
      planned_summary: "Send the text",
      executed_args: null,
      outcome: "never_ran",
      detail: "",
      executed_at: null,
      diverged: false,
    },
  ],
};

const divergedRun: api.WorkflowRun = {
  ...completedRun,
  id: "run-3",
  steps: [
    {
      ...completedRun.steps[1],
      planned_summary: "Text Rishabh: landed, see you soon",
      executed_args: { recipient: "someone-else@example.com", message: "different text" },
      diverged: true,
    },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("WorkflowsPanel", () => {
  it("shows an empty state when there are no workflow runs", async () => {
    mockedFetchWorkflows.mockResolvedValue([]);

    render(<WorkflowsPanel />);

    expect(await screen.findByText(/no workflow runs yet/i)).toBeInTheDocument();
  });

  it("lists a completed run with both steps' planned and executed content", async () => {
    mockedFetchWorkflows.mockResolvedValue([completedRun]);

    render(<WorkflowsPanel />);

    expect(await screen.findByText("Flight check-in")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText(/Create 'Flight to SF' on July 30/)).toBeInTheDocument();
    expect(screen.getByText(/Text Rishabh: landed, see you soon/)).toBeInTheDocument();
    // The actual audit value: real executed args, not just the plan.
    expect(screen.getByText(/"title": "Flight to SF"/)).toBeInTheDocument();
    expect(screen.getByText(/"recipient": "Rishabh"/)).toBeInTheDocument();
    expect(screen.getAllByText("Executed")).toHaveLength(2);
  });

  it("shows a failed step and marks the un-run second step distinctly", async () => {
    mockedFetchWorkflows.mockResolvedValue([failedRun]);

    render(<WorkflowsPanel />);

    expect(await screen.findByText("Bad reminder list")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Never ran")).toBeInTheDocument();
    expect(screen.getByText(/Error: osascript failed/)).toBeInTheDocument();
    expect(screen.getByText(/\(not yet executed\)/)).toBeInTheDocument();
  });

  it("flags a diverged step visibly", async () => {
    mockedFetchWorkflows.mockResolvedValue([divergedRun]);

    render(<WorkflowsPanel />);

    await screen.findByText("Flight check-in");
    expect(screen.getByText("Diverged")).toBeInTheDocument();
    expect(screen.getByText(/"recipient": "someone-else@example.com"/)).toBeInTheDocument();
  });
});
