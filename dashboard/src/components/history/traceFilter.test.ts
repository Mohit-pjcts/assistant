import { describe, expect, it } from "vitest";
import { eventMatches, filterTurns } from "./traceFilter";
import { modelTurn, surface, tool, turn } from "./testFixtures";

describe("eventMatches", () => {
  it("matches a tool call on its name, agent, status, arguments and output, ignoring case", () => {
    const call = tool({
      name: "send_email",
      agent: "life_admin_agent",
      status: "error",
      input: { to: "Dana@Example.com" },
      output: "Error: quota exceeded",
    });
    for (const query of ["SEND_EMAIL", "life_admin", "error", "dana@example.com", "quota"]) {
      expect(eventMatches(call, query)).toBe(true);
    }
    expect(eventMatches(call, "calendar")).toBe(false);
  });

  it("matches a delegation through any of its inner calls, however deep", () => {
    const delegation = tool({
      name: "research_agent",
      delegation: "research_agent",
      children: [
        tool({
          id: "c1",
          agent: "research_agent",
          children: [tool({ id: "c2", name: "deep_tool" })],
        }),
      ],
    });
    expect(eventMatches(delegation, "deep_tool")).toBe(true);
  });

  it("matches assistant text, thinking and context content", () => {
    expect(eventMatches({ kind: "assistant", text: "Booked it", thinking: "check tz" }, "tz")).toBe(
      true,
    );
    expect(
      eventMatches({ kind: "context", label: "recalled facts", content: "likes tea" }, "tea"),
    ).toBe(true);
  });

  it("treats a blank query as matching everything", () => {
    expect(eventMatches(tool(), "   ")).toBe(true);
  });

  describe("what a specialist said and thought inside a delegation", () => {
    const delegation = tool({
      name: "research_agent",
      delegation: "research_agent",
      children: [
        modelTurn({
          id: "m1",
          text: "Checking the refund policy page.",
          thinking: "the user said the fare was nonrefundable",
          model: "claude-sonnet-5",
        }),
        modelTurn({
          id: "m2",
          agent: "coding_agent",
          status: "error",
          error: "RateLimitError: 429",
          text: "",
        }),
      ],
    });

    it("matches a delegation through its inner model turn's text", () => {
      expect(eventMatches(delegation, "refund policy")).toBe(true);
    });

    it("matches through the turn's thinking, agent, model and error too", () => {
      for (const query of ["nonrefundable", "coding_agent", "claude-sonnet-5", "ratelimiterror"]) {
        expect(eventMatches(delegation, query)).toBe(true);
      }
    });

    it("matches a model turn on its own", () => {
      expect(eventMatches(modelTurn({ text: "needle in a haystack" }), "needle")).toBe(true);
      expect(eventMatches(modelTurn({ text: "nothing here" }), "needle")).toBe(false);
    });
  });

  it("matches a call by its error text", () => {
    const failed = tool({ status: "error", output: null, error: "RuntimeError: gmail timed out" });
    expect(eventMatches(failed, "gmail timed out")).toBe(true);
  });

  it("matches a call by what else its result carried", () => {
    const call = tool({
      extras: { phone_action: [{ type: "open_url", url: "https://example.com/tickets" }] },
    });
    expect(eventMatches(call, "example.com/tickets")).toBe(true);
    expect(eventMatches(tool({ extras: {} }), "phone_action")).toBe(false);
  });

  it("matches the raw string of an invalid call's arguments", () => {
    const invalid = tool({ status: "error", input: '{"query": "weather in Austin"' });
    expect(eventMatches(invalid, "weather in austin")).toBe(true);
  });

  it("doesn't search a call's cards, whose component trees would match every field type", () => {
    const call = tool({ surfaces: [surface("a card that mentions the moon")] });
    expect(eventMatches(call, "moon")).toBe(false);
    expect(eventMatches(call, "component")).toBe(false);
  });
});

describe("filterTurns", () => {
  const turns = [
    turn(0, {
      user: { content: "what's the weather", synthetic: false },
      events: [tool({ id: "a", name: "web_search" }), tool({ id: "b", name: "web_fetch" })],
    }),
    turn(1, {
      user: { content: "email dana", synthetic: false },
      events: [
        tool({ id: "c", name: "life_admin_agent", delegation: "life_admin_agent" }),
        { kind: "assistant", text: "Sent.", thinking: null },
      ],
    }),
    turn(2, {
      user: { content: "thanks", synthetic: false },
      events: [tool({ id: "d", name: "calendar_search" }), tool({ id: "e", name: "web_search" })],
    }),
  ];

  it("returns the very same array for an empty query (nothing to recompute)", () => {
    expect(filterTurns(turns, "")).toBe(turns);
    expect(filterTurns(turns, "  ")).toBe(turns);
  });

  it("keeps only the turns with a matching event, narrowed to those events", () => {
    const result = filterTurns(turns, "web_search");
    expect(result.map((t) => t.index)).toEqual([0, 2]);
    expect(result[0].events).toHaveLength(1);
    expect(result[1].events).toHaveLength(1);
  });

  it("keeps a whole turn when its user message matches", () => {
    const result = filterTurns(turns, "email dana");
    expect(result.map((t) => t.index)).toEqual([1]);
    expect(result[0].events).toHaveLength(2);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterTurns(turns, "zebra")).toEqual([]);
  });

  it("doesn't mutate the turns it was given", () => {
    filterTurns(turns, "web_search");
    expect(turns[0].events).toHaveLength(2);
  });
});
