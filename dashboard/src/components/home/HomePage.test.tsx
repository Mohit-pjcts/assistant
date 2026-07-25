import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomePage } from "./HomePage";

describe("HomePage", () => {
  it("greets by name and submits the composer's text via onStartChat", async () => {
    const onStartChat = vi.fn();
    render(<HomePage greetingName="Mohit" onStartChat={onStartChat} />);

    expect(screen.getByText(/hi, mohit/i)).toBeInTheDocument();

    const input = screen.getByPlaceholderText(/ask anything/i);
    await userEvent.type(input, "Summarize my week{enter}");

    expect(onStartChat).toHaveBeenCalledWith("Summarize my week");
  });

  it("shows suggestion cards for a selected category and submits their prompt on click", async () => {
    const onStartChat = vi.fn();
    render(<HomePage greetingName="Mohit" onStartChat={onStartChat} />);

    await userEvent.click(screen.getByRole("button", { name: /coding/i }));
    const card = await screen.findByText(/debug my code/i);
    await userEvent.click(card);

    expect(onStartChat).toHaveBeenCalledWith("Help me debug the following code:");
  });
});
