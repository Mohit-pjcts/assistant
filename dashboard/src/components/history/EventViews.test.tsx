import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TraceAssistantEvent } from "@/lib/api";
import { AssistantEventView, UnknownEventView } from "./EventViews";
import { modelTurn } from "./testFixtures";

// What the supervisor says comes out of the checkpoint: text and thinking, no
// agent, no timing. What a specialist says inside a delegation is recorded
// as it happens and carries all of that.
const supervisorTurn: TraceAssistantEvent = {
  kind: "assistant",
  text: "Here you go.",
  thinking: null,
};

describe("AssistantEventView for the supervisor's own turn", () => {
  it("is labelled 'Oni', like the chat, and has no meta line", () => {
    render(<AssistantEventView event={supervisorTurn} showThinking={false} />);

    expect(screen.getByText("Oni")).toBeInTheDocument();
    expect(screen.getByText("Here you go.")).toBeInTheDocument();
    expect(screen.queryByTestId("trace-model-meta")).not.toBeInTheDocument();
  });

  it("keeps its thinking behind a toggle, and the global switch opens it", async () => {
    const user = userEvent.setup();
    const withThinking = { ...supervisorTurn, thinking: "the user wants it short" };
    const { rerender } = render(<AssistantEventView event={withThinking} showThinking={false} />);
    expect(screen.queryByText("the user wants it short")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "thinking" }));
    expect(screen.getByText("the user wants it short")).toBeInTheDocument();

    rerender(<AssistantEventView event={withThinking} showThinking />);
    expect(screen.getByText("the user wants it short")).toBeInTheDocument();
  });

  it("shows a turn that is only thinking, with no text", () => {
    render(
      <AssistantEventView event={{ kind: "assistant", text: "", thinking: "hmm" }} showThinking />,
    );
    expect(screen.getByText("hmm")).toBeInTheDocument();
  });
});

describe("AssistantEventView for a specialist's model turn", () => {
  it("shows who ran it, on what model, for how long, and at what token cost", () => {
    render(<AssistantEventView event={modelTurn()} showThinking={false} />);

    const meta = within(screen.getByTestId("trace-model-meta"));
    expect(meta.getByText("research_agent")).toBeInTheDocument();
    expect(meta.getByText("claude-sonnet-5")).toBeInTheDocument();
    expect(meta.getByText("3.4 s")).toBeInTheDocument();
    expect(
      meta.getByText("1,204 in / 310 out · cache read 900 · cache write 0"),
    ).toBeInTheDocument();
    expect(screen.getByText("I'll search for flights first.")).toBeInTheDocument();
  });

  it("takes the place of the 'Oni' label rather than sitting beside it", () => {
    render(<AssistantEventView event={modelTurn()} showThinking={false} />);
    expect(screen.queryByText("Oni")).not.toBeInTheDocument();
  });

  it("shows the start time on the line, and the full timestamps and message id on hover", () => {
    render(<AssistantEventView event={modelTurn({ id: "run-abc" })} showThinking={false} />);

    const meta = screen.getByTestId("trace-model-meta");
    expect(within(meta).getByText(/\d{2}.\d{2}.\d{2}/)).toBeInTheDocument();
    expect(meta).toHaveAttribute("title", expect.stringContaining("model turn run-abc"));
    expect(meta).toHaveAttribute("title", expect.stringContaining("started"));
    expect(meta).toHaveAttribute("title", expect.stringContaining("ended"));
  });

  it("leaves out whatever the line doesn't have — no model, usage or timing", () => {
    render(
      <AssistantEventView
        event={modelTurn({
          id: undefined,
          model: null,
          usage: null,
          duration_ms: null,
          started_at: null,
          ended_at: null,
        })}
        showThinking={false}
      />,
    );

    const meta = screen.getByTestId("trace-model-meta");
    expect(meta.children).toHaveLength(1);
    expect(within(meta).getByText("research_agent")).toBeInTheDocument();
    expect(meta).not.toHaveAttribute("title");
  });

  describe("token use", () => {
    function usageLine(usage: TraceAssistantEvent["usage"]) {
      render(<AssistantEventView event={modelTurn({ usage })} showThinking={false} />);
      return screen.getByTestId("trace-model-meta").textContent ?? "";
    }

    it("shows just in/out when the provider reported no cache figures", () => {
      expect(usageLine({ input_tokens: 10, output_tokens: 5 })).toContain("10 in / 5 out");
      expect(screen.queryByText(/cache/)).not.toBeInTheDocument();
    });

    it("shows a cache read of zero — that is what a prompt-cache miss looks like", () => {
      expect(usageLine({ input_tokens: 5000, output_tokens: 20, cache_read_tokens: 0 })).toContain(
        "5,000 in / 20 out · cache read 0",
      );
    });

    it("shows cache creation as 'cache write'", () => {
      expect(
        usageLine({ input_tokens: 5000, output_tokens: 20, cache_creation_tokens: 4800 }),
      ).toContain("cache write 4,800");
    });

    it("shows nothing for a null usage", () => {
      usageLine(null);
      expect(screen.queryByText(/ in \/ /)).not.toBeInTheDocument();
    });
  });

  it("marks a failed turn with an error chip and shows the error text", () => {
    render(
      <AssistantEventView
        event={modelTurn({ status: "error", error: "RateLimitError: 429", text: "" })}
        showThinking={false}
      />,
    );

    expect(within(screen.getByTestId("trace-model-meta")).getByText("error")).toBeInTheDocument();
    expect(screen.getByText("RateLimitError: 429")).toBeInTheDocument();
  });

  it("has no error chip or Error block on a turn that went fine", () => {
    render(
      <AssistantEventView event={modelTurn({ status: "ok", error: null })} showThinking={false} />,
    );

    expect(
      within(screen.getByTestId("trace-model-meta")).queryByText("error"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
  });

  it("keeps its thinking behind a toggle, which the global switch can open", () => {
    const turn = modelTurn({ thinking: "compare the two fares" });
    const { rerender } = render(<AssistantEventView event={turn} showThinking={false} />);
    expect(screen.queryByText("compare the two fares")).not.toBeInTheDocument();

    rerender(<AssistantEventView event={turn} showThinking />);
    expect(screen.getByText("compare the two fares")).toBeInTheDocument();
  });
});

describe("UnknownEventView", () => {
  it("names the kind and keeps the whole object one click away", async () => {
    const user = userEvent.setup();
    render(<UnknownEventView event={{ kind: "reasoning_summary", detail: "new field" }} />);

    expect(screen.getByText("reasoning_summary")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "raw" }));
    expect(screen.getByText(/"detail": "new field"/)).toBeInTheDocument();
  });

  it("copes with something that has no kind at all", () => {
    render(<UnknownEventView event="just a string" />);
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });
});
