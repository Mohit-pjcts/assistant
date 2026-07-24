interface StatusPillProps {
  agent: string | null;
  tool: string | null;
}

// Header status indicator — the "Oni" redesign's copper "research_agent ·
// searching the web" pill, restyled onto THIS app's own existing tokens
// (the user's explicit call: layout/structure from the redesign, not its
// hex palette). Reuses `--operator` — this app's existing "selected/
// active" rail-grammar token (index.css's block comment) — rather than
// introducing a new color meaning just for "an agent is currently working."
export function StatusPill({ agent, tool }: StatusPillProps) {
  if (!agent) {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
        <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/50" />
        Idle
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-1.5 rounded-full border border-operator/35 bg-operator/10 px-2.5 py-1 font-mono text-xs text-operator"
      data-testid="status-pill-active"
    >
      <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-operator" />
      {agent}
      {tool && <span className="text-operator/70"> · {tool}</span>}
    </span>
  );
}
