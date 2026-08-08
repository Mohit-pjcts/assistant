import { describe, expect, it } from "vitest";
import {
  buildRadialGraph,
  computeGraphDimensions,
  DEFAULT_FORCE_PARAMS,
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  linkWidth,
  nodeRadius,
  stepSimulation,
  type RadialLink,
  type RadialNode,
} from "./radialSimulation";
import type { Project, ThreadSummary } from "@/lib/api";

function project(id: string, name: string, color = "#9b87f5"): Project {
  return { id, name, color, created_at: "x" };
}

function thread(id: string, title: string, project_id: string | null): ThreadSummary {
  return { id, title, created_at: "x", last_active_at: "x", project_id };
}

describe("buildRadialGraph", () => {
  it("builds hub -> project -> chat links, plus hub -> chat directly for ungrouped threads", () => {
    const projects = [project("p1", "Coding"), project("p2", "Empty project")];
    const threads = [
      thread("t1", "Fix the bug", "p1"),
      thread("t2", "Ship the feature", "p1"),
      thread("t3", "Loose thread", null),
    ];

    const { nodes, links } = buildRadialGraph(projects, threads);

    expect(nodes.map((n) => n.id).sort()).toEqual(["hub", "p1", "p2", "t1", "t2", "t3"].sort());
    expect(nodes.find((n) => n.id === "p1")?.chatCount).toBe(2);
    expect(nodes.find((n) => n.id === "p2")?.chatCount).toBe(0);

    const t1Link = links.find((l) => l.target === "t1");
    expect(t1Link).toEqual({ source: "p1", target: "t1", tier: "leaf" });

    const ungroupedLink = links.find((l) => l.target === "t3");
    expect(ungroupedLink).toEqual({ source: "hub", target: "t3", tier: "trunk" });

    const projectLinks = links.filter((l) => l.tier === "trunk" && l.target.startsWith("p"));
    expect(projectLinks).toHaveLength(2);
  });

  it("assigns sequential order numbers across both grouped and ungrouped chats", () => {
    const projects = [project("p1", "Coding")];
    const threads = [thread("t1", "First", "p1"), thread("t2", "Second", null)];

    const { nodes } = buildRadialGraph(projects, threads);

    const orders = nodes.filter((n) => n.type === "chat").map((n) => n.order);
    expect(orders.sort()).toEqual([1, 2]);
  });

  it("handles zero projects and zero threads without dividing by zero", () => {
    const { nodes, links } = buildRadialGraph([], []);
    expect(nodes).toEqual([
      expect.objectContaining({ id: "hub", type: "hub", x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }),
    ]);
    expect(links).toEqual([]);
  });

  it("ungrouped chats carry no project color", () => {
    const { nodes } = buildRadialGraph([], [thread("t1", "Loose", null)]);
    expect(nodes.find((n) => n.id === "t1")?.color).toBeNull();
  });
});

describe("nodeRadius", () => {
  it("orders hub > a busy project > an empty project > a chat", () => {
    const hub: RadialNode = makeNode({ id: "hub", type: "hub" });
    const busyProject: RadialNode = makeNode({ id: "p1", type: "project", chatCount: 5 });
    const emptyProject: RadialNode = makeNode({ id: "p2", type: "project", chatCount: 0 });
    const chat: RadialNode = makeNode({ id: "c1", type: "chat" });

    expect(nodeRadius(hub, 1)).toBeGreaterThan(nodeRadius(busyProject, 1));
    expect(nodeRadius(busyProject, 1)).toBeGreaterThan(nodeRadius(emptyProject, 1));
    // An empty project still starts from the project base radius (8px),
    // always bigger than a chat's fixed 5px — projects are never as
    // small as a leaf chat node, even with zero chats in them.
    expect(nodeRadius(emptyProject, 1)).toBeGreaterThan(nodeRadius(chat, 1));
  });

  it("scales with sizeMult", () => {
    const chat = makeNode({ id: "c1", type: "chat" });
    expect(nodeRadius(chat, 2)).toBe(nodeRadius(chat, 1) * 2);
  });
});

describe("linkWidth", () => {
  it("gives a selected chat's leaf link more width than an unselected one", () => {
    const project = makeNode({ id: "p1", type: "project", chatCount: 1 });
    const nodesById = new Map([["p1", project]]);
    const link: RadialLink = { source: "p1", target: "c1", tier: "leaf" };

    const selected = linkWidth(link, nodesById, "c1", 1);
    const unselected = linkWidth(link, nodesById, "c2", 1);
    expect(selected).toBeGreaterThan(unselected);
  });

  it("scales a trunk link's width with the source project's chat count", () => {
    const busy = makeNode({ id: "p1", type: "project", chatCount: 5 });
    const quiet = makeNode({ id: "p2", type: "project", chatCount: 0 });
    const nodesById = new Map([
      ["p1", busy],
      ["p2", quiet],
    ]);
    const busyLink = linkWidth({ source: "p1", target: "hub", tier: "trunk" }, nodesById, null, 1);
    const quietLink = linkWidth({ source: "p2", target: "hub", tier: "trunk" }, nodesById, null, 1);
    expect(busyLink).toBeGreaterThan(quietLink);
  });
});

describe("stepSimulation", () => {
  it("never moves a dragged (fx/fy-pinned) node", () => {
    const dragged = makeNode({ id: "a", type: "chat", x: 100, y: 100, fx: 100, fy: 100 });
    const other = makeNode({ id: "b", type: "chat", x: 105, y: 100 });
    const nodes = [dragged, other];

    for (let i = 0; i < 30; i++) stepSimulation(nodes, [], DEFAULT_FORCE_PARAMS);

    expect(dragged.x).toBe(100);
    expect(dragged.y).toBe(100);
    expect(dragged.vx).toBe(0);
    expect(dragged.vy).toBe(0);
  });

  it("pulls two linked nodes that start far past the rest distance closer together", () => {
    const a = makeNode({ id: "a", type: "chat", x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 });
    const b = makeNode({ id: "b", type: "chat", x: GRAPH_WIDTH / 2 + 400, y: GRAPH_HEIGHT / 2 });
    const nodes = [a, b];
    const links: RadialLink[] = [{ source: "a", target: "b", tier: "leaf" }];
    const startDist = Math.hypot(b.x - a.x, b.y - a.y);

    for (let i = 0; i < 60; i++) stepSimulation(nodes, links, DEFAULT_FORCE_PARAMS);

    const endDist = Math.hypot(b.x - a.x, b.y - a.y);
    expect(endDist).toBeLessThan(startDist);
  });

  it("pulls an unlinked, off-center node toward the canvas center over time", () => {
    const lonely = makeNode({ id: "a", type: "chat", x: 20, y: 20 });
    const nodes = [lonely];
    const startDistToCenter = Math.hypot(GRAPH_WIDTH / 2 - lonely.x, GRAPH_HEIGHT / 2 - lonely.y);

    for (let i = 0; i < 200; i++) stepSimulation(nodes, [], DEFAULT_FORCE_PARAMS);

    const endDistToCenter = Math.hypot(GRAPH_WIDTH / 2 - lonely.x, GRAPH_HEIGHT / 2 - lonely.y);
    expect(endDistToCenter).toBeLessThan(startDistToCenter);
  });

  it("keeps every node within the canvas bounds after many steps", () => {
    const nodes = [
      makeNode({ id: "a", type: "chat", x: 5, y: 5 }),
      makeNode({ id: "b", type: "chat", x: GRAPH_WIDTH - 5, y: GRAPH_HEIGHT - 5 }),
    ];
    for (let i = 0; i < 100; i++) stepSimulation(nodes, [], DEFAULT_FORCE_PARAMS);

    for (const node of nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(GRAPH_WIDTH);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(GRAPH_HEIGHT);
    }
  });
});

describe("computeGraphDimensions", () => {
  it("returns the mockup's own base size at the mockup's own scale (14 nodes)", () => {
    expect(computeGraphDimensions(14)).toEqual({ width: GRAPH_WIDTH, height: GRAPH_HEIGHT });
  });

  it("never shrinks below the base size for a small graph", () => {
    expect(computeGraphDimensions(1)).toEqual({ width: GRAPH_WIDTH, height: GRAPH_HEIGHT });
  });

  it("grows with node count rather than staying fixed", () => {
    const small = computeGraphDimensions(14);
    const large = computeGraphDimensions(80);
    expect(large.width).toBeGreaterThan(small.width);
    expect(large.height).toBeGreaterThan(small.height);
  });
});

describe("real vault scale — a regression test FIX_PLAN.md explicitly asked for", () => {
  // This project's own real production database had 73 threads, ALL
  // ungrouped (no Projects adopted yet) — confirmed live, not a guess.
  // Every previous test in this file used a small handful of fixture
  // threads, which is exactly why the original "renders every thread
  // with no cap, no strategy" gap shipped unnoticed the first time
  // (FIX_PLAN.md's own diagnosis). This test exists so that gap can't
  // silently return.
  const projects = [project("p1", "Coding"), project("p2", "Research")];
  const manyThreads = Array.from({ length: 73 }, (_, i) =>
    thread(`t${i}`, `Thread number ${i}`, i % 3 === 0 ? "p1" : i % 3 === 1 ? "p2" : null),
  );

  it("builds a graph node for every single thread — no cap, no dropped data", () => {
    const { nodes } = buildRadialGraph(projects, manyThreads);
    const chatNodes = nodes.filter((n) => n.type === "chat");
    expect(chatNodes).toHaveLength(73);
  });

  it("gives a 73-thread vault meaningfully more canvas area than the mockup's own 9-chat scale", () => {
    const totalNodeCount = 1 + projects.length + manyThreads.length;
    const { width, height } = computeGraphDimensions(totalNodeCount);
    expect(width * height).toBeGreaterThan(GRAPH_WIDTH * GRAPH_HEIGHT * 2);
  });

  it("runs the physics simulation over a real 76-node graph without crashing or producing NaN/Infinity positions", () => {
    const totalNodeCount = 1 + projects.length + manyThreads.length;
    const { width, height } = computeGraphDimensions(totalNodeCount);
    const { nodes, links } = buildRadialGraph(projects, manyThreads, width, height);

    for (let i = 0; i < 120; i++) stepSimulation(nodes, links, DEFAULT_FORCE_PARAMS, width, height);

    for (const node of nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });
});

function makeNode(
  overrides: Partial<RadialNode> & { id: string; type: RadialNode["type"] },
): RadialNode {
  return {
    label: overrides.id,
    color: null,
    order: null,
    chatCount: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    fx: null,
    fy: null,
    ...overrides,
  };
}
