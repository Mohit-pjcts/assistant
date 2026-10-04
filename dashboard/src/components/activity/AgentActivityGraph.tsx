import { useEffect, useMemo, useRef, useState } from "react";

interface AgentActivityGraphProps {
  activeAgent: string | null;
  activeTool: string | null;
}

interface SpecialistDef {
  id: string;
  label: string;
  baseY: number;
}

// backstage/onstage: Stage's code-backed specialists (stage.py) — their
// agent_activity events use the same shape as every LLM specialist's.
const SPECIALISTS: SpecialistDef[] = [
  { id: "coding_agent", label: "coding", baseY: 20 },
  { id: "research_agent", label: "research", baseY: 53 },
  { id: "life_admin_agent", label: "life_admin", baseY: 86 },
  { id: "mac_control_agent", label: "mac_control", baseY: 119 },
  { id: "phone_agent", label: "phone", baseY: 152 },
  { id: "backstage", label: "backstage", baseY: 185 },
  { id: "onstage", label: "onstage", baseY: 218 },
];

const SUPERVISOR_X = 30;
const SUPERVISOR_Y = 120;
const SPECIALIST_X = 220;

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SCRAMBLE_FRAMES = 10;
const SCRAMBLE_INTERVAL_MS = 26;

interface Particle {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  kind: "dispatch" | "response";
}

interface Ping {
  id: number;
}

function fitToolName(name: string): string {
  return name.length > 16 ? `${name.slice(0, 15)}…` : name;
}

// The redesign's "Live agent activity" node graph, upgraded from Phase
// 19's fixed vertical layout to real physics (PLAN.md Phase 28 step 4):
// bounded organic drift per specialist, dispatch/response particles
// tracing the real supervisor<->specialist boundary, scramble-decode tool
// names, hover-to-highlight — ported from instrument/instrument.html's
// own `aa`-prefixed standalone build, reconciled here with the REAL data
// hook (useAgentActivity.ts's activeAgent/activeTool, from real SSE
// `activity` frames) rather than the mockup's own demo-only random
// activation loop, which is dropped entirely — this component only ever
// animates in response to real backend events.
//
// Colors are still this app's own tokens (--operator/--border/
// --muted-foreground/--foreground), never the mockup's own hex values —
// same "don't change the colors" call Phase 19 made for this exact
// component, still honored; --operator now resolving to the Phase 28
// violet accent is what actually reskins this graph, not a code change
// here.
//
// Node/spoke positions are refs mutated directly inside a
// requestAnimationFrame loop, NOT React state — the mockup's own
// technique, translated to React idiom: a 60fps position update would
// force a full re-render every frame if it went through setState. The
// `transform`/`x2`/`y2` attributes are deliberately never passed as JSX
// props on the elements this loop touches (only set once, via each ref
// callback, on mount) — if they were also controlled props, React would
// reconcile them back to their static initial value on every OTHER
// state change (a new particle, a tool-label update), fighting the rAF
// loop and producing a visible snap-back glitch.
export function AgentActivityGraph({ activeAgent, activeTool }: AgentActivityGraphProps) {
  const prevActiveRef = useRef<string | null>(null);
  const nodeRefs = useRef<Record<string, SVGGElement | null>>({});
  const spokeRefs = useRef<Record<string, SVGLineElement | null>>({});
  const positionsRef = useRef<Record<string, { x: number; y: number }>>(
    Object.fromEntries(SPECIALISTS.map((s) => [s.id, { x: SPECIALIST_X, y: s.baseY }])),
  );
  const exciteRef = useRef<Record<string, number>>(
    Object.fromEntries(SPECIALISTS.map((s) => [s.id, 0])),
  );
  const particleIdRef = useRef(0);
  const pingIdRef = useRef(0);

  const [particles, setParticles] = useState<Particle[]>([]);
  const [pings, setPings] = useState<Ping[]>([]);
  const [toolLabels, setToolLabels] = useState<Record<string, string>>({});
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const reduceMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // Organic drift — bounded sine/cosine wobble per specialist, seeded by
  // index so each one drifts on its own phase/frequency rather than in
  // lockstep. `excite` spikes to 1 on dispatch and decays ~1.5%/frame,
  // giving a brief amplitude "jolt" when a specialist actually starts
  // doing something, same as the mockup's own feel.
  useEffect(() => {
    if (reduceMotion) return;
    const params = SPECIALISTS.map((s, i) => ({
      id: s.id,
      baseY: s.baseY,
      f1: 0.11 + i * 0.017,
      p1: i * 1.7,
      f2: 0.05 + i * 0.011,
      p2: i * 2.3 + 1,
      ampX: 6 + (i % 3) * 1.5,
      ampY: 8 + (i % 2) * 2.5,
    }));
    let raf: number;
    const start = performance.now();
    function tick(now: number) {
      const t = (now - start) / 1000;
      for (const p of params) {
        const boost = 1 + exciteRef.current[p.id] * 0.9;
        const dx =
          (Math.sin(t * p.f1 + p.p1) * p.ampX + Math.sin(t * p.f2 + p.p2) * p.ampX * 0.4) * boost;
        const dy =
          (Math.cos(t * p.f1 * 1.3 + p.p1) * p.ampY + Math.cos(t * p.f2 + p.p2) * p.ampY * 0.4) *
          boost;
        const x = SPECIALIST_X + dx;
        const y = p.baseY + dy;
        positionsRef.current[p.id] = { x, y };
        exciteRef.current[p.id] *= 0.985;
        nodeRefs.current[p.id]?.setAttribute("transform", `translate(${x},${y})`);
        const spoke = spokeRefs.current[p.id];
        if (spoke) {
          spoke.setAttribute("x2", String(x));
          spoke.setAttribute("y2", String(y));
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduceMotion]);

  // Dispatch/response particles, fired off real activeAgent transitions
  // (the supervisor->specialist boundary from useAgentActivity.ts) —
  // never a timer, never simulated.
  useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = activeAgent;
    if (activeAgent === prev) return;

    if (activeAgent && positionsRef.current[activeAgent]) {
      exciteRef.current[activeAgent] = 1;
      if (!reduceMotion) {
        const pos = positionsRef.current[activeAgent];
        setParticles((ps) => [
          ...ps,
          {
            id: particleIdRef.current++,
            x1: SUPERVISOR_X,
            y1: SUPERVISOR_Y,
            x2: pos.x,
            y2: pos.y,
            kind: "dispatch",
          },
        ]);
        setPings((ping) => [...ping, { id: pingIdRef.current++ }]);
      }
    }
    if (prev && positionsRef.current[prev]) {
      if (!reduceMotion) {
        const pos = positionsRef.current[prev];
        setParticles((ps) => [
          ...ps,
          {
            id: particleIdRef.current++,
            x1: pos.x,
            y1: pos.y,
            x2: SUPERVISOR_X,
            y2: SUPERVISOR_Y,
            kind: "response",
          },
        ]);
      }
      setToolLabels((labels) => ({ ...labels, [prev]: "" }));
    }
  }, [activeAgent, reduceMotion]);

  // Scramble-decode reveal of the active tool name.
  useEffect(() => {
    if (!activeAgent || !activeTool) return;
    const final = fitToolName(activeTool);
    if (reduceMotion) {
      setToolLabels((labels) => ({ ...labels, [activeAgent]: final }));
      return;
    }
    let frame = 0;
    const interval = setInterval(() => {
      frame++;
      const locked = Math.floor((frame / SCRAMBLE_FRAMES) * final.length);
      let out = "";
      for (let i = 0; i < final.length; i++) {
        out +=
          i < locked ? final[i] : SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
      }
      setToolLabels((labels) => ({ ...labels, [activeAgent]: out }));
      if (frame >= SCRAMBLE_FRAMES) clearInterval(interval);
    }, SCRAMBLE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [activeAgent, activeTool, reduceMotion]);

  return (
    <svg
      viewBox="0 0 260 240"
      className="h-auto w-full overflow-visible"
      role="img"
      aria-label="Agent activity graph"
    >
      {SPECIALISTS.map((s) => {
        const isActive = activeAgent === s.id;
        const isHighlighted = isActive || hoveredId === s.id || hoveredId === "supervisor";
        return (
          <line
            key={`spoke-${s.id}`}
            ref={(el) => {
              spokeRefs.current[s.id] = el;
              if (el && el.getAttribute("x2") === null) {
                el.setAttribute("x2", String(SPECIALIST_X));
                el.setAttribute("y2", String(s.baseY));
              }
            }}
            x1={SUPERVISOR_X}
            y1={SUPERVISOR_Y}
            data-testid={`spoke-${s.id}`}
            data-highlighted={isHighlighted}
            style={{
              stroke: isActive
                ? "var(--operator)"
                : isHighlighted
                  ? "var(--foreground)"
                  : "var(--border)",
              strokeWidth: isActive ? 2.5 : isHighlighted ? 2 : 1.5,
              strokeDasharray: isActive ? "6 6" : undefined,
              transition: "stroke .3s ease, stroke-width .3s ease",
            }}
          >
            {isActive && !reduceMotion && (
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

      {particles.map((p) => (
        <circle
          key={p.id}
          r={2.5}
          data-testid={`particle-${p.kind}`}
          style={{
            fill: p.kind === "dispatch" ? "var(--operator)" : "var(--muted-foreground)",
            offsetPath: `path('M${p.x1} ${p.y1} L${p.x2} ${p.y2}')`,
            animation: "agent-activity-travel 700ms linear forwards",
          }}
          onAnimationEnd={() => setParticles((ps) => ps.filter((existing) => existing.id !== p.id))}
        />
      ))}

      {pings.map((ping) => (
        <circle
          key={ping.id}
          cx={SUPERVISOR_X}
          cy={SUPERVISOR_Y}
          r={13}
          data-testid="supervisor-ping"
          style={{
            fill: "none",
            stroke: "var(--operator)",
            strokeWidth: 1.2,
            animation: "agent-activity-ping 1.1s ease-out forwards",
          }}
          onAnimationEnd={() => setPings((ps) => ps.filter((existing) => existing.id !== ping.id))}
        />
      ))}

      <g
        onMouseEnter={() => setHoveredId("supervisor")}
        onMouseLeave={() => setHoveredId((current) => (current === "supervisor" ? null : current))}
      >
        <circle cx={SUPERVISOR_X} cy={SUPERVISOR_Y} r={13} style={{ fill: "var(--operator)" }}>
          {!reduceMotion && (
            <animate attributeName="r" values="13;14;13" dur="3.4s" repeatCount="indefinite" />
          )}
        </circle>
        <circle
          cx={SUPERVISOR_X}
          cy={SUPERVISOR_Y}
          r={20}
          style={{ fill: "transparent", cursor: "default" }}
          data-testid="supervisor-hit"
        />
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
      </g>

      {SPECIALISTS.map((specialist) => {
        const isActive = activeAgent === specialist.id;
        const isHovered = hoveredId === specialist.id;
        const tool = toolLabels[specialist.id];
        return (
          <g
            key={specialist.id}
            data-testid={`node-${specialist.id}`}
            ref={(el) => {
              nodeRefs.current[specialist.id] = el;
              if (el && el.getAttribute("transform") === null) {
                el.setAttribute("transform", `translate(${SPECIALIST_X},${specialist.baseY})`);
              }
            }}
            onMouseEnter={() => setHoveredId(specialist.id)}
            onMouseLeave={() =>
              setHoveredId((current) => (current === specialist.id ? null : current))
            }
          >
            {(isActive || isHovered) && (
              <circle r={22} style={{ fill: "var(--operator)", opacity: 0.18 }} />
            )}
            <circle
              r={isActive ? 10 : 8}
              style={{
                fill: isActive || isHovered ? "var(--operator)" : "var(--muted-foreground)",
                opacity: isActive ? 1 : isHovered ? 0.8 : 0.5,
              }}
            >
              {isActive && !reduceMotion && (
                <animate
                  attributeName="opacity"
                  values="1;0.4;1"
                  dur="1.2s"
                  repeatCount="indefinite"
                />
              )}
            </circle>
            <circle r={20} style={{ fill: "transparent" }} />
            <text
              x={-24}
              y={-7}
              style={{
                fill: isActive || isHovered ? "var(--foreground)" : "var(--muted-foreground)",
              }}
              fontSize={9}
              fontFamily="var(--font-mono)"
              fontWeight={isActive ? 600 : 400}
              textAnchor="end"
            >
              {specialist.label}
            </text>
            {tool && (
              <text
                x={-24}
                y={6}
                style={{ fill: "var(--muted-foreground)", opacity: 0.7 }}
                fontSize={8}
                fontFamily="var(--font-mono)"
                textAnchor="end"
              >
                {tool}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
