import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HistoryForbiddenError,
  fetchHistoryTrace,
  fetchOnstageJournal,
  fetchStageRun,
  fetchStageRuns,
} from "./api";

// The History panel's four fetchers, against a stubbed fetch — these pin the
// request shapes (path, query string) and the 403 meaning that the backend
// side of STEPS.md 158 is built to separately, so the two halves can't drift
// apart unnoticed.

const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
}

// The URL the (single) call went to, parsed so assertions don't depend on
// query-parameter order.
function requestedUrl(): URL {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return new URL(String(fetchMock.mock.calls[0][0]));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchHistoryTrace", () => {
  it("asks for the active thread with no query string at all by default", async () => {
    reply(200, { thread_id: "t1", total_turns: 0, turns: [] });

    await fetchHistoryTrace();

    const url = requestedUrl();
    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe("/history/trace");
    expect(url.search).toBe("");
  });

  it("passes the thread, page size and 'before' cursor along", async () => {
    reply(200, { thread_id: "thread 1", total_turns: 0, turns: [] });

    await fetchHistoryTrace("thread 1", { limit: 30, before: 12 });

    const params = requestedUrl().searchParams;
    expect(params.get("thread_id")).toBe("thread 1");
    expect(params.get("limit")).toBe("30");
    expect(params.get("before")).toBe("12");
  });

  it("sends a 'before' of 0 rather than treating it as absent", async () => {
    reply(200, { thread_id: "t1", total_turns: 0, turns: [] });

    await fetchHistoryTrace(undefined, { before: 0 });

    expect(requestedUrl().searchParams.get("before")).toBe("0");
  });

  it("returns the response body as is", async () => {
    const body = {
      thread_id: "t1",
      total_turns: 1,
      turns: [{ index: 0, user: null, events: [], reply: null }],
    };
    reply(200, body);

    await expect(fetchHistoryTrace()).resolves.toEqual(body);
  });
});

describe("fetchStageRuns", () => {
  it("sends no query string without options", async () => {
    reply(200, { runs: [], next: null });

    await fetchStageRuns();

    expect(requestedUrl().pathname).toBe("/stage/runs");
    expect(requestedUrl().search).toBe("");
  });

  it("passes the page size and the cursor run id", async () => {
    reply(200, { runs: [], next: null });

    await fetchStageRuns({ limit: 50, before: "run-jev-2026-10-04T19-18-41-018Z-p5q8" });

    const params = requestedUrl().searchParams;
    expect(params.get("limit")).toBe("50");
    expect(params.get("before")).toBe("run-jev-2026-10-04T19-18-41-018Z-p5q8");
  });
});

describe("fetchStageRun", () => {
  it("fetches one run by id, percent-encoding anything unusual in it", async () => {
    reply(200, { run_id: "run-a", summary: {}, lines: [] });

    await fetchStageRun("run-a/../b c");

    expect(requestedUrl().pathname).toBe("/stage/runs/run-a%2F..%2Fb%20c");
  });
});

describe("fetchOnstageJournal", () => {
  it("asks for 50 entries by default and returns just the entries", async () => {
    reply(200, { entries: [{ t: "x", question: "q" }] });

    const entries = await fetchOnstageJournal();

    expect(requestedUrl().pathname).toBe("/stage/onstage");
    expect(requestedUrl().searchParams.get("limit")).toBe("50");
    expect(entries).toEqual([{ t: "x", question: "q" }]);
  });

  it("takes a different limit", async () => {
    reply(200, { entries: [] });

    await fetchOnstageJournal(5);

    expect(requestedUrl().searchParams.get("limit")).toBe("5");
  });
});

describe("failures", () => {
  it.each([
    ["fetchHistoryTrace", () => fetchHistoryTrace("t1", { limit: 30 })],
    ["fetchStageRuns", () => fetchStageRuns({ limit: 50 })],
    ["fetchStageRun", () => fetchStageRun("run-a")],
    ["fetchOnstageJournal", () => fetchOnstageJournal()],
  ])("%s turns a 403 into a HistoryForbiddenError", async (_name, call) => {
    reply(403, { detail: "loopback only" });

    const error = await call().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HistoryForbiddenError);
    // The query string (a thread id, a cursor) stays out of the message.
    expect((error as Error).message).not.toContain("?");
  });

  it("turns any other non-OK response into an ordinary error with the status and body", async () => {
    reply(500, "traces.sqlite is locked");

    const error = await fetchHistoryTrace().catch((err: unknown) => err);

    expect(error).not.toBeInstanceOf(HistoryForbiddenError);
    expect((error as Error).message).toContain("/history/trace failed (500)");
    expect((error as Error).message).toContain("traces.sqlite is locked");
  });

  it("treats a 400 for a malformed run id as an ordinary error, not a 403", async () => {
    reply(400, "bad run id");

    const error = await fetchStageRun("nope").catch((err: unknown) => err);

    expect(error).not.toBeInstanceOf(HistoryForbiddenError);
    expect((error as Error).message).toContain("(400)");
  });
});
