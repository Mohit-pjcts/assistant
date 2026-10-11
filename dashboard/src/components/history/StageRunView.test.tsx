import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StageLogLine } from "@/lib/api";
import { StageRunView } from "./StageRunView";
import { STAGE_RUN_ID, stageDetail, stageSummary } from "./testFixtures";

function firstTask() {
  return screen.getAllByTestId("stage-task")[0];
}

describe("StageRunView header", () => {
  it("shows what was asked, where from, how it ended and what it cost", () => {
    render(<StageRunView detail={stageDetail()} />);

    const header = within(screen.getByTestId("stage-run-header"));
    expect(header.getByText("compute 2+2 and make a note called groceries")).toBeInTheDocument();
    expect(header.getByText("api")).toBeInTheDocument();
    expect(header.getByText("jev")).toBeInTheDocument();
    expect(header.getByText("partial")).toBeInTheDocument();
    expect(header.getByText(/1\/2 tasks done, 1 failed/)).toBeInTheDocument();
    expect(header.getByText("$0.00131", { exact: false })).toBeInTheDocument();
    expect(header.getByText(/decisions \$0\.001 · helpers \$0\.00031/)).toBeInTheDocument();
    expect(header.getByText("13.9 s")).toBeInTheDocument();
    expect(header.getByText(/5 \/ 4/)).toBeInTheDocument();
    expect(header.getByText(/median decide 6 ms/)).toBeInTheDocument();
    expect(header.getByText(STAGE_RUN_ID)).toBeInTheDocument();
    expect(header.getByText("oni-run-7")).toBeInTheDocument();
  });

  it("explains the 'api' source on hover", () => {
    render(<StageRunView detail={stageDetail()} />);
    expect(screen.getByTestId("stage-source")).toHaveAttribute(
      "title",
      expect.stringMatching(/Started by Oni/),
    );
  });

  it("says 'unknown' for a run logged before Stage recorded its source", () => {
    const detail = stageDetail();
    render(
      <StageRunView
        detail={{ ...detail, summary: { ...detail.summary, source: null, client_run_id: null } }}
      />,
    );

    expect(screen.getByTestId("stage-source")).toHaveTextContent("unknown");
    expect(screen.queryByText("oni-run-7")).not.toBeInTheDocument();
  });

  it("shows a run that never finished as unfinished, with no end time or totals", () => {
    const detail = stageDetail();
    render(
      <StageRunView
        detail={{
          ...detail,
          summary: stageSummary({ status: "unfinished", totals: null, ended_at: null }),
        }}
      />,
    );

    const header = within(screen.getByTestId("stage-run-header"));
    expect(header.getByText("unfinished")).toBeInTheDocument();
    expect(header.getByText("not recorded")).toBeInTheDocument();
    expect(header.queryByText(/median decide/)).not.toBeInTheDocument();
  });

  it("keeps the raw run_start and run_end lines one click away", async () => {
    const user = userEvent.setup();
    render(<StageRunView detail={stageDetail()} />);

    await user.click(screen.getByRole("button", { name: "raw run lines" }));

    expect(screen.getByText("run_start")).toBeInTheDocument();
    expect(screen.getByText("run_end")).toBeInTheDocument();
    expect(screen.getByText(/"clientRunId": "oni-run-7"/)).toBeInTheDocument();
    expect(screen.getByText(/"medianDecideMs": 6/)).toBeInTheDocument();
  });
});

describe("StageRunView tasks", () => {
  it("shows each task's agent, app, status, goal, result and numbers", () => {
    render(<StageRunView detail={stageDetail()} />);

    const [done, failed] = screen.getAllByTestId("stage-task").map((el) => within(el));
    expect(done.getByText("Mint-3")).toBeInTheDocument();
    expect(done.getByText("Calculator")).toBeInTheDocument();
    expect(done.getAllByText("done").length).toBeGreaterThan(0);
    expect(done.getByText("compute 2+2")).toBeInTheDocument();
    expect(done.getByText("4")).toBeInTheDocument();
    expect(done.getAllByText("8.2 s").length).toBeGreaterThan(0);
    expect(done.getAllByText("2 steps").length).toBeGreaterThan(0);
    expect(done.getAllByText("$0.00031").length).toBeGreaterThan(0);

    expect(failed.getByText("Red-7")).toBeInTheDocument();
    expect(failed.getByText("make a note called groceries")).toBeInTheDocument();
    expect(failed.getByText("stalled — nothing changed for 3 steps")).toBeInTheDocument();
  });

  it("lists why a task needed an LLM, and says nothing for one done by code alone", async () => {
    const user = userEvent.setup();
    render(<StageRunView detail={stageDetail()} />);
    const [done, failed] = screen.getAllByTestId("stage-task").map((el) => within(el));

    await user.click(done.getByRole("button", { name: "1 LLM call" }));
    expect(done.getByText("plan", { selector: "li" })).toBeInTheDocument();
    expect(failed.queryByText(/LLM call/)).not.toBeInTheDocument();
  });

  it("puts each task's lines under it, in the order Stage wrote them", () => {
    render(<StageRunView detail={stageDetail()} />);

    const rows = within(firstTask()).getAllByTestId(/^stage-(helper|step|task-end)$/);
    expect(rows.map((row) => row.getAttribute("data-testid"))).toEqual([
      "stage-helper",
      "stage-step",
      "stage-step",
      "stage-task-end",
    ]);
  });

  it("says so when a task has no lines", () => {
    const detail = stageDetail();
    render(<StageRunView detail={{ ...detail, lines: [] }} />);
    expect(screen.getAllByText("No log lines for this task.")).toHaveLength(2);
  });
});

describe("StageRunView step lines", () => {
  function firstStep() {
    return within(within(firstTask()).getAllByTestId("stage-step")[0]);
  }

  it("summarizes the decision: backend:kind, the chosen control, confidence and gate", () => {
    render(<StageRunView detail={stageDetail()} />);
    const step = firstStep();

    expect(step.getByText("step 1")).toBeInTheDocument();
    expect(step.getByText("jev:click")).toBeInTheDocument();
    expect(step.getByText("item 1 “plus”")).toBeInTheDocument();
    expect(step.getByText("conf 0.97")).toBeInTheDocument();
    expect(step.getByText("item conf 0.88")).toBeInTheDocument();
    expect(step.getByText("gate 0.80")).toBeInTheDocument();
  });

  it("shows what was done, how long each phase took, and the action's result", () => {
    render(<StageRunView detail={stageDetail()} />);
    const step = firstStep();

    expect(step.getByText("click 'plus'")).toBeInTheDocument();
    expect(step.getByText("observe 120 ms")).toBeInTheDocument();
    expect(step.getByText("decide 4 ms")).toBeInTheDocument();
    expect(step.getByText("act 31 ms")).toBeInTheDocument();
    expect(step.getByText("jev-small")).toBeInTheDocument();

    const result = within(step.getByTestId("stage-result"));
    expect(result.getByText("ok")).toBeInTheDocument();
    expect(result.getByText(/ax/)).toBeInTheDocument();
    expect(result.getByText(/pressed/)).toBeInTheDocument();
    expect(result.getByText("cua click --token tok-plus")).toBeInTheDocument();
  });

  it("keeps the controls on screen collapsed until asked, then lists each one", async () => {
    const user = userEvent.setup();
    render(<StageRunView detail={stageDetail()} />);
    const step = firstStep();

    const toggle = step.getByRole("button", { name: "3 controls on screen" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(step.queryAllByTestId("stage-item-row")).toHaveLength(0);

    await user.click(toggle);

    const rows = step.getAllByTestId("stage-item-row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText("1")).toBeInTheDocument();
    expect(within(rows[1]).getByText("AXButton")).toBeInTheDocument();
    expect(within(rows[1]).getByText("plus")).toBeInTheDocument();
    expect(within(rows[2]).getByText("AXStaticText")).toBeInTheDocument();
    expect(within(rows[2]).getByText("filled")).toBeInTheDocument();
    expect(step.getByRole("columnheader", { name: "value" })).toBeInTheDocument();
  });

  it("says so for a step with no controls, instead of an empty toggle", () => {
    render(<StageRunView detail={stageDetail()} />);
    const secondStep = within(within(firstTask()).getAllByTestId("stage-step")[1]);

    expect(secondStep.getByText("no controls listed")).toBeInTheDocument();
    expect(
      secondStep.queryByRole("button", { name: /controls on screen/ }),
    ).not.toBeInTheDocument();
  });

  it("makes every field reachable through the raw toggle", async () => {
    const user = userEvent.setup();
    render(<StageRunView detail={stageDetail()} />);
    const step = firstStep();

    await user.click(step.getByRole("button", { name: "raw" }));

    // Fields the summary line doesn't show at all.
    expect(step.getByText(/"inputTokens": 0/)).toBeInTheDocument();
    expect(step.getByText(/"taskId": "t1"/)).toBeInTheDocument();
    expect(step.getByText(/"id": "a1"/)).toBeInTheDocument();
    expect(step.getByRole("button", { name: "Copy raw step line" })).toBeInTheDocument();
  });

  it("shows a failed action's error and a truncated observation", () => {
    render(<StageRunView detail={stageDetail()} />);
    const failedStep = within(
      within(screen.getAllByTestId("stage-task")[1]).getByTestId("stage-step"),
    );

    expect(failedStep.getByText("refused: low confidence")).toBeInTheDocument();
    expect(failedStep.getByText("failed")).toBeInTheDocument();
    expect(failedStep.getByText(/refused: element not actionable/)).toBeInTheDocument();
    expect(failedStep.getByText("truncated")).toBeInTheDocument();
  });

  it("tolerates a step line with almost nothing on it", () => {
    const detail = stageDetail();
    const bare: StageLogLine = { type: "step", taskId: "t1", step: 9 };
    render(<StageRunView detail={{ ...detail, lines: [bare] }} />);

    expect(screen.getByText("step 9")).toBeInTheDocument();
  });
});

describe("StageRunView helper and task_end lines", () => {
  it("shows a helper call's kind, full detail, cost and time", () => {
    render(<StageRunView detail={stageDetail()} />);
    const helper = within(screen.getByTestId("stage-helper"));

    expect(helper.getByText("plan")).toBeInTheDocument();
    expect(
      helper.getByText("[llm] click '2' → click '+' → click '2' → click '='"),
    ).toBeInTheDocument();
    expect(helper.getByText("$0.00031")).toBeInTheDocument();
    expect(helper.getByText("1.2 s")).toBeInTheDocument();
  });

  it("shows task_end with its status and a raw toggle holding the whole task", async () => {
    const user = userEvent.setup();
    render(<StageRunView detail={stageDetail()} />);
    const end = within(within(firstTask()).getByTestId("stage-task-end"));

    expect(end.getByText("task_end")).toBeInTheDocument();
    expect(end.getByText("done")).toBeInTheDocument();

    await user.click(end.getByRole("button", { name: "raw" }));
    expect(end.getByText(/"llmCalls": \[/)).toBeInTheDocument();
  });
});

describe("StageRunView lines that match no task", () => {
  it("shows them under 'Other log lines' rather than dropping them", async () => {
    const user = userEvent.setup();
    const detail = stageDetail();
    const stray: StageLogLine = {
      type: "helper",
      taskId: "t-gone",
      agent: "Nobody-0",
      what: "verify",
      detail: "a line from a task nobody listed",
    };
    const future = { type: "screenshot", path: "/tmp/x.png" } as unknown as StageLogLine;
    render(<StageRunView detail={{ ...detail, lines: [...detail.lines, stray, future] }} />);

    const other = within(screen.getByTestId("stage-other-lines"));
    expect(other.getByText(/Other log lines \(2\)/)).toBeInTheDocument();
    expect(other.getByText("a line from a task nobody listed")).toBeInTheDocument();

    const unknown = within(other.getByTestId("stage-other-line"));
    expect(unknown.getByText("screenshot")).toBeInTheDocument();
    await user.click(unknown.getByRole("button", { name: "raw" }));
    expect(unknown.getByText(/"path": "\/tmp\/x.png"/)).toBeInTheDocument();
  });

  it("has no such section when every line belongs somewhere", () => {
    render(<StageRunView detail={stageDetail()} />);
    expect(screen.queryByTestId("stage-other-lines")).not.toBeInTheDocument();
  });
});
