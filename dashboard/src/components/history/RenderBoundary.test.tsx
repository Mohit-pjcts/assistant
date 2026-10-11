import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RenderBoundary } from "./RenderBoundary";

// React reports a caught render error to console.error, and so does the
// boundary's own componentDidCatch — expected here, and just noise.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error("events is not iterable");
  return <p>all good</p>;
}

describe("RenderBoundary", () => {
  it("is invisible when nothing goes wrong", () => {
    render(
      <RenderBoundary what="turn 3">
        <Bomb explode={false} />
      </RenderBoundary>,
    );

    expect(screen.getByText("all good")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("replaces what it wraps with a readable message instead of throwing the whole tree away", () => {
    render(
      <div>
        <p>the rest of the page</p>
        <RenderBoundary what="turn 3">
          <Bomb explode />
        </RenderBoundary>
      </div>,
    );

    expect(screen.getByText("the rest of the page")).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't display turn 3");
    expect(alert).toHaveTextContent("events is not iterable");
  });

  it("tries again on request, and shows the content if the problem is gone", async () => {
    const user = userEvent.setup();
    let explode = true;
    function Flaky() {
      return <Bomb explode={explode} />;
    }
    render(
      <RenderBoundary what="turn 3">
        <Flaky />
      </RenderBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    explode = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByText("all good")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports the failure to the console for whoever is debugging the backend's data", () => {
    render(
      <RenderBoundary what="turn 3">
        <Bomb explode />
      </RenderBoundary>,
    );

    expect(console.error).toHaveBeenCalledWith(
      "History: couldn't display turn 3",
      expect.objectContaining({ message: "events is not iterable" }),
      expect.any(String),
    );
  });
});
