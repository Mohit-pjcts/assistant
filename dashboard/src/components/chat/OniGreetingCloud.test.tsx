import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { OniGreetingCloud } from "./OniGreetingCloud";

const idleFloatRevert = vi.fn();
const scopeRevert = vi.fn();

vi.mock("animejs", () => {
  const animate = vi.fn(
    (_targets: unknown, params: { onComplete?: () => void; loop?: boolean }) => {
      // Simulate the pop-in spring completing immediately, synchronously
      // triggering the idle-float animate() call the same way a real
      // animation eventually would.
      params?.onComplete?.();
      return { revert: params?.loop ? idleFloatRevert : vi.fn() };
    },
  );
  const createScope = vi.fn(() => {
    const scope = {
      add: vi.fn((callback: (self: { add: (name: string, fn: () => void) => void }) => void) => {
        callback({ add: vi.fn() });
        return scope;
      }),
      revert: scopeRevert,
      methods: {} as Record<string, () => void>,
    };
    return scope;
  });
  return { animate, createScope, spring: vi.fn(() => "spring"), stagger: vi.fn(() => 0) };
});

vi.mock("@/components/nav/BrandMark", () => ({ BrandMark: () => null }));

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
  idleFloatRevert.mockClear();
  scopeRevert.mockClear();
  // This component queries "(prefers-reduced-motion: reduce)" directly
  // (opposite polarity from RateLimitCountdown's "no-preference" query) —
  // matches: false means reduced motion is NOT requested, so animation runs.
  mockReducedMotion(false);
});

describe("OniGreetingCloud", () => {
  it("reverts both the idle-float animation and the scope on unmount", () => {
    const { unmount } = render(<OniGreetingCloud name="Mohit" />);
    unmount();
    cleanup();
    expect(idleFloatRevert).toHaveBeenCalledTimes(1);
    expect(scopeRevert).toHaveBeenCalledTimes(1);
  });
});
