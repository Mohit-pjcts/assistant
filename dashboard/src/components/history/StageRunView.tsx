import { useMemo, type ReactNode } from "react";
import type { StageLogLine, StageRunDetail, StageRunSummary, StageTaskSummary } from "@/lib/api";
import { Chip } from "@/components/ui/chip";
import { Disclosure } from "./Disclosure";
import { JsonBlock } from "./JsonBlock";
import { StageLineRow } from "./StageTimelineRows";
import { TONE_CLASSES, formatSeconds, formatTimestamp, formatUsd } from "./format";
import {
  groupStageLines,
  llmCallCount,
  llmCallReasons,
  runCostUsd,
  runOutcome,
  runSeconds,
  runTally,
  sourceHint,
  taskCostUsd,
  taskTone,
} from "./stageSummary";

// One Stage run, in full: a header (what was asked, where from, how it
// ended, what it cost), then each task with its goal, result and a timeline
// of every logged line — steps, helper calls, task_end — in the order Stage
// wrote them. Presentational only: StageRunLoader fetches the detail, so the
// same view serves the Stage tab's rows and a Backstage call in the
// Conversation tab.

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="panel-label text-[0.6rem] text-muted-foreground">{label}</dt>
      <dd className="break-words font-mono text-xs">{children}</dd>
    </div>
  );
}

// Where a run came from. "api" — Oni started it — is tinted, since that's the
// one that links a Stage run back to a conversation; the hover text spells
// out all of them. (Chip takes no title of its own, hence the wrapper.)
export function SourceBadge({ source }: { source: string | null }) {
  return (
    <span title={sourceHint(source)} data-testid="stage-source">
      <Chip className={source === "api" ? "border-accent-signal/40 text-accent-signal" : undefined}>
        {source ?? "unknown"}
      </Chip>
    </span>
  );
}

function RunHeader({ summary, runLines }: { summary: StageRunSummary; runLines: StageLogLine[] }) {
  const outcome = runOutcome(summary);
  const tally = runTally(summary);
  const seconds = formatSeconds(runSeconds(summary));
  const cost = formatUsd(runCostUsd(summary));
  const totals = summary.totals;

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-graphite/30 p-3"
      data-testid="stage-run-header"
    >
      <p className="whitespace-pre-wrap break-words text-sm font-medium">{summary.command}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
        <Fact label="Source">
          <SourceBadge source={summary.source} />
        </Fact>
        <Fact label="Brain">{summary.brain ?? "—"}</Fact>
        <Fact label="Outcome">
          <Chip className={TONE_CLASSES[outcome.tone]}>{outcome.label}</Chip>{" "}
          {`${tally.done}/${tally.total} tasks done${tally.failed > 0 ? `, ${tally.failed} failed` : ""}`}
        </Fact>
        <Fact label="Cost">
          {cost ?? "—"}
          {totals && (
            <span className="text-muted-foreground">
              {` (decisions ${formatUsd(totals.decisionsUsd)} · helpers ${formatUsd(totals.helperUsd)})`}
            </span>
          )}
        </Fact>
        <Fact label="Started">{formatTimestamp(summary.started_at) || "—"}</Fact>
        <Fact label="Ended">{formatTimestamp(summary.ended_at) || "not recorded"}</Fact>
        <Fact label="Duration">{seconds ?? "—"}</Fact>
        {totals && (
          <Fact label="Decisions / actions">
            {`${totals.decisions} / ${totals.actions}`}
            <span className="text-muted-foreground">{` · median decide ${totals.medianDecideMs} ms`}</span>
          </Fact>
        )}
        <Fact label="Run">{summary.run_id}</Fact>
        {summary.client_run_id && <Fact label="Oni's run id">{summary.client_run_id}</Fact>}
      </dl>
      {runLines.length > 0 && (
        <Disclosure label="raw run lines">
          <div className="flex flex-col gap-2">
            {runLines.map((line, index) => (
              <JsonBlock
                key={index}
                value={line}
                label={line.type}
                copyLabel={`raw ${line.type} line`}
              />
            ))}
          </div>
        </Disclosure>
      )}
    </div>
  );
}

function TaskSection({ task, lines }: { task: StageTaskSummary; lines: StageLogLine[] }) {
  const seconds = formatSeconds(task.seconds);
  const cost = formatUsd(taskCostUsd(task));
  const llmCount = llmCallCount(task);
  const reasons = llmCallReasons(task);

  return (
    <section
      aria-label={`Task ${task.id}`}
      className="flex flex-col gap-2 rounded-md border border-graphite/30 p-3"
      data-testid="stage-task"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Chip>{task.agent}</Chip>
        <span className="font-mono text-xs">{task.app}</span>
        <Chip className={TONE_CLASSES[taskTone(task.status)]}>{task.status}</Chip>
        <span className="ml-auto flex flex-wrap gap-x-3 font-mono text-[0.7rem] text-muted-foreground">
          {seconds && <span>{seconds}</span>}
          {typeof task.steps === "number" && <span>{`${task.steps} steps`}</span>}
          {cost && <span>{cost}</span>}
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{task.goal}</p>
      {task.answer && (
        <p className="whitespace-pre-wrap break-words text-sm">
          <span className="panel-label mr-1.5 text-[0.6rem] text-muted-foreground">Answer</span>
          {task.answer}
        </p>
      )}
      {task.exception && (
        <p className="break-words text-sm text-rust">
          <span className="panel-label mr-1.5 text-[0.6rem]">Failed</span>
          {`${task.exception.code} — ${task.exception.reason}`}
        </p>
      )}
      {llmCount > 0 &&
        (reasons.length > 0 ? (
          <Disclosure label={`${llmCount} LLM call${llmCount === 1 ? "" : "s"}`}>
            <ol className="list-decimal pl-5 font-mono text-[0.7rem] text-muted-foreground">
              {reasons.map((reason, index) => (
                <li key={index} className="break-words">
                  {reason}
                </li>
              ))}
            </ol>
          </Disclosure>
        ) : (
          <span className="font-mono text-[0.7rem] text-muted-foreground">
            {`${llmCount} LLM call${llmCount === 1 ? "" : "s"}`}
          </span>
        ))}
      <div className="mt-1 flex flex-col gap-2.5">
        {lines.length === 0 && (
          <p className="text-xs text-muted-foreground">No log lines for this task.</p>
        )}
        {lines.map((line, index) => (
          <StageLineRow key={index} line={line} />
        ))}
      </div>
    </section>
  );
}

export function StageRunView({ detail }: { detail: StageRunDetail }) {
  const { summary, lines } = detail;
  const grouped = useMemo(() => groupStageLines(lines, summary.tasks), [lines, summary.tasks]);

  return (
    <div className="flex flex-col gap-3" data-testid="stage-run-view">
      <RunHeader summary={summary} runLines={grouped.runLines} />
      {summary.tasks.map((task) => (
        <TaskSection key={task.id} task={task} lines={grouped.perTask.get(task.id) ?? []} />
      ))}
      {grouped.other.length > 0 && (
        <section
          aria-label="Other log lines"
          className="flex flex-col gap-2 rounded-md border border-graphite/30 p-3"
          data-testid="stage-other-lines"
        >
          <p className="panel-label text-[0.65rem] text-muted-foreground">
            Other log lines ({grouped.other.length})
          </p>
          {grouped.other.map((line, index) => (
            <StageLineRow key={index} line={line} />
          ))}
        </section>
      )}
    </div>
  );
}
