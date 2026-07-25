import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutomationsPanel } from "./AutomationsPanel";
import * as api from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchAutomations: vi.fn(),
    fetchAutomationRuns: vi.fn(),
    createAutomation: vi.fn(),
    updateAutomation: vi.fn(),
    deleteAutomation: vi.fn(),
  };
});

const mockedFetchAutomations = vi.mocked(api.fetchAutomations);
const mockedFetchAutomationRuns = vi.mocked(api.fetchAutomationRuns);
const mockedCreateAutomation = vi.mocked(api.createAutomation);
const mockedUpdateAutomation = vi.mocked(api.updateAutomation);
const mockedDeleteAutomation = vi.mocked(api.deleteAutomation);

const sampleAutomation: api.Automation = {
  id: "auto-1",
  name: "Landing text",
  trigger_description: "arrive at SFO",
  target: "+15551234567",
  goal: "Text them I've landed.",
  action: "send_imessage",
  enabled: true,
  created_at: "2026-07-25T00:00:00+00:00",
  updated_at: "2026-07-25T00:00:00+00:00",
};

const sampleRun: api.AutomationRun = {
  id: "run-1",
  automation_id: "auto-1",
  fired_at: "2026-07-25T01:00:00+00:00",
  outcome: "fired",
  detail: "Sent the message.",
};

beforeEach(() => {
  vi.resetAllMocks();
  mockedFetchAutomationRuns.mockResolvedValue([]);
});

describe("AutomationsPanel", () => {
  it("lists registered automations", async () => {
    mockedFetchAutomations.mockResolvedValue([sampleAutomation]);

    render(<AutomationsPanel />);

    expect(await screen.findByText("Landing text")).toBeInTheDocument();
    expect(screen.getByText(/arrive at SFO/)).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
  });

  it("shows an empty state when there are no automations", async () => {
    mockedFetchAutomations.mockResolvedValue([]);

    render(<AutomationsPanel />);

    expect(await screen.findByText(/no automations registered yet/i)).toBeInTheDocument();
  });

  it("shows recent runs under their automation", async () => {
    mockedFetchAutomations.mockResolvedValue([sampleAutomation]);
    mockedFetchAutomationRuns.mockResolvedValue([sampleRun]);

    render(<AutomationsPanel />);

    expect(await screen.findByText(/fired/)).toBeInTheDocument();
    expect(screen.getByText(/Sent the message\./)).toBeInTheDocument();
  });

  it("creates a new automation from the form", async () => {
    const user = userEvent.setup();
    mockedFetchAutomations.mockResolvedValue([]);
    mockedCreateAutomation.mockResolvedValue(sampleAutomation);

    render(<AutomationsPanel />);
    await waitFor(() => expect(mockedFetchAutomations).toHaveBeenCalledTimes(1));

    await user.type(screen.getByPlaceholderText(/^name/i), "Landing text");
    await user.type(screen.getByPlaceholderText(/trigger/i), "arrive at SFO");
    await user.type(screen.getByPlaceholderText(/target/i), "+15551234567");
    await user.type(screen.getByPlaceholderText(/goal/i), "Text them I've landed.");
    await user.click(screen.getByRole("button", { name: /register automation/i }));

    await waitFor(() =>
      expect(mockedCreateAutomation).toHaveBeenCalledWith({
        name: "Landing text",
        trigger_description: "arrive at SFO",
        target: "+15551234567",
        goal: "Text them I've landed.",
        action: "send_imessage",
      }),
    );
  });

  it("refuses to create with a blank field, without calling the API", async () => {
    const user = userEvent.setup();
    mockedFetchAutomations.mockResolvedValue([]);

    render(<AutomationsPanel />);
    await waitFor(() => expect(mockedFetchAutomations).toHaveBeenCalledTimes(1));

    await user.type(screen.getByPlaceholderText(/^name/i), "Landing text");
    await user.click(screen.getByRole("button", { name: /register automation/i }));

    expect(mockedCreateAutomation).not.toHaveBeenCalled();
    expect(await screen.findByText(/required/i)).toBeInTheDocument();
  });

  it("toggles an automation disabled", async () => {
    const user = userEvent.setup();
    mockedFetchAutomations.mockResolvedValue([sampleAutomation]);
    mockedUpdateAutomation.mockResolvedValue({ ...sampleAutomation, enabled: false });

    render(<AutomationsPanel />);
    await screen.findByText("Landing text");

    await user.click(screen.getByRole("button", { name: /^disable$/i }));

    await waitFor(() =>
      expect(mockedUpdateAutomation).toHaveBeenCalledWith("auto-1", { enabled: false }),
    );
  });

  it("requires confirmation before deleting", async () => {
    const user = userEvent.setup();
    mockedFetchAutomations.mockResolvedValue([sampleAutomation]);

    render(<AutomationsPanel />);
    await screen.findByText("Landing text");

    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(mockedDeleteAutomation).not.toHaveBeenCalled();
  });

  it("confirming deletion calls deleteAutomation and removes the row", async () => {
    const user = userEvent.setup();
    mockedFetchAutomations.mockResolvedValue([sampleAutomation]);
    mockedDeleteAutomation.mockResolvedValue(undefined);

    render(<AutomationsPanel />);
    await screen.findByText("Landing text");
    await user.click(screen.getByRole("button", { name: /^delete$/i }));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(mockedDeleteAutomation).toHaveBeenCalledWith("auto-1"));
    await waitFor(() => expect(screen.queryByText("Landing text")).not.toBeInTheDocument());
  });
});
