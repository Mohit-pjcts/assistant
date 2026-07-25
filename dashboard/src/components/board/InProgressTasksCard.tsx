import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { fetchBoardTasks, type BoardTask } from "@/lib/api";

// Right-rail glance at what's actually in flight on the kanban board — the
// same data Board tab + life_admin_agent's board_tools.py both read/write.
// Polls independently of the Board tab (Base UI's Tabs unmounts inactive
// panels, so this card wouldn't otherwise see updates the agent makes while
// you're looking at Chat) — same external-update-poll reasoning ChatPanel
// and KanbanBoard's own poll already use.
const POLL_MS = 4000;

const PRIORITY_VARIANT: Record<BoardTask["priority"], "destructive" | "secondary" | "outline"> = {
  high: "destructive",
  medium: "secondary",
  low: "outline",
};

export function InProgressTasksCard() {
  const [tasks, setTasks] = useState<BoardTask[]>([]);

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchBoardTasks()
        .then((all) => {
          if (!cancelled) setTasks(all.filter((t) => t.column === "in-progress"));
        })
        .catch(() => {
          // Best-effort — a transient poll failure just retries next tick.
        });
    }
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (tasks.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing in progress.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {tasks.map((task) => (
        <li key={task.id} className="flex flex-col gap-1 rounded-md border p-2 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">{task.ref}</span>
            <Badge variant={PRIORITY_VARIANT[task.priority]} className="text-[0.6rem]">
              {task.priority}
            </Badge>
          </div>
          <span className="font-heading truncate">{task.title}</span>
        </li>
      ))}
    </ul>
  );
}
