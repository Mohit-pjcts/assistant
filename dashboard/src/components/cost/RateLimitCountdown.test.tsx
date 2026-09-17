import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { RateLimitCountdown } from "./RateLimitCountdown";

function mockReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  mockReducedMotion(true); // "no-preference" matches — animation allowed
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RateLimitCountdown", () => {
  it("renders the correct segment values for a future resetAt", () => {
    const resetAt = new Date(Date.now() + 65_000).toISOString(); // 1m 5s out
    render(<RateLimitCountdown resetAt={resetAt} />);
    expect(screen.getByText("m")).toBeInTheDocument();
    expect(screen.getByText("s")).toBeInTheDocument();
  });

  it("calls onExpire exactly once when the countdown reaches zero, even after further ticks", () => {
    const resetAt = new Date(Date.now() + 2_000).toISOString();
    const onExpire = vi.fn();
    render(<RateLimitCountdown resetAt={resetAt} onExpire={onExpire} />);

    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
