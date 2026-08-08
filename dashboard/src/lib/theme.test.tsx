import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ThemeProvider, useTheme } from "./theme";

// PLAN.md Phase 28's own fix pass (instrument/FIX_PLAN.md) — a fresh
// install must default to dark, not "system", since the Obsidian-violet
// theme is dark-mode-first by design and "system" was silently handing a
// light-preference OS a generic, unintended-looking first impression.

function mockMatchMedia(prefersDark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("dark") ? prefersDark : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

// This project's Node version ships a native `localStorage` global that
// requires a `--localstorage-file <path>` flag to actually function —
// without it (confirmed directly), it's a non-functional stub with no
// setItem/getItem/removeItem at all, shadowing jsdom's own real
// implementation. Real browsers (what this app actually ships to) have
// no such gap; this is purely a test-environment limitation, worked
// around the same way as this session's other confirmed jsdom/Node gaps
// (AnimationEvent, setPointerCapture, createSVGPoint) — a small real
// in-memory stand-in, not a change to the module under test.
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeLocalStorage());
  document.documentElement.classList.remove("dark");
  mockMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThemeProvider default", () => {
  it("defaults a fresh install (nothing in localStorage) to dark, even when the OS prefers light", () => {
    mockMatchMedia(false); // OS prefers light
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.theme).toBe("dark");
    expect(result.current.resolvedTheme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("defaults to dark even when the OS prefers dark (dark either way, not incidentally)", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.theme).toBe("dark");
    expect(result.current.resolvedTheme).toBe("dark");
  });

  it("leaves an existing stored preference completely untouched", () => {
    localStorage.setItem("pa-theme", "light");
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.theme).toBe("light");
    expect(result.current.resolvedTheme).toBe("light");
  });

  it("an existing explicit 'system' preference still follows the OS, unaffected by the new default", () => {
    localStorage.setItem("pa-theme", "system");
    mockMatchMedia(true);
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });

    expect(result.current.theme).toBe("system");
    expect(result.current.resolvedTheme).toBe("dark");
  });

  it("setTheme still switches away from the new default and persists it", () => {
    const { result } = renderHook(() => useTheme(), { wrapper: ThemeProvider });
    expect(result.current.theme).toBe("dark");

    act(() => result.current.setTheme("light"));

    expect(result.current.theme).toBe("light");
    expect(result.current.resolvedTheme).toBe("light");
    expect(localStorage.getItem("pa-theme")).toBe("light");
  });
});
