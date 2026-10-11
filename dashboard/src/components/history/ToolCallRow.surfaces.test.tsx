import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { A2UISurface } from "@/lib/api";
import { ToolCallRow } from "./ToolCallRow";
import { modelTurn, surface, tool } from "./testFixtures";

// ToolCallRow.test.tsx draws cards with the real A2UIRenderer. This file
// swaps in a stub so it can look at what the row hands the renderer — in
// particular that it never hands it an `onAction`: wired up, a Button on a
// card from a past turn would POST a brand-new user turn from a screen whose
// whole job is to look at the past. The real renderer can't show that (with
// no onAction a Button simply does nothing, the same as a disabled one).
const rendered = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@/components/chat/A2UIRenderer", () => ({
  A2UIRenderer: (props: { surface: A2UISurface }) => {
    rendered.push(props);
    if (props.surface.surfaceId === "bad-card") throw new Error("card exploded");
    return <div data-testid="stub-card">{props.surface.surfaceId}</div>;
  },
}));

beforeEach(() => {
  rendered.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ToolCallRow's cards", () => {
  it("never hands the renderer an onAction, so a past turn's Buttons stay inert", () => {
    render(<ToolCallRow event={tool({ surfaces: [surface("a", "s1"), surface("b", "s2")] })} />);

    expect(rendered.length).toBeGreaterThanOrEqual(2);
    for (const props of rendered) {
      expect(props).not.toHaveProperty("onAction");
    }
  });

  it("hands over each surface as the backend sent it", () => {
    const first = surface("a", "s1");
    const second = surface("b", "s2");
    render(<ToolCallRow event={tool({ surfaces: [first, second] })} />);

    const seen = rendered.map((props) => props.surface);
    expect(seen).toContain(first);
    expect(seen).toContain(second);
  });

  it("places the cards after the row's header and before its inner steps", () => {
    render(
      <ToolCallRow
        event={tool({
          name: "research_agent",
          delegation: "research_agent",
          surfaces: [surface("a", "s1")],
          children: [modelTurn({ id: "m1", text: "an inner thought" })],
        })}
      />,
    );

    const header = screen.getByRole("button", { name: /supervisor\s+research_agent/ });
    const card = screen.getByTestId("stub-card");
    const inner = screen.getByText("an inner thought");
    expect(header.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(inner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps a card that fails to draw from taking the whole row with it", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ToolCallRow event={tool({ surfaces: [surface("x", "good"), surface("y", "bad-card")] })} />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't display this card");
    expect(within(screen.getByTestId("tool-surfaces")).getByTestId("stub-card")).toHaveTextContent(
      "good",
    );
    expect(screen.getByRole("button", { name: /web_search/ })).toBeInTheDocument();
  });
});
