import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders headings, lists and emphasis as real elements", () => {
    render(<Markdown>{"## Plan\n\n- **one**\n- two\n\n1. first\n2. second"}</Markdown>);
    expect(screen.getByRole("heading", { level: 2, name: "Plan" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText("one").tagName).toBe("STRONG");
  });

  it("renders a GFM table", () => {
    render(<Markdown>{"| a | b |\n|---|---|\n| 1 | 2 |"}</Markdown>);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
  });

  it("renders a fenced block with its language and a copy button", () => {
    render(<Markdown>{"```python\nprint('hi')\n```"}</Markdown>);
    expect(screen.getByText("python")).toBeInTheDocument();
    expect(screen.getByText("print('hi')")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });

  it("opens links in a new tab without opener access", () => {
    render(<Markdown>{"[docs](https://example.com)"}</Markdown>);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("never emits an <img> for a markdown image (no remote fetch from model output)", () => {
    const { container } = render(<Markdown>{"![tracker](https://evil.example/p.png)"}</Markdown>);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("[tracker]")).toBeInTheDocument();
  });

  it("shows raw HTML as literal text instead of parsing it", () => {
    const { container } = render(<Markdown>{"<script>alert(1)</script> hello"}</Markdown>);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("hello");
  });

  it("does not render a javascript: link as a live href", () => {
    render(<Markdown>{"[x](javascript:alert(1))"}</Markdown>);
    const link = screen.queryByRole("link", { name: "x" });
    expect(link?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  });
});
