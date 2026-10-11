import type { StageLogLine, StageRunSummary, StageStepLine, StageTaskSummary } from "@/lib/api";
import type { Tone } from "./format";

// Derived facts about a Stage run, computed in one place so the list row and
// the expanded run view can never disagree about "did it work" or "what did
// it cost". Everything tolerates a run that never finished (no totals, no
// end time) — Stage can be killed mid-run, and those runs are exactly the
// ones worth looking at.

export interface RunTally {
  done: number;
  failed: number;
  total: number;
}

export function runTally(summary: StageRunSummary): RunTally {
  if (summary.totals) {
    return {
      done: summary.totals.done,
      failed: summary.totals.failed,
      total: summary.totals.tasks,
    };
  }
  return {
    done: summary.tasks.filter((task) => task.status === "done").length,
    failed: summary.tasks.filter((task) => task.status === "failed").length,
    total: summary.tasks.length,
  };
}

export interface RunOutcome {
  label: "done" | "partial" | "failed" | "finished" | "unfinished";
  tone: Tone;
}

export function runOutcome(summary: StageRunSummary): RunOutcome {
  if (summary.status === "unfinished") return { label: "unfinished", tone: "warn" };
  const { done, failed, total } = runTally(summary);
  if (total === 0) return { label: "finished", tone: "muted" };
  if (failed === 0 && done === total) return { label: "done", tone: "ok" };
  if (done === 0) return { label: "failed", tone: "error" };
  return { label: "partial", tone: "warn" };
}

/** Wall-clock seconds: Stage's own total when it wrote one, else end minus start. */
export function runSeconds(summary: StageRunSummary): number | null {
  if (summary.totals) return summary.totals.seconds;
  if (summary.started_at && summary.ended_at) {
    const span = new Date(summary.ended_at).getTime() - new Date(summary.started_at).getTime();
    if (Number.isFinite(span) && span >= 0) return span / 1000;
  }
  return null;
}

/** One task's spend: Stage logs {decisionsUsd, helperUsd}; a bare number is tolerated. */
export function taskCostUsd(task: StageTaskSummary): number | null {
  const cost = task.cost;
  if (typeof cost === "number") return cost;
  if (cost && typeof cost === "object") return (cost.decisionsUsd ?? 0) + (cost.helperUsd ?? 0);
  return null;
}

/** A run's spend: Stage's own totals when it wrote them, else the sum over its tasks. */
export function runCostUsd(summary: StageRunSummary): number | null {
  if (summary.totals) return summary.totals.decisionsUsd + summary.totals.helperUsd;
  const costs = summary.tasks.map(taskCostUsd).filter((cost): cost is number => cost !== null);
  return costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null;
}

/** The reasons a task needed an LLM (Stage's list), or [] when it was done by code alone. */
export function llmCallReasons(task: StageTaskSummary): string[] {
  return Array.isArray(task.llmCalls) ? task.llmCalls : [];
}

export function llmCallCount(task: StageTaskSummary): number {
  if (Array.isArray(task.llmCalls)) return task.llmCalls.length;
  return typeof task.llmCalls === "number" ? task.llmCalls : 0;
}

export function taskTone(status: string): Tone {
  if (status === "done") return "ok";
  if (status === "failed") return "error";
  if (status === "running") return "warn";
  return "muted";
}

/** Plain-language hint for a source badge; "api" is the one that isn't self-explanatory. */
export function sourceHint(source: string | null): string {
  if (source === "api") return "Started by Oni (the assistant)";
  if (source === "hotkey") return "Started with the Stage hotkey";
  if (source === "panel") return "Started from the Stage panel";
  return "Stage didn't record where this run came from";
}

export interface GroupedStageLines {
  // run_start / run_end — summarized in the run header, shown raw under it.
  runLines: StageLogLine[];
  // Per task id, in file order: its steps, helper calls and task_end.
  perTask: Map<string, StageLogLine[]>;
  // Anything that matched no task, so even an odd log has nothing hidden.
  other: StageLogLine[];
}

export function groupStageLines(
  lines: StageLogLine[],
  tasks: StageTaskSummary[],
): GroupedStageLines {
  const runLines: StageLogLine[] = [];
  const perTask = new Map<string, StageLogLine[]>(tasks.map((task) => [task.id, []]));
  const other: StageLogLine[] = [];

  for (const line of lines) {
    if (line.type === "run_start" || line.type === "run_end") {
      runLines.push(line);
      continue;
    }
    const taskId = line.type === "task_end" ? line.task?.id : line.taskId;
    let bucket = taskId !== undefined ? perTask.get(taskId) : undefined;
    if (!bucket && line.type !== "task_end" && line.agent) {
      // No usable task id on the line: fall back to its agent, but only
      // when that points at exactly one task — a guess between two tasks
      // would put the line under the wrong one.
      const sameAgent = tasks.filter((task) => task.agent === line.agent);
      if (sameAgent.length === 1) bucket = perTask.get(sameAgent[0].id);
    }
    if (bucket) bucket.push(line);
    else other.push(line);
  }
  return { runLines, perTask, other };
}

/** The chosen control's text, looked up from the step's own item list (decision.item is just an index). */
export function chosenItemText(step: StageStepLine): string | null {
  const index = step.decision?.item;
  if (index === undefined || index === null) return null;
  return step.items?.find((item) => item.i === index)?.text ?? null;
}
