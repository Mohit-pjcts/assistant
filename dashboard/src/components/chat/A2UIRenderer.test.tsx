import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { A2UIRenderer } from "./A2UIRenderer";
import type { A2UISurface } from "@/lib/api";

// The Python side (assistant/a2ui.py) already validates a surface's shape
// before it ever reaches the client — these tests verify the RENDERER's own
// contract with that validated shape (registry dispatch + the coercion
// guards), same relationship ChatPanel.test.tsx has with server.py's
// InterruptPayload shapes.

describe("A2UIRenderer", () => {
  it("renders a simple Text root", () => {
    const surface: A2UISurface = {
      surfaceId: "s1",
      components: [{ id: "root", component: "Text", text: "hello from a2ui" }],
    };
    render(<A2UIRenderer surface={surface} />);
    expect(screen.getByText("hello from a2ui")).toBeInTheDocument();
  });

  it("renders a nested Card > Column > [Text, Row > [Badge, Badge]] tree", () => {
    const surface: A2UISurface = {
      surfaceId: "s1",
      components: [
        { id: "root", component: "Card", child: "col" },
        { id: "col", component: "Column", children: ["title", "row"] },
        { id: "title", component: "Text", text: "Today" },
        { id: "row", component: "Row", children: ["b1", "b2"] },
        { id: "b1", component: "Badge", text: "3 meetings" },
        { id: "b2", component: "Badge", text: "1 unread" },
      ],
    };
    render(<A2UIRenderer surface={surface} />);
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("3 meetings")).toBeInTheDocument();
    expect(screen.getByText("1 unread")).toBeInTheDocument();
  });

  it("renders nothing when no component has id 'root'", () => {
    const surface: A2UISurface = {
      surfaceId: "s1",
      components: [{ id: "orphan", component: "Text", text: "unreachable" }],
    };
    const { container } = render(<A2UIRenderer surface={surface} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("skips a node of an unrecognized component type instead of crashing", () => {
    const surface: A2UISurface = {
      surfaceId: "s1",
      components: [
        { id: "root", component: "Column", children: ["known", "unknown"] },
        { id: "known", component: "Text", text: "visible" },
        { id: "unknown", component: "SomeFutureType", text: "should not crash" },
      ],
    };
    render(<A2UIRenderer surface={surface} />);
    expect(screen.getByText("visible")).toBeInTheDocument();
    expect(screen.queryByText("should not crash")).not.toBeInTheDocument();
  });

  it("renders a Divider with the requested orientation", () => {
    const surface: A2UISurface = {
      surfaceId: "s1",
      components: [{ id: "root", component: "Divider", axis: "vertical" }],
    };
    const { container } = render(<A2UIRenderer surface={surface} />);
    expect(container.querySelector('[data-orientation="vertical"]')).toBeInTheDocument();
  });

  it("renders an Image with its url and alt text", () => {
    const surface: A2UISurface = {
      surfaceId: "s1",
      components: [
        { id: "root", component: "Image", url: "data:image/png;base64,AAAA", alt: "a chart" },
      ],
    };
    render(<A2UIRenderer surface={surface} />);
    const img = screen.getByAltText("a chart") as HTMLImageElement;
    expect(img.src).toBe("data:image/png;base64,AAAA");
  });

  it("does not render an Image when url is a {path} reference with no resolved data model", () => {
    // v1 has no server-resolved data model to bind against yet
    // (assistant/a2ui.py's docstring) — a path-bound field should degrade
    // to "render nothing" rather than leaking a raw object into the DOM.
    const surface: A2UISurface = {
      surfaceId: "s1",
      components: [{ id: "root", component: "Image", url: { path: "/photo" } }],
    };
    const { container } = render(<A2UIRenderer surface={surface} />);
    expect(container.querySelector("img")).not.toBeInTheDocument();
  });

  // Part B: interactive components. assistant/a2ui.py already guarantees a
  // Button's `action` can only ever be {"name": <str>} before this renderer
  // ever sees it — these tests verify the RENDERER side of that contract:
  // a submit collects the surface's own local field values (never anything
  // from outside it) and reports them via onAction, presentationally only.

  it("collects TextField/CheckBox/ChoicePicker values into onAction's context when Button fires", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const surface: A2UISurface = {
      surfaceId: "form-1",
      components: [
        { id: "root", component: "Column", children: ["name", "attending", "meal", "go"] },
        { id: "name", component: "TextField", label: "Guest name", path: "/name" },
        { id: "attending", component: "CheckBox", label: "Attending?", path: "/attending" },
        {
          id: "meal",
          component: "ChoicePicker",
          label: "Meal",
          path: "/meal",
          options: ["Veg", "Meat"],
        },
        { id: "go", component: "Button", text: "RSVP", action: { name: "rsvp" } },
      ],
    };
    render(<A2UIRenderer surface={surface} onAction={onAction} />);

    await user.type(screen.getByLabelText("Guest name"), "Ada Lovelace");
    await user.click(screen.getByRole("checkbox", { name: "Attending?" }));
    await user.click(screen.getByRole("button", { name: "Meat" }));
    await user.click(screen.getByRole("button", { name: "RSVP" }));

    expect(onAction).toHaveBeenCalledWith("form-1", "rsvp", {
      "/name": "Ada Lovelace",
      "/attending": true,
      "/meal": "Meat",
    });
  });

  it("ChoicePicker with variant multiSelect accumulates and removes multiple selections", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const surface: A2UISurface = {
      surfaceId: "form-2",
      components: [
        { id: "root", component: "Column", children: ["toppings", "go"] },
        {
          id: "toppings",
          component: "ChoicePicker",
          label: "Toppings",
          path: "/toppings",
          options: ["Cheese", "Olives", "Mushrooms"],
          variant: "multiSelect",
        },
        { id: "go", component: "Button", text: "Order", action: { name: "order" } },
      ],
    };
    render(<A2UIRenderer surface={surface} onAction={onAction} />);

    await user.click(screen.getByRole("button", { name: "Cheese" }));
    await user.click(screen.getByRole("button", { name: "Mushrooms" }));
    await user.click(screen.getByRole("button", { name: "Cheese" })); // deselect

    await user.click(screen.getByRole("button", { name: "Order" }));

    expect(onAction).toHaveBeenCalledWith("form-2", "order", { "/toppings": ["Mushrooms"] });
  });

  it("a Button without onAction is inert (no crash on click)", async () => {
    const user = userEvent.setup();
    const surface: A2UISurface = {
      surfaceId: "form-3",
      components: [{ id: "root", component: "Button", text: "Go", action: { name: "go" } }],
    };
    render(<A2UIRenderer surface={surface} />);
    await user.click(screen.getByRole("button", { name: "Go" }));
    // No assertion beyond "didn't throw" — this is the read-only-history
    // rendering case (a past turn's surface shown with no onAction wired).
  });

  it("disables Buttons when the disabled prop is set, and does not fire onAction", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const surface: A2UISurface = {
      surfaceId: "form-4",
      components: [{ id: "root", component: "Button", text: "Go", action: { name: "go" } }],
    };
    render(<A2UIRenderer surface={surface} onAction={onAction} disabled />);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(onAction).not.toHaveBeenCalled();
  });
});
