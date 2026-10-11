import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatCount,
  formatDuration,
  formatSeconds,
  formatTimestamp,
  formatUsage,
  formatUsd,
  previewText,
} from "./format";

describe("formatDuration", () => {
  it("shows milliseconds under a second, seconds under a minute, then minutes", () => {
    expect(formatDuration(340)).toBe("340 ms");
    expect(formatDuration(1234)).toBe("1.2 s");
    expect(formatDuration(125_000)).toBe("2m 05s");
  });

  it("rolls 59.96s over to a minute instead of printing 60.0 s or 1m 60s", () => {
    expect(formatDuration(59_960)).toBe("1m 00s");
    expect(formatDuration(119_600)).toBe("2m 00s");
  });

  it("returns null for anything that isn't a number, so callers can omit the field", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });
});

describe("formatSeconds", () => {
  it("converts Stage's fractional seconds", () => {
    expect(formatSeconds(8.2)).toBe("8.2 s");
    expect(formatSeconds(null)).toBeNull();
  });
});

describe("formatUsd", () => {
  it("keeps sub-cent precision, which is the whole point for a helper call's cost", () => {
    expect(formatUsd(0.00031)).toBe("$0.00031");
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("returns null when there's no figure", () => {
    expect(formatUsd(null)).toBeNull();
    expect(formatUsd(undefined)).toBeNull();
  });
});

describe("formatCount", () => {
  it("groups thousands with a fixed locale", () => {
    expect(formatCount(12345)).toBe("12,345");
  });
});

describe("formatUsage", () => {
  it("shows in and out tokens", () => {
    expect(formatUsage({ input_tokens: 1204, output_tokens: 310 })).toBe("1,204 in / 310 out");
  });

  it("adds the cache figures whenever the provider reported them, zero included", () => {
    expect(
      formatUsage({
        input_tokens: 5000,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_creation_tokens: 4800,
      }),
    ).toBe("5,000 in / 20 out · cache read 0 · cache write 4,800");
  });

  it("leaves out cache figures that are null or absent", () => {
    expect(
      formatUsage({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: null,
        cache_creation_tokens: null,
      }),
    ).toBe("1 in / 2 out");
  });

  it("is null when there is no usage, and treats missing counts as zero", () => {
    expect(formatUsage(null)).toBeNull();
    expect(formatUsage(undefined)).toBeNull();
    expect(formatUsage({} as never)).toBe("0 in / 0 out");
  });
});

describe("formatTimestamp / formatClock", () => {
  it("returns an empty string for a missing value and the raw string for an unparseable one", () => {
    expect(formatTimestamp(null)).toBe("");
    expect(formatTimestamp("not a date")).toBe("not a date");
    expect(formatClock(undefined)).toBe("");
    expect(formatClock("not a date")).toBe("not a date");
  });

  it("formats a real ISO string into something readable", () => {
    expect(formatTimestamp("2026-10-04T19:18:41.018Z")).toMatch(/2026/);
    expect(formatClock("2026-10-04T19:18:41.018Z")).toMatch(/\d{2}.\d{2}.\d{2}/);
  });
});

describe("previewText", () => {
  it("collapses whitespace and cuts to the limit with an ellipsis", () => {
    expect(previewText("a   b\n\nc")).toBe("a b c");
    expect(previewText("x".repeat(200), 10)).toBe(`${"x".repeat(10)}…`);
  });

  it("stringifies objects compactly", () => {
    expect(previewText({ to: "a@b.co", n: 1 })).toBe('{"to":"a@b.co","n":1}');
  });

  it("marks a very long input as cut even when its collapsed form is short", () => {
    // 700 spaces after a short word: collapsing whitespace alone would make
    // this look complete.
    expect(previewText(`hi${" ".repeat(700)}there`, 10).endsWith("…")).toBe(true);
  });

  it("returns an empty string for undefined", () => {
    expect(previewText(undefined)).toBe("");
  });
});
