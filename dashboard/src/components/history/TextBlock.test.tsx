import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TEXT_PREVIEW_LIMIT, TextBlock } from "./TextBlock";
import { JsonBlock, prettyJson } from "./JsonBlock";

afterEach(() => {
  vi.useRealTimers();
});

describe("TextBlock", () => {
  it("shows the label and the text verbatim, whitespace and all", () => {
    const { container } = render(<TextBlock label="Output" text={"line one\n  line two"} />);

    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(container.querySelector("pre")?.textContent).toBe("line one\n  line two");
  });

  it("shows the empty label, and disables copy, when there is nothing to show", () => {
    render(<TextBlock label="Output" text="" emptyLabel="(no output recorded)" />);

    expect(screen.getByText("(no output recorded)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy output" })).toBeDisabled();
  });

  it("shows only the first few thousand characters of a long text until 'show all'", async () => {
    const user = userEvent.setup();
    const long = "a".repeat(TEXT_PREVIEW_LIMIT + 1000);
    const { container } = render(<TextBlock label="Output" text={long} />);
    const pre = container.querySelector("pre")!;

    expect(pre.textContent).toBe(`${"a".repeat(TEXT_PREVIEW_LIMIT)}…`);
    const showAll = screen.getByRole("button", { name: "show all (5,000 chars)" });
    expect(showAll).toHaveAttribute("aria-expanded", "false");

    await user.click(showAll);
    expect(pre.textContent).toBe(long);

    await user.click(screen.getByRole("button", { name: "show less" }));
    expect(pre.textContent).toBe(`${"a".repeat(TEXT_PREVIEW_LIMIT)}…`);
  });

  it("offers no 'show all' for a text that already fits", () => {
    render(<TextBlock label="Output" text="short" />);
    expect(screen.queryByRole("button", { name: /show all/ })).not.toBeInTheDocument();
  });

  it("copies the FULL text even while only a preview is on screen", async () => {
    const user = userEvent.setup();
    const long = `${"b".repeat(TEXT_PREVIEW_LIMIT)}THE-TAIL`;
    render(<TextBlock label="Output" text={long} />);

    await user.click(screen.getByRole("button", { name: "Copy output" }));

    expect(await navigator.clipboard.readText()).toBe(long);
    expect(screen.getByRole("button", { name: "Copy output" })).toHaveTextContent("Copied");
  });

  it("goes back to 'Copy' after a moment", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<TextBlock label="Output" text="hello" />);

    await user.click(screen.getByRole("button", { name: "Copy output" }));
    expect(screen.getByRole("button", { name: "Copy output" })).toHaveTextContent("Copied");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(screen.getByRole("button", { name: "Copy output" })).toHaveTextContent(/^Copy$/);
  });

  it("says so when the clipboard refuses, rather than pretending it worked", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    render(<TextBlock label="Output" text="hello" />);

    await user.click(screen.getByRole("button", { name: "Copy output" }));

    expect(screen.getByRole("button", { name: "Copy output" })).toHaveTextContent("Failed");
  });

  it("can name its copy button when it has no visible label", () => {
    render(<TextBlock text="hmm" copyLabel="thinking" />);
    expect(screen.getByRole("button", { name: "Copy thinking" })).toBeInTheDocument();
  });
});

describe("prettyJson / JsonBlock", () => {
  it("pretty-prints an object with two-space indentation", () => {
    expect(prettyJson({ a: 1, b: { c: [1, 2] } })).toBe(
      '{\n  "a": 1,\n  "b": {\n    "c": [\n      1,\n      2\n    ]\n  }\n}',
    );
  });

  it("decodes a string that is itself a JSON object, and leaves other strings alone", () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson("just words")).toBe("just words");
    // A JSON *string* literal isn't structure; it stays as written.
    expect(prettyJson('"quoted"')).toBe('"quoted"');
  });

  it("doesn't throw on something JSON can't serialize", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => prettyJson(circular)).not.toThrow();
  });

  it("renders a labelled, copyable view of the value", async () => {
    const user = userEvent.setup();
    render(<JsonBlock label="Input" value={{ to: "dana@example.com" }} />);

    expect(screen.getByText(/"to": "dana@example.com"/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy input" }));
    expect(await navigator.clipboard.readText()).toBe('{\n  "to": "dana@example.com"\n}');
  });

  it("says '(none)' for a missing value", () => {
    render(<JsonBlock label="Input" value={undefined} />);
    expect(screen.getByText("(none)")).toBeInTheDocument();
  });
});
