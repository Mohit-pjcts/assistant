import { describe, expect, it } from "vitest";
import type { StageLogLine, StageTaskSummary } from "@/lib/api";
import {
  chosenItemText,
  groupStageLines,
  llmCallCount,
  runCostUsd,
  runOutcome,
  runSeconds,
  runTally,
  taskCostUsd,
  taskTone,
} from "./stageSummary";
import { stageDetail, stageSummary } from "./testFixtures";

describe("runTally / runOutcome", () => {
  it("uses Stage's own totals when the run finished", () => {
    const summary = stageSummary();
    expect(runTally(summary)).toEqual({ done: 1, failed: 1, total: 2 });
    expect(runOutcome(summary)).toEqual({ label: "partial", tone: "warn" });
  });

  it("counts tasks itself for a run that never wrote totals", () => {
    const summary = stageSummary({ totals: null, status: "unfinished" });
    expect(runTally(summary)).toEqual({ done: 1, failed: 1, total: 2 });
    expect(runOutcome(summary)).toEqual({ label: "unfinished", tone: "warn" });
  });

  it("calls a finished run with every task done 'done' and one with none done 'failed'", () => {
    const allDone = stageSummary({
      totals: { ...stageSummary().totals!, done: 2, failed: 0 },
    });
    expect(runOutcome(allDone).label).toBe("done");
    expect(runOutcome(allDone).tone).toBe("ok");

    const allFailed = stageSummary({
      totals: { ...stageSummary().totals!, done: 0, failed: 2 },
    });
    expect(runOutcome(allFailed).label).toBe("failed");
    expect(runOutcome(allFailed).tone).toBe("error");
  });

  it("doesn't claim success for a finished run that had no tasks", () => {
    const empty = stageSummary({ totals: null, tasks: [], status: "finished" });
    expect(runOutcome(empty)).toEqual({ label: "finished", tone: "muted" });
  });
});

describe("runSeconds", () => {
  it("prefers Stage's total, falls back to end minus start, else null", () => {
    expect(runSeconds(stageSummary())).toBe(13.9);
    expect(runSeconds(stageSummary({ totals: null }))).toBeCloseTo(13.982, 2);
    expect(runSeconds(stageSummary({ totals: null, ended_at: null }))).toBeNull();
  });
});

describe("cost helpers", () => {
  it("sums decisions + helpers for a run's totals and for a task", () => {
    expect(runCostUsd(stageSummary())).toBeCloseTo(0.00131, 6);
    expect(taskCostUsd({ ...stageSummary().tasks[0] })).toBeCloseTo(0.00031, 6);
  });

  it("falls back to the tasks' own costs when there are no totals, and null when there are none", () => {
    expect(runCostUsd(stageSummary({ totals: null }))).toBeCloseTo(0.00131, 6);
    expect(runCostUsd(stageSummary({ totals: null, tasks: [] }))).toBeNull();
  });

  it("tolerates a bare number or a missing cost", () => {
    const base: StageTaskSummary = { id: "x", agent: "a", app: "b", goal: "g", status: "done" };
    expect(taskCostUsd({ ...base, cost: 0.5 })).toBe(0.5);
    expect(taskCostUsd(base)).toBeNull();
  });
});

describe("llmCallCount / taskTone", () => {
  it("counts a list of reasons or a bare number", () => {
    const base: StageTaskSummary = { id: "x", agent: "a", app: "b", goal: "g", status: "done" };
    expect(llmCallCount({ ...base, llmCalls: ["plan", "verify"] })).toBe(2);
    expect(llmCallCount({ ...base, llmCalls: 3 })).toBe(3);
    expect(llmCallCount(base)).toBe(0);
  });

  it("maps task status to a tone", () => {
    expect(taskTone("done")).toBe("ok");
    expect(taskTone("failed")).toBe("error");
    expect(taskTone("running")).toBe("warn");
    expect(taskTone("queued")).toBe("muted");
  });
});

describe("groupStageLines", () => {
  it("files each line under its task, keeps run lines apart, and keeps file order", () => {
    const detail = stageDetail();
    const grouped = groupStageLines(detail.lines, detail.summary.tasks);

    expect(grouped.runLines.map((line) => line.type)).toEqual(["run_start", "run_end"]);
    expect(grouped.perTask.get("t1")?.map((line) => line.type)).toEqual([
      "helper",
      "step",
      "step",
      "task_end",
    ]);
    expect(grouped.perTask.get("t2")?.map((line) => line.type)).toEqual(["step", "task_end"]);
    expect(grouped.other).toEqual([]);
  });

  it("falls back to the agent when a line's task id matches nothing, but only if that's unambiguous", () => {
    const tasks = stageDetail().summary.tasks;
    const lines: StageLogLine[] = [
      { type: "helper", taskId: "t-missing", agent: "Mint-3", what: "verify", detail: "x" },
      { type: "helper", taskId: "t-missing", agent: "Nobody-0", what: "verify", detail: "y" },
    ];
    const grouped = groupStageLines(lines, tasks);
    expect(grouped.perTask.get("t1")).toHaveLength(1);
    expect(grouped.other).toHaveLength(1);
  });

  it("won't guess between two tasks that share an agent", () => {
    const base = stageDetail().summary.tasks[0];
    const tasks = [base, { ...base, id: "t9" }];
    const lines: StageLogLine[] = [
      { type: "helper", taskId: "zzz", agent: "Mint-3", what: "plan", detail: "x" },
    ];
    expect(groupStageLines(lines, tasks).other).toHaveLength(1);
  });
});

describe("chosenItemText", () => {
  it("looks the chosen index up in the step's own items", () => {
    const step = stageDetail().lines[2];
    if (step.type !== "step") throw new Error("fixture changed");
    expect(chosenItemText(step)).toBe("plus");
  });

  it("is null when nothing was chosen or the item isn't listed", () => {
    expect(chosenItemText({ type: "step", step: 1, decision: { kind: "wait" } })).toBeNull();
    expect(
      chosenItemText({ type: "step", step: 1, decision: { kind: "click", item: 9 }, items: [] }),
    ).toBeNull();
  });
});
