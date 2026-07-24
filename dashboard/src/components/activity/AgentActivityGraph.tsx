interface AgentActivityGraphProps {
  activeAgent: string | null;
}

const SPECIALISTS: { id: string; label: string; y: number }[] = [
  { id: "coding_agent", label: "coding", y: 25 },
  { id: "research_agent", label: "research", y: 75 },
  { id: "life_admin_agent", label: "life_admin", y: 125 },
  { id: "mac_control_agent", label: "mac_control", y: 175 },
];

const SUPERVISOR_X = 30;
const SUPERVISOR_Y = 95;
const SPECIALIST_X = 220;

// The redesign's "Live agent activity" node graph — supervisor at the
// hub, one line out to each of the four specialists (STEPS.md 94's
// agents-as-tools architecture: supervisor.py's call_specialist tools).
// Layout/shape only from the mock; colors stay this app's own tokens
// (--operator for "currently active," --border/--muted-foreground for at
// rest), per the user's explicit "don't change the colors" call. Colors
// are set via inline `style` (not SVG presentation attributes) so the
// `var(--token)` references resolve reliably through Tauri's webview.
export function AgentActivityGraph({ activeAgent }: AgentActivityGraphProps) {
  return (
    <svg
      viewBox="0 0 260 190"
      className="h-auto w-full overflow-visible"
      role="img"
      aria-label="Agent activity graph"
    >
      {SPECIALISTS.map((specialist) => {
        const isActive = activeAgent === specialist.id;
        return (
          <line
            key={`line-${specialist.id}`}
            x1={SUPERVISOR_X}
            y1={SUPERVISOR_Y}
            x2={SPECIALIST_X}
            y2={specialist.y}
            style={{
              stroke: isActive ? "var(--operator)" : "var(--border)",
              strokeWidth: isActive ? 2.5 : 2,
              strokeDasharray: isActive ? "6 6" : undefined,
            }}
          >
            {isActive && (
              <animate
                attributeName="stroke-dashoffset"
                from="0"
                to="-24"
                dur="0.6s"
                repeatCount="indefinite"
              />
            )}
          </line>
        );
      })}

      <circle cx={SUPERVISOR_X} cy={SUPERVISOR_Y} r={13} style={{ fill: "var(--operator)" }} />
      <text
        x={SUPERVISOR_X}
        y={SUPERVISOR_Y + 25}
        style={{ fill: "var(--muted-foreground)" }}
        fontSize={9}
        fontFamily="var(--font-mono)"
        textAnchor="middle"
      >
        supervisor
      </text>

      {SPECIALISTS.map((specialist) => {
        const isActive = activeAgent === specialist.id;
        return (
          <g key={specialist.id}>
            <circle
              cx={SPECIALIST_X}
              cy={specialist.y}
              r={isActive ? 10 : 8}
              style={{
                fill: isActive ? "var(--operator)" : "var(--muted-foreground)",
                opacity: isActive ? 1 : 0.5,
              }}
            >
              {isActive && (
                <animate
                  attributeName="opacity"
                  values="1;0.4;1"
                  dur="1.2s"
                  repeatCount="indefinite"
                />
              )}
            </circle>
            <text
              x={SPECIALIST_X - 24}
              y={specialist.y - 7}
              style={{ fill: isActive ? "var(--foreground)" : "var(--muted-foreground)" }}
              fontSize={9}
              fontFamily="var(--font-mono)"
              fontWeight={isActive ? 600 : 400}
              textAnchor="end"
            >
              {specialist.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
