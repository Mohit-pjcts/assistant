import type {
  StageActionResult,
  StageHelperLine,
  StageItem,
  StageLogLine,
  StageStepLine,
  StageTaskEndLine,
} from "@/lib/api";
import { Chip } from "@/components/ui/chip";
import { cn } from "@/lib/utils";
import { Disclosure } from "./Disclosure";
import { JsonBlock } from "./JsonBlock";
import { TONE_CLASSES, formatClock, formatDuration, formatSeconds, formatUsd } from "./format";
import { chosenItemText, taskCostUsd, taskTone } from "./stageSummary";

// The three kinds of line a Stage task's timeline is made of (step, helper,
// task_end), each a compact summary of the fields worth reading plus a "raw"
// toggle that shows the line's complete JSON. The raw toggle is the promise
// of this panel: whatever the summary leaves out — a Stage field added next
// month, a decision's token counts — is still one click from the screen.

function RawToggle({ value, what }: { value: unknown; what: string }) {
  return (
    <Disclosure label="raw">
      <JsonBlock value={value} copyLabel={`raw ${what}`} />
    </Disclosure>
  );
}

function confidence(value: number | undefined): string | null {
  return typeof value === "number" ? value.toFixed(2) : null;
}

function ResultLine({ result }: { result: StageActionResult }) {
  return (
    <li className="font-mono text-[0.7rem] leading-snug" data-testid="stage-result">
      <span className={result.ok ? "text-moss" : "text-rust"}>{result.ok ? "ok" : "failed"}</span>
      {result.channel && <span> · {result.channel}</span>}
      {result.route && <span className="text-muted-foreground"> · route {result.route}</span>}
      {result.effect && <span className="text-muted-foreground"> · {result.effect}</span>}
      {result.error && (
        <span className="text-rust">{` · ${result.error.code}: ${result.error.detail}`}</span>
      )}
      {typeof result.ms === "number" && (
        <span className="text-muted-foreground"> · {formatDuration(result.ms)}</span>
      )}
      {result.cli && <div className="break-words text-muted-foreground">{result.cli}</div>}
    </li>
  );
}

function ItemsTable({ items }: { items: StageItem[] }) {
  return (
    <div className="max-h-80 overflow-auto rounded-md border border-graphite/30">
      <table className="w-full border-collapse text-left font-mono text-[0.7rem]">
        <thead className="sticky top-0 bg-muted text-muted-foreground">
          <tr>
            <th className="px-2 py-1 font-medium">#</th>
            <th className="px-2 py-1 font-medium">role</th>
            <th className="px-2 py-1 font-medium">text</th>
            <th className="px-2 py-1 font-medium">value</th>
            <th className="px-2 py-1 font-medium">state</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr
              key={`${item.i}-${index}`}
              className="border-t border-graphite/20 align-top"
              data-testid="stage-item-row"
            >
              <td className="px-2 py-1">{item.i}</td>
              <td className="px-2 py-1">{item.role}</td>
              <td className="break-words px-2 py-1">{item.text}</td>
              <td className="break-words px-2 py-1">{item.value}</td>
              <td className="px-2 py-1">{item.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StageStepRow({ line }: { line: StageStepLine }) {
  const decision = line.decision;
  const chosen = chosenItemText(line);
  const items = line.items ?? [];
  const results = line.results ?? [];
  const kindConf = confidence(decision?.kindConf);
  const itemConf = confidence(decision?.itemConf);
  const gate = confidence(decision?.gate);
  // How long each phase of the step took: look at the screen, decide, act.
  const phases = [
    ["observe", line.ms?.observe],
    ["decide", line.ms?.decide],
    ["act", line.ms?.act],
  ] as const;

  return (
    <div
      className="flex flex-col gap-1.5 border-l-2 border-graphite/40 pl-2.5"
      data-testid="stage-step"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs">
        <span className="font-medium">{`step ${line.step}`}</span>
        {decision && <span>{`${decision.backend ?? "?"}:${decision.kind}`}</span>}
        {decision && decision.item !== undefined && (
          <span>{`item ${decision.item}${chosen ? ` “${chosen}”` : ""}`}</span>
        )}
        {decision?.text !== undefined && <span>{`text “${decision.text}”`}</span>}
        {kindConf && <span className="text-muted-foreground">{`conf ${kindConf}`}</span>}
        {itemConf && <span className="text-muted-foreground">{`item conf ${itemConf}`}</span>}
        {gate && <span className="text-muted-foreground">{`gate ${gate}`}</span>}
        {line.truncated && <Chip className={TONE_CLASSES.warn}>truncated</Chip>}
        <span className="ml-auto text-[0.7rem] text-muted-foreground">{formatClock(line.t)}</span>
      </div>
      {line.acted && <p className="break-words text-xs">{line.acted}</p>}
      <div className="flex flex-wrap gap-x-3 font-mono text-[0.7rem] text-muted-foreground">
        {phases.map(([name, value]) => {
          const text = formatDuration(value);
          return text ? <span key={name}>{`${name} ${text}`}</span> : null;
        })}
        {decision?.model && <span>{decision.model}</span>}
        {(decision?.inputTokens !== undefined || decision?.outputTokens !== undefined) && (
          <span>{`${decision?.inputTokens ?? 0} in / ${decision?.outputTokens ?? 0} out tokens`}</span>
        )}
        {decision?.costUsd !== undefined && decision.costUsd > 0 && (
          <span>{formatUsd(decision.costUsd)}</span>
        )}
      </div>
      {results.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {results.map((result, index) => (
            <ResultLine key={index} result={result} />
          ))}
        </ul>
      )}
      {items.length > 0 ? (
        <Disclosure label={`${items.length} control${items.length === 1 ? "" : "s"} on screen`}>
          <ItemsTable items={items} />
        </Disclosure>
      ) : (
        <span className="font-mono text-[0.7rem] text-muted-foreground">no controls listed</span>
      )}
      <RawToggle value={line} what="step line" />
    </div>
  );
}

export function StageHelperRow({ line }: { line: StageHelperLine }) {
  const cost = formatUsd(line.costUsd);
  return (
    <div
      className="flex flex-col gap-1.5 border-l-2 border-accent-signal/50 pl-2.5"
      data-testid="stage-helper"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs">
        <span className="font-medium">helper</span>
        <Chip>{line.what}</Chip>
        {cost && <span className="text-muted-foreground">{cost}</span>}
        {typeof line.ms === "number" && (
          <span className="text-muted-foreground">{formatDuration(line.ms)}</span>
        )}
        <span className="ml-auto text-[0.7rem] text-muted-foreground">{formatClock(line.t)}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-xs">{line.detail}</p>
      <RawToggle value={line} what="helper line" />
    </div>
  );
}

export function StageTaskEndRow({ line }: { line: StageTaskEndLine }) {
  const task = line.task;
  const seconds = formatSeconds(task?.seconds);
  const cost = task ? formatUsd(taskCostUsd(task)) : null;
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 border-l-2 pl-2.5",
        task?.status === "failed" ? "border-rust" : "border-moss/60",
      )}
      data-testid="stage-task-end"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs">
        <span className="font-medium">task_end</span>
        {task && <Chip className={TONE_CLASSES[taskTone(task.status)]}>{task.status}</Chip>}
        {typeof task?.steps === "number" && (
          <span className="text-muted-foreground">{`${task.steps} steps`}</span>
        )}
        {seconds && <span className="text-muted-foreground">{seconds}</span>}
        {cost && <span className="text-muted-foreground">{cost}</span>}
        <span className="ml-auto text-[0.7rem] text-muted-foreground">{formatClock(line.t)}</span>
      </div>
      <RawToggle value={line} what="task_end line" />
    </div>
  );
}

// A line the summary views don't know — a Stage line type added after this
// panel was written, or one that matched none of the run's tasks. Shown
// whole rather than dropped.
export function StageOtherRow({ line }: { line: unknown }) {
  const type =
    typeof line === "object" && line !== null && "type" in line ? String(line.type) : "unknown";
  return (
    <div
      className="flex flex-col gap-1.5 border-l-2 border-graphite/40 pl-2.5"
      data-testid="stage-other-line"
    >
      <span className="font-mono text-xs font-medium">{type}</span>
      <RawToggle value={line} what={`${type} line`} />
    </div>
  );
}

export function StageLineRow({ line }: { line: StageLogLine }) {
  switch (line.type) {
    case "step":
      return <StageStepRow line={line} />;
    case "helper":
      return <StageHelperRow line={line} />;
    case "task_end":
      return <StageTaskEndRow line={line} />;
    default:
      return <StageOtherRow line={line} />;
  }
}
