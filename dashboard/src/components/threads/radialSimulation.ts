import type { Project, ThreadSummary } from "@/lib/api";

// The radial chat selector's real, small force-directed graph engine
// (PLAN.md Phase 28 step 5) — ported from instrument/instrument.html's
// own hand-rolled repel/link/center simulation (no external library,
// same as the mockup's own choice: "d3-force's own shape reimplemented
// at the tiny scale this needs"). Kept as a pure, DOM-free module
// specifically so the actual physics math is unit-testable on its own —
// RadialChatSelector.tsx owns all the SVG/ref/pointer-event plumbing.
//
// Generalizes the mockup's fixed hub -> project -> chat hierarchy to
// handle a real case the mockup's own fabricated VAULT data never had:
// an UNGROUPED thread (project_id === null). Those link directly to the
// hub instead of through a project, mirroring the tree sidebar's own
// handling of the same case (PLAN.md Phase 28 step 2).

export interface RadialNode {
  id: string;
  type: "hub" | "project" | "chat";
  label: string;
  color: string | null;
  order: number | null;
  chatCount: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  // Set while a node is being dragged (pointer-captured) — the
  // simulation freezes that node at (fx, fy) and excludes it from every
  // force calculation, exactly like the mockup's own `n.fx`/`n.fy`.
  fx: number | null;
  fy: number | null;
}

export interface RadialLink {
  source: string;
  target: string;
  // "trunk" = hub->project or hub->ungrouped-chat; "leaf" = project->chat.
  // Trunk links get a longer rest distance and thicker default width.
  tier: "trunk" | "leaf";
}

export interface RadialForceParams {
  center: number;
  repel: number;
  linkForce: number;
  linkDist: number;
}

export const DEFAULT_FORCE_PARAMS: RadialForceParams = {
  center: 0.021,
  repel: 2400,
  linkForce: 0.13,
  linkDist: 70,
};

// Base canvas size, tuned for the mockup's own 14-node scale (1 hub + 4
// projects + 9 chats) — kept as named exports since existing callers
// (tests, and any caller with a small/unknown node count) can default to
// them. Real vaults can run to 70+ threads, all currently ungrouped, so
// PLAN.md's original "cap or hide nodes" idea (matching FIX_PLAN.md) was
// explicitly overridden by the user in favor of Obsidian's own real
// behavior: never hide data, just give the simulation enough room to
// spread everything out, and let pan/zoom (RadialChatSelector.tsx) handle
// readability at scale instead.
export const GRAPH_WIDTH = 700;
export const GRAPH_HEIGHT = 560;
const BASE_NODE_COUNT = 14;

// Canvas area grows with node count (sqrt, so density stays roughly
// constant regardless of vault size — doubling the nodes doesn't mean
// quadrupling the empty space) rather than staying fixed and relying on
// the repel force alone to fight for room. `nodeCount` is the TOTAL graph
// size (hub + projects + chats), not just chats.
export function computeGraphDimensions(nodeCount: number): { width: number; height: number } {
  const scale = Math.max(1, Math.sqrt(nodeCount / BASE_NODE_COUNT));
  return {
    width: Math.round(GRAPH_WIDTH * scale),
    height: Math.round(GRAPH_HEIGHT * scale),
  };
}

export function buildRadialGraph(
  projects: Project[],
  threads: ThreadSummary[],
  width: number = GRAPH_WIDTH,
  height: number = GRAPH_HEIGHT,
): { nodes: RadialNode[]; links: RadialLink[] } {
  const W = width;
  const H = height;
  // Orbit radii scale with the canvas itself (proportional to the
  // mockup's own 700-wide baseline: 150/700 project orbit, 80/700
  // chat-around-project orbit, 220/700 ungrouped-chat orbit) — a bigger
  // canvas with the same fixed-pixel orbit would just add empty margin
  // around a small huddle in the middle instead of actually spreading
  // nodes out.
  const projectOrbit = W * (150 / GRAPH_WIDTH);
  const chatOrbit = W * (80 / GRAPH_WIDTH);
  const ungroupedOrbit = W * (220 / GRAPH_WIDTH);
  const nodes: RadialNode[] = [
    {
      id: "hub",
      type: "hub",
      label: "Oni",
      color: null,
      order: null,
      chatCount: 0,
      x: W / 2,
      y: H / 2,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    },
  ];
  const links: RadialLink[] = [];

  const threadsByProject = new Map<string, ThreadSummary[]>();
  const ungrouped: ThreadSummary[] = [];
  for (const thread of threads) {
    if (thread.project_id) {
      const bucket = threadsByProject.get(thread.project_id) ?? [];
      bucket.push(thread);
      threadsByProject.set(thread.project_id, bucket);
    } else {
      ungrouped.push(thread);
    }
  }

  let order = 0;
  const projectCount = Math.max(projects.length, 1);
  projects.forEach((project, pi) => {
    const angle = (pi / projectCount) * Math.PI * 2 + Math.PI / 5;
    const px = W / 2 + Math.cos(angle) * projectOrbit;
    const py = H / 2 + Math.sin(angle) * projectOrbit;
    const chats = threadsByProject.get(project.id) ?? [];
    nodes.push({
      id: project.id,
      type: "project",
      label: project.name,
      color: project.color,
      order: null,
      chatCount: chats.length,
      x: px,
      y: py,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    });
    links.push({ source: "hub", target: project.id, tier: "trunk" });
    chats.forEach((chat, ci) => {
      order++;
      const cang = angle + (ci - (chats.length - 1) / 2) * 0.5;
      nodes.push({
        id: chat.id,
        type: "chat",
        label: chat.title || chat.id,
        color: project.color,
        order,
        chatCount: 0,
        x: px + Math.cos(cang) * chatOrbit,
        y: py + Math.sin(cang) * chatOrbit,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
      });
      links.push({ source: project.id, target: chat.id, tier: "leaf" });
    });
  });

  const ungroupedCount = Math.max(ungrouped.length, 1);
  ungrouped.forEach((chat, i) => {
    order++;
    const angle = (i / ungroupedCount) * Math.PI * 2;
    nodes.push({
      id: chat.id,
      type: "chat",
      label: chat.title || chat.id,
      color: null,
      order,
      chatCount: 0,
      x: W / 2 + Math.cos(angle) * ungroupedOrbit,
      y: H / 2 + Math.sin(angle) * ungroupedOrbit,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    });
    links.push({ source: "hub", target: chat.id, tier: "trunk" });
  });

  return { nodes, links };
}

export function nodeRadius(node: RadialNode, sizeMult: number): number {
  const base = node.type === "hub" ? 13 : node.type === "project" ? 8 + node.chatCount * 0.55 : 5;
  return base * sizeMult;
}

export function linkWidth(
  link: RadialLink,
  nodesById: Map<string, RadialNode>,
  selectedChatId: string | null,
  widthMult: number,
): number {
  const source = nodesById.get(link.source);
  const base =
    link.tier === "trunk"
      ? 1.3 + (source?.chatCount ?? 0) * 0.32
      : link.target === selectedChatId
        ? 2.1
        : 1.1;
  return base * widthMult;
}

// One physics step, mutating `nodes` in place — same three-force model
// as the mockup: pairwise repel (O(n²), fine at this scale — the
// mockup's own comment notes this is "reimplemented at the tiny scale
// this needs"), a spring-like link force pulling connected nodes toward
// `linkDist` (trunk links rest 1.7x further out than leaf links), and a
// gentle pull toward the canvas center. Dragged nodes (fx/fy set) are
// excluded from every force and simply snapped to their pointer
// position — velocity zeroed so they don't "fling" on release.
export function stepSimulation(
  nodes: RadialNode[],
  links: RadialLink[],
  params: RadialForceParams,
  width: number = GRAPH_WIDTH,
  height: number = GRAPH_HEIGHT,
): void {
  const cx = width / 2;
  const cy = height / 2;

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 25) d2 = 25;
      const d = Math.sqrt(d2);
      const f = params.repel / d2;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (a.fx == null) {
        a.vx += fx;
        a.vy += fy;
      }
      if (b.fx == null) {
        b.vx -= fx;
        b.vy -= fy;
      }
    }
  }

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  for (const link of links) {
    const a = nodesById.get(link.source);
    const b = nodesById.get(link.target);
    if (!a || !b) continue;
    const dist0 = link.tier === "trunk" ? params.linkDist * 1.7 : params.linkDist;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const diff = ((d - dist0) / d) * params.linkForce;
    const fx = dx * diff * 0.5;
    const fy = dy * diff * 0.5;
    if (a.fx == null) {
      a.vx += fx;
      a.vy += fy;
    }
    if (b.fx == null) {
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  for (const node of nodes) {
    if (node.fx != null) continue;
    node.vx += (cx - node.x) * params.center;
    node.vy += (cy - node.y) * params.center;
  }

  for (const node of nodes) {
    if (node.fx != null) {
      node.x = node.fx;
      node.y = node.fy ?? node.y;
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx *= 0.85;
    node.vy *= 0.85;
    node.x += node.vx;
    node.y += node.vy;
  }
}
