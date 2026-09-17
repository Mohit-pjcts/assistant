import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { CostTrace } from "./CostTrace";

describe("CostTrace", () => {
  it("renders a decorative, aria-hidden svg", () => {
    const { container } = render(<CostTrace />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden");
  });
});
