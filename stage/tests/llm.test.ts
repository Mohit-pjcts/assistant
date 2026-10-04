// Claude cost accounting, with a stand-in client (no network).
import { afterEach, expect, test } from "bun:test";
import { PRICES, callTool, costOf, priceOf, setClientForTests } from "../src/llm.ts";

const tool = { name: "answer", description: "x", input_schema: { type: "object" } };
const text = (s: string, inTok: number, outTok: number) => ({ content: [{ type: "text", text: s }], stop_reason: "end_turn", usage: { input_tokens: inTok, output_tokens: outTok } });
const call = (input: unknown, inTok: number, outTok: number) => ({ content: [{ type: "tool_use", name: "answer", input }], stop_reason: "tool_use", usage: { input_tokens: inTok, output_tokens: outTok } });

/** answers in order; a string answer = throw that error */
function fake(answers: unknown[]) {
  const seen: any[] = [];
  setClientForTests({ messages: { create: async (req: any) => { seen.push(req); const a = answers.shift(); if (typeof a === "string") throw new Error(a); return a; } } });
  return seen;
}
afterEach(() => setClientForTests(null));

test("a plain-text answer and its retry are both paid for", async () => {
  // Sonnet refuses a forced tool_choice, then answers in text once, then calls the tool
  const seen = fake(["tool_choice is not supported", text("Sure! 7", 1000, 50), call({ choice: "7" }, 1100, 30)]);
  const r = await callTool<{ choice: string }>({ model: "claude-sonnet-5-5", system: "s", user: "u", tool });
  expect(seen.length).toBe(3);
  expect(r.input.choice).toBe("7");
  expect(r.inputTokens).toBe(2100);
  expect(r.outputTokens).toBe(80);
  expect(r.costUsd).toBeCloseTo((2100 * 2 + 80 * 10) / 1e6, 12);
  expect(r.costEstimated).toBeUndefined();
});

test("a model with no listed price is estimated at the most expensive price, never $0", async () => {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (m: string) => warnings.push(String(m));
  try {
    fake([call({ ok: 1 }, 1000, 100), call({ ok: 1 }, 1000, 100)]);
    const r = await callTool({ model: "claude-future-9", system: "s", user: "u", tool });
    const maxIn = Math.max(...Object.values(PRICES).map((p) => p[0])), maxOut = Math.max(...Object.values(PRICES).map((p) => p[1]));
    expect(r.costUsd).toBeCloseTo((1000 * maxIn + 100 * maxOut) / 1e6, 12);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.costEstimated).toBe(true);
    await callTool({ model: "claude-future-9", system: "s", user: "u", tool });
    expect(warnings.filter((w) => w.includes("claude-future-9")).length).toBe(1); // warned once
  } finally { console.warn = warn; }
});

test("dated forms of a listed model use its price", () => {
  expect(priceOf("claude-sonnet-5-5-20261001")).toEqual({ price: PRICES["claude-sonnet-5-5"]!, estimated: false });
  expect(priceOf("claude-haiku-4-5")).toEqual({ price: PRICES["claude-haiku-4-5-20251001"]!, estimated: false });
  expect(costOf("claude-haiku-4-5-20251001", 1e6, 1e6)).toBe(6);
});

test("when no tool call ever comes, the error still carries what was paid", async () => {
  fake(["tool_choice is not supported", text("no", 500, 10), text("still no", 500, 10)]);
  const err: any = await callTool({ model: "claude-sonnet-5-5", system: "s", user: "u", tool }).catch((e) => e);
  expect(String(err.message)).toContain("returned no tool call");
  expect(err.costUsd).toBeCloseTo((1000 * 2 + 20 * 10) / 1e6, 12);
});
