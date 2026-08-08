import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, X, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Project, ThreadSummary } from "@/lib/api";
import {
  buildRadialGraph,
  computeGraphDimensions,
  DEFAULT_FORCE_PARAMS,
  linkWidth,
  nodeRadius,
  stepSimulation,
  type RadialForceParams,
  type RadialNode,
} from "./radialSimulation";

// Below this zoom factor, hide every label/number entirely (Obsidian's
// own graph-view behavior, at the user's explicit direction: with a real
// vault running to 70+ threads, never hide DATA to stay readable — hide
// TEXT once zoomed out far enough that it would just be illegible noise,
// and let the user zoom back in for detail). Independent of the existing
// "Show labels"/"Show numbers" toggles and the fade-threshold slider,
// which still apply normally above this zoom level.
const LABEL_ZOOM_THRESHOLD = 0.5;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

interface RadialChatSelectorProps {
  projects: Project[];
  threads: ThreadSummary[];
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onClose: () => void;
}

interface DisplayFlags {
  showProjects: boolean;
  showLabels: boolean;
  showNumbers: boolean;
  activeProjectOnly: boolean;
  showArrows: boolean;
}

const DEFAULT_FLAGS: DisplayFlags = {
  showProjects: true,
  showLabels: true,
  showNumbers: true,
  activeProjectOnly: false,
  showArrows: false,
};

// Every Filters/Display/Forces control below persists across close/reopen
// and app restarts (localStorage, same "pa-" prefix as uiScale.tsx/
// theme.tsx) — the panel used to remount to these hardcoded defaults
// every time the overlay reopened (it only ever mounts while open), so
// retuning the physics or hiding project nodes never stuck. Search text
// and an isolated project stay session-only view state, not durable
// preferences, and are deliberately excluded.
const RADIAL_SETTINGS_STORAGE_KEY = "pa-radial-graph-settings";

interface PersistedRadialSettings {
  flags: DisplayFlags;
  fadeThreshold: number;
  sizeMult: number;
  widthMult: number;
  force: RadialForceParams;
}

function loadRadialSettings(): PersistedRadialSettings | null {
  try {
    const raw = localStorage.getItem(RADIAL_SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      flags: { ...DEFAULT_FLAGS, ...parsed.flags },
      fadeThreshold: typeof parsed.fadeThreshold === "number" ? parsed.fadeThreshold : 0,
      sizeMult: typeof parsed.sizeMult === "number" ? parsed.sizeMult : 1,
      widthMult: typeof parsed.widthMult === "number" ? parsed.widthMult : 1,
      force: { ...DEFAULT_FORCE_PARAMS, ...parsed.force },
    };
  } catch {
    return null;
  }
}

function saveRadialSettings(settings: PersistedRadialSettings): void {
  localStorage.setItem(RADIAL_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

function clearRadialSettings(): void {
  localStorage.removeItem(RADIAL_SETTINGS_STORAGE_KEY);
}

// The Forces/Display sliders store their MAPPED value (e.g. an actual
// repel force), not the 0-100-ish slider position — these invert that
// mapping so a returning user's slider thumb lands back where they left
// it instead of snapping to the hardcoded default position. Every
// forward mapping lives inline in each RadialSliderRow's own onChange
// below; keep both directions in sync if either changes.
function computeRawSliderDefaults(persisted: PersistedRadialSettings | null) {
  if (!persisted) {
    return {
      fadeThreshold: 0,
      nodeSize: 100,
      linkThickness: 100,
      centerForce: 35,
      repelForce: 55,
      linkForce: 45,
      linkDist: 45,
    };
  }
  return {
    fadeThreshold: persisted.fadeThreshold,
    nodeSize: persisted.sizeMult * 100,
    linkThickness: persisted.widthMult * 100,
    centerForce: persisted.force.center / 0.0006,
    repelForce: (persisted.force.repel - 150) / 55,
    linkForce: (persisted.force.linkForce - 0.01) / 0.0035,
    linkDist: (persisted.force.linkDist - 20) / 1.1,
  };
}

function truncate(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

// PLAN.md Phase 28 step 5 — the radial chat selector, the largest and
// newest piece of this phase. Ported from instrument/instrument.html's
// own hand-rolled force-directed graph (radialSimulation.ts owns the
// actual physics math; this component owns SVG rendering, drag, and the
// settings panel), wired to REAL `projects`/`threads` data instead of
// the mockup's fabricated `VAULT` array — including a case the mockup
// never had to handle (a thread with no project), which
// `buildRadialGraph` links directly to the hub.
//
// Same ref-driven-position lesson as AgentActivityGraph.tsx (Phase 28
// step 4): node/link DOM attributes the simulation tick touches every
// frame (transform, x1/y1/x2/y2) are never passed as controlled JSX
// props — only set once via each ref callback, on mount. Live settings
// (search text, isolated project, display flags, force params) are read
// from refs inside the SAME tick loop rather than props, so tuning a
// slider doesn't need to restart the animation loop's own effect.
export function RadialChatSelector({
  projects,
  threads,
  activeThreadId,
  onSelectThread,
  onClose,
}: RadialChatSelectorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const viewGroupRef = useRef<SVGGElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const nodeElRefs = useRef(new Map<string, SVGGElement>());
  const linkElRefs = useRef(new Map<string, SVGLineElement>());
  const dragRef = useRef<{
    id: string;
    pointerId: number;
    moved: boolean;
    startX: number;
    startY: number;
  } | null>(null);
  // Pan/zoom state for the graph's own <g> wrapper — a ref, not React
  // state, for the same reason node positions are refs (AgentActivityGraph
  // and this component's own node-position lesson): wheel/pointermove can
  // fire far faster than a React re-render should run, so the physics
  // tick loop applies this transform directly via setAttribute, same as
  // every other per-frame DOM write here.
  const viewTransformRef = useRef({ x: 0, y: 0, k: 1 });
  const panRef = useRef<{ lastX: number; lastY: number } | null>(null);

  // Real vaults run to 70+ threads (confirmed live against production
  // data) — the mockup's own simulation was only ever tuned/tested
  // against 9 chats. At the user's own explicit direction: never hide
  // data to cope (no cap, no "isolate before rendering" gate) — instead
  // give the simulation a canvas that actually grows with node count, and
  // let pan/zoom (below) handle readability the way Obsidian's own graph
  // view does. Node count alone (not the graph itself, which doesn't
  // exist yet) determines canvas size, avoiding a circular dependency.
  const totalNodeCount = 1 + projects.length + threads.length;
  const { width: graphWidth, height: graphHeight } = useMemo(
    () => computeGraphDimensions(totalNodeCount),
    [totalNodeCount],
  );
  const { nodes, links } = useMemo(
    () => buildRadialGraph(projects, threads, graphWidth, graphHeight),
    [projects, threads, graphWidth, graphHeight],
  );
  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const [isolatedProjectId, setIsolatedProjectId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [, bumpRenderTick] = useState(0);
  // Uncontrolled inputs (search/toggles/sliders) only pick up a fresh
  // `defaultValue`/`defaultChecked` on mount, not on a parent re-render —
  // "Reset to defaults" bumps this to remount the whole settings body
  // (via the key= below) rather than fighting each input's own
  // uncontrolled state individually. Re-reading persisted settings off
  // this same generation means a reset (which clears storage first) also
  // makes the remounted panel show the real hardcoded defaults rather
  // than the values it just cleared.
  const [resetGeneration, setResetGeneration] = useState(0);
  const persisted = useMemo(() => loadRadialSettings(), [resetGeneration]);
  const rawSliderDefaults = useMemo(() => computeRawSliderDefaults(persisted), [persisted]);

  const paramsRef = useRef<RadialForceParams>(
    persisted ? { ...persisted.force } : { ...DEFAULT_FORCE_PARAMS },
  );
  const sizeMultRef = useRef(persisted ? persisted.sizeMult : 1);
  const widthMultRef = useRef(persisted ? persisted.widthMult : 1);
  const fadeThresholdRef = useRef(persisted ? persisted.fadeThreshold : 0);
  const searchRef = useRef("");
  const flagsRef = useRef<DisplayFlags>(persisted ? { ...persisted.flags } : { ...DEFAULT_FLAGS });

  const reduceMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  function isDimmed(node: RadialNode): boolean {
    const query = searchRef.current;
    if (query) {
      if (node.type === "hub") return false;
      if (node.type === "chat") return !node.label.toLowerCase().includes(query);
      if (node.type === "project") {
        return !nodes.some(
          (n) =>
            n.type === "chat" && projectOf(n) === node.id && n.label.toLowerCase().includes(query),
        );
      }
    }
    const target =
      isolatedProjectId ?? (flagsRef.current.activeProjectOnly ? projectOf(activeNode()) : null);
    if (target == null) return false;
    if (node.type === "hub") return false;
    return projectOf(node) !== target;
  }

  function projectOf(node: RadialNode | undefined): string | null {
    if (!node) return null;
    if (node.type === "project") return node.id;
    if (node.type === "chat") {
      const link = links.find((l) => l.target === node.id);
      return link && link.tier === "leaf" ? link.source : null;
    }
    return null;
  }

  function activeNode(): RadialNode | undefined {
    return activeThreadId ? nodesById.get(activeThreadId) : undefined;
  }

  // Physics tick — runs continuously while mounted (this component only
  // ever mounts while the overlay is open), reading live settings from
  // refs so a slider/toggle change never needs to restart this effect.
  useEffect(() => {
    let raf: number;
    function tick() {
      if (!reduceMotion) {
        stepSimulation(nodes, links, paramsRef.current, graphWidth, graphHeight);
      }
      const view = viewTransformRef.current;
      viewGroupRef.current?.setAttribute(
        "transform",
        `translate(${view.x},${view.y}) scale(${view.k})`,
      );
      svgRef.current?.classList.toggle("radial-hide-labels", view.k < LABEL_ZOOM_THRESHOLD);
      for (const node of nodes) {
        const el = nodeElRefs.current.get(node.id);
        if (el) {
          el.setAttribute("transform", `translate(${node.x.toFixed(1)},${node.y.toFixed(1)})`);
          el.classList.toggle("opacity-25", isDimmed(node));
          const isSelected = node.type === "chat" && node.id === activeThreadId;
          el.classList.toggle("opacity-100", isSelected || hoveredId === node.id);
        }
        const ring = el?.querySelector<SVGCircleElement>("[data-role=ring]");
        if (ring) ring.setAttribute("r", String(nodeRadius(node, sizeMultRef.current)));
      }
      for (const link of links) {
        const el = linkElRefs.current.get(`${link.source}->${link.target}`);
        if (!el) continue;
        const a = nodesById.get(link.source);
        const b = nodesById.get(link.target);
        if (!a || !b) continue;
        el.setAttribute("x1", String(a.x));
        el.setAttribute("y1", String(a.y));
        el.setAttribute("x2", String(b.x));
        el.setAttribute("y2", String(b.y));
        el.style.strokeWidth = String(
          linkWidth(link, nodesById, activeThreadId, widthMultRef.current),
        );
        el.classList.toggle("opacity-20", isDimmed(a) || isDimmed(b));
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    nodes,
    links,
    reduceMotion,
    activeThreadId,
    hoveredId,
    isolatedProjectId,
    graphWidth,
    graphHeight,
  ]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Wheel-to-zoom, centered on the cursor. Attached via a real
  // `addEventListener(..., { passive: false })` effect rather than JSX
  // `onWheel` — React (and browsers generally) registers wheel listeners
  // as passive by default for scroll performance, which silently makes
  // `preventDefault()` a no-op; without it the page scrolls instead of
  // the graph zooming.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const cursor = svgPointFromClient(event.clientX, event.clientY);
      const view = viewTransformRef.current;
      const nodeSpaceX = (cursor.x - view.x) / view.k;
      const nodeSpaceY = (cursor.y - view.y) / view.k;
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nextK = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
      viewTransformRef.current = {
        k: nextK,
        x: cursor.x - nodeSpaceX * nextK,
        y: cursor.y - nodeSpaceY * nextK,
      };
    }
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const CENTER_POINT = { x: graphWidth / 2, y: graphHeight / 2 };

  function svgPointFromClient(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current;
    if (!svg) return CENTER_POINT;
    // Real browsers implement createSVGPoint/getScreenCTM; some test
    // environments (confirmed: jsdom) don't implement either at all —
    // fall back to the canvas center rather than crash the drag handler.
    try {
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const matrix = svg.getScreenCTM();
      if (!matrix) return CENTER_POINT;
      const transformed = pt.matrixTransform(matrix.inverse());
      return { x: transformed.x, y: transformed.y };
    } catch {
      return CENTER_POINT;
    }
  }

  function handleActivate(node: RadialNode) {
    if (node.type === "chat") {
      onSelectThread(node.id);
      window.setTimeout(onClose, 260);
    } else if (node.type === "project") {
      setIsolatedProjectId((current) => (current === node.id ? null : node.id));
    } else {
      setIsolatedProjectId(null);
      searchRef.current = "";
      // The search input is uncontrolled (no `value=`), so a React
      // re-render alone wouldn't clear its visible text — set the DOM
      // value directly, same as the mockup's own hub-click behavior
      // (`document.getElementById('rs-search').value = ''`).
      if (searchInputRef.current) searchInputRef.current.value = "";
    }
  }

  function handlePointerDown(node: RadialNode, event: React.PointerEvent<SVGGElement>) {
    // Same defensive try/catch as the mockup's own drag handler —
    // setPointerCapture can throw (an invalid pointerId, a disconnected
    // element) and isn't implemented at all in every test environment
    // (confirmed: jsdom has no Element.setPointerCapture), but capture
    // failing shouldn't block the drag/click interaction itself.
    try {
      (event.target as Element).setPointerCapture(event.pointerId);
    } catch {
      // ignore — see comment above
    }
    dragRef.current = {
      id: node.id,
      pointerId: event.pointerId,
      moved: false,
      startX: event.clientX,
      startY: event.clientY,
    };
    event.preventDefault();
  }

  function handlePointerMove(event: React.PointerEvent<SVGGElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) drag.moved = true;
    const node = nodesById.get(drag.id);
    if (!node) return;
    // Nodes live in "node space" (what the physics simulation operates
    // on); the cursor's viewbox-space point needs to travel back THROUGH
    // the current pan/zoom transform to land in that same space —
    // otherwise dragging after panning/zooming would visibly misplace
    // the node relative to the actual cursor.
    const p = svgPointFromClient(event.clientX, event.clientY);
    const view = viewTransformRef.current;
    node.fx = (p.x - view.x) / view.k;
    node.fy = (p.y - view.y) / view.k;
  }

  function handlePointerUp(node: RadialNode) {
    const drag = dragRef.current;
    if (!drag || drag.id !== node.id) return;
    dragRef.current = null;
    node.fx = null;
    node.fy = null;
    if (!drag.moved) handleActivate(node);
  }

  function handleBackgroundPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    // Only start a pan when the pointerdown lands directly on the SVG
    // background — a node-originated pointerdown bubbles up with
    // `event.target` set to the node's own descendant element, never the
    // outer <svg> itself, so this naturally never fires mid-node-drag.
    if (event.target !== svgRef.current) return;
    const p = svgPointFromClient(event.clientX, event.clientY);
    panRef.current = { lastX: p.x, lastY: p.y };
    try {
      (event.target as Element).setPointerCapture(event.pointerId);
    } catch {
      // see the node-drag handler's own comment on this — same environment gap
    }
  }

  function handleBackgroundPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const pan = panRef.current;
    if (!pan) return;
    const p = svgPointFromClient(event.clientX, event.clientY);
    viewTransformRef.current = {
      ...viewTransformRef.current,
      x: viewTransformRef.current.x + (p.x - pan.lastX),
      y: viewTransformRef.current.y + (p.y - pan.lastY),
    };
    panRef.current = { lastX: p.x, lastY: p.y };
  }

  function handleBackgroundPointerUp() {
    panRef.current = null;
  }

  function handleResetView() {
    viewTransformRef.current = { x: 0, y: 0, k: 1 };
  }

  function handleAnimateKick() {
    for (const node of nodes) {
      if (node.fx == null) {
        node.vx += (Math.random() - 0.5) * 46;
        node.vy += (Math.random() - 0.5) * 46;
      }
    }
  }

  function persistSettings() {
    saveRadialSettings({
      flags: { ...flagsRef.current },
      fadeThreshold: fadeThresholdRef.current,
      sizeMult: sizeMultRef.current,
      widthMult: widthMultRef.current,
      force: { ...paramsRef.current },
    });
  }

  function handleResetDefaults() {
    paramsRef.current = { ...DEFAULT_FORCE_PARAMS };
    sizeMultRef.current = 1;
    widthMultRef.current = 1;
    fadeThresholdRef.current = 0;
    searchRef.current = "";
    flagsRef.current = { ...DEFAULT_FLAGS };
    setIsolatedProjectId(null);
    clearRadialSettings();
    setResetGeneration((n) => n + 1); // remounts the settings body (key= below) at its real default values
  }

  const projectList = projects.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    count: threads.filter((t) => t.project_id === p.id).length,
  }));

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background/97 backdrop-blur-sm"
      role="dialog"
      aria-label="Select a chat"
    >
      <div className="flex items-center justify-between border-b px-5 py-3.5">
        <div>
          <div className="font-heading text-lg">Select a chat</div>
          <div className="font-mono text-xs text-muted-foreground">
            hub → project → chat, real physics — hold and drag any bubble
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleResetView}
            aria-label="Reset zoom and pan"
            data-testid="radial-reset-view"
          >
            <Maximize2 className="size-3.5" />
          </Button>
          <Button
            variant={settingsOpen ? "secondary" : "ghost"}
            size="icon-xs"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-label="Toggle filters panel"
            data-testid="radial-settings-toggle"
          >
            <SlidersHorizontal className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close">
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <svg
            ref={svgRef}
            data-testid="radial-svg"
            viewBox={`0 0 ${graphWidth} ${graphHeight}`}
            className="absolute inset-0 h-full w-full touch-none"
            style={{ overflow: "visible" }}
            onPointerDown={handleBackgroundPointerDown}
            onPointerMove={handleBackgroundPointerMove}
            onPointerUp={handleBackgroundPointerUp}
            onPointerCancel={handleBackgroundPointerUp}
          >
            {/* Pan/zoom lives on this one wrapping group — never a
                controlled `transform` prop (same rule as node positions
                below): the tick loop is the only thing that ever sets
                it, via viewGroupRef, so an unrelated re-render (a
                setting toggle) can't reconcile it back to a stale value. */}
            <g ref={viewGroupRef}>
              {links.map((link) => (
                <line
                  key={`${link.source}->${link.target}`}
                  ref={(el) => {
                    if (el) linkElRefs.current.set(`${link.source}->${link.target}`, el);
                    else linkElRefs.current.delete(`${link.source}->${link.target}`);
                  }}
                  stroke="var(--border)"
                  style={{ transition: "opacity .3s ease" }}
                />
              ))}
              {nodes.map((node) => {
                if (node.type === "project" && !flagsRef.current.showProjects) return null;
                const label = node.type === "hub" ? "Oni" : truncate(node.label, 34);
                return (
                  <g
                    key={node.id}
                    ref={(el) => {
                      if (el) {
                        nodeElRefs.current.set(node.id, el);
                        if (el.getAttribute("transform") === null) {
                          el.setAttribute("transform", `translate(${node.x},${node.y})`);
                        }
                      } else {
                        nodeElRefs.current.delete(node.id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={label}
                    data-testid={`radial-node-${node.id}`}
                    className="cursor-pointer outline-none"
                    style={{ color: node.color ?? "var(--operator)" }}
                    onPointerDown={(e) => handlePointerDown(node, e)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={() => handlePointerUp(node)}
                    onPointerCancel={() => handlePointerUp(node)}
                    onMouseEnter={() => setHoveredId(node.id)}
                    onMouseLeave={() =>
                      setHoveredId((current) => (current === node.id ? null : current))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleActivate(node);
                      }
                    }}
                  >
                    <circle
                      data-role="ring"
                      r={nodeRadius(node, sizeMultRef.current)}
                      fill={node.type === "hub" ? "currentColor" : "var(--card)"}
                      stroke="currentColor"
                      strokeWidth={node.type === "hub" ? 0 : 1.6}
                    />
                    {node.type !== "hub" && (
                      <circle
                        r={Math.max(2, nodeRadius(node, sizeMultRef.current) * 0.22)}
                        fill="currentColor"
                      />
                    )}
                    {flagsRef.current.showLabels && (
                      <text
                        x={node.type === "hub" ? 0 : nodeRadius(node, sizeMultRef.current) + 7}
                        y={node.type === "hub" ? nodeRadius(node, sizeMultRef.current) + 16 : 4}
                        textAnchor={node.type === "hub" ? "middle" : "start"}
                        fontFamily="var(--font-mono)"
                        fontSize={11.5}
                        fill={node.type === "hub" ? "currentColor" : "var(--foreground)"}
                      >
                        {label}
                      </text>
                    )}
                    {node.type === "chat" && flagsRef.current.showNumbers && node.order != null && (
                      <text
                        y={-nodeRadius(node, sizeMultRef.current) - 6}
                        textAnchor="middle"
                        fontFamily="var(--font-mono)"
                        fontSize={9}
                        fill="var(--muted-foreground)"
                      >
                        {String(node.order).padStart(2, "0")}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border bg-card/90 px-3 py-1 font-mono text-[0.65rem] text-muted-foreground">
            drag to reposition · click to open · scroll to zoom · number = order
          </div>
        </div>

        {settingsOpen && (
          <div
            key={resetGeneration}
            className={cn(
              "fixed inset-x-0 bottom-0 z-10 max-h-[70vh] translate-y-0 overflow-y-auto rounded-t-xl border-t bg-card p-4",
              "md:static md:z-auto md:max-h-none md:w-64 md:translate-y-0 md:overflow-y-auto md:rounded-none md:border-t-0 md:border-l",
            )}
            data-testid="radial-settings-panel"
          >
            <RadialSettingsSection title="Filters">
              <input
                type="text"
                ref={searchInputRef}
                placeholder="Search chats…"
                data-testid="radial-search"
                className="mb-2 w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                onChange={(e) => {
                  searchRef.current = e.target.value.trim().toLowerCase();
                }}
              />
              <RadialToggleRow
                label="Show projects"
                defaultChecked={flagsRef.current.showProjects}
                onChange={(v) => {
                  flagsRef.current.showProjects = v;
                  bumpRenderTick((n) => n + 1);
                  persistSettings();
                }}
              />
              <RadialToggleRow
                label="Show labels"
                defaultChecked={flagsRef.current.showLabels}
                onChange={(v) => {
                  flagsRef.current.showLabels = v;
                  bumpRenderTick((n) => n + 1);
                  persistSettings();
                }}
              />
              <RadialToggleRow
                label="Show numbers"
                defaultChecked={flagsRef.current.showNumbers}
                onChange={(v) => {
                  flagsRef.current.showNumbers = v;
                  bumpRenderTick((n) => n + 1);
                  persistSettings();
                }}
              />
              <RadialToggleRow
                label="This chat's project only"
                defaultChecked={flagsRef.current.activeProjectOnly}
                onChange={(v) => {
                  flagsRef.current.activeProjectOnly = v;
                  persistSettings();
                }}
              />
            </RadialSettingsSection>

            <RadialSettingsSection title="Groups">
              <div className="flex flex-col gap-1" data-testid="radial-groups">
                {projectList.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() =>
                      setIsolatedProjectId((current) => (current === p.id ? null : p.id))
                    }
                    data-testid={`radial-group-${p.id}`}
                    data-isolated={isolatedProjectId === p.id}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                      isolatedProjectId === p.id && "bg-accent",
                    )}
                  >
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: p.color }}
                    />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">{p.count}</span>
                  </button>
                ))}
              </div>
            </RadialSettingsSection>

            <RadialSettingsSection title="Display">
              <RadialToggleRow
                label="Arrows"
                defaultChecked={flagsRef.current.showArrows}
                onChange={(v) => {
                  flagsRef.current.showArrows = v;
                  persistSettings();
                }}
              />
              <RadialSliderRow
                label="Text fade threshold"
                min={0}
                max={200}
                defaultValue={rawSliderDefaults.fadeThreshold}
                onChange={(v) => {
                  fadeThresholdRef.current = v;
                  persistSettings();
                }}
              />
              <RadialSliderRow
                label="Node size"
                min={10}
                max={400}
                defaultValue={rawSliderDefaults.nodeSize}
                onChange={(v) => {
                  sizeMultRef.current = v / 100;
                  persistSettings();
                }}
              />
              <RadialSliderRow
                label="Link thickness"
                min={10}
                max={500}
                defaultValue={rawSliderDefaults.linkThickness}
                onChange={(v) => {
                  widthMultRef.current = v / 100;
                  persistSettings();
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="mt-1 w-full"
                onClick={handleAnimateKick}
              >
                Animate
              </Button>
            </RadialSettingsSection>

            <RadialSettingsSection title="Forces" last>
              <RadialSliderRow
                label="Centre force"
                min={0}
                max={200}
                defaultValue={rawSliderDefaults.centerForce}
                onChange={(v) => {
                  paramsRef.current.center = v * 0.0006;
                  persistSettings();
                }}
              />
              <RadialSliderRow
                label="Repel force"
                min={0}
                max={200}
                defaultValue={rawSliderDefaults.repelForce}
                onChange={(v) => {
                  paramsRef.current.repel = 150 + v * 55;
                  persistSettings();
                }}
              />
              <RadialSliderRow
                label="Link force"
                min={0}
                max={200}
                defaultValue={rawSliderDefaults.linkForce}
                onChange={(v) => {
                  paramsRef.current.linkForce = 0.01 + v * 0.0035;
                  persistSettings();
                }}
              />
              <RadialSliderRow
                label="Link distance"
                min={5}
                max={300}
                defaultValue={rawSliderDefaults.linkDist}
                onChange={(v) => {
                  paramsRef.current.linkDist = 20 + v * 1.1;
                  persistSettings();
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 w-full"
                onClick={handleResetDefaults}
              >
                Reset to defaults
              </Button>
            </RadialSettingsSection>
          </div>
        )}
      </div>
    </div>
  );
}

function RadialSettingsSection({
  title,
  last,
  children,
}: {
  title: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("py-3", !last && "border-b")}>
      <div className="panel-label mb-2 text-[0.65rem] text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function RadialToggleRow({
  label,
  defaultChecked,
  onChange,
}: {
  label: string;
  defaultChecked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const [checked, setChecked] = useState(defaultChecked);
  return (
    <label className="flex items-center justify-between py-1 text-sm">
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        onChange={(e) => {
          setChecked(e.target.checked);
          onChange(e.target.checked);
        }}
      />
    </label>
  );
}

function RadialSliderRow({
  label,
  min,
  max,
  defaultValue,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        defaultValue={defaultValue}
        className="w-24"
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
