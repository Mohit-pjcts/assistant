import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// App-wide font/UI size control, Cmd/Ctrl +/- (browser-zoom-style), bound
// globally rather than per-panel — same persisted-preference shape as
// theme.tsx (localStorage, applied to <html>, survives a Tauri relaunch).
// Deliberately scales the DOCUMENT root font-size rather than a CSS
// transform/zoom: Astryx's whole design system is rem-based (its own Icon
// component's docs say sizes are "expressed in rem... so icons scale in
// step with text when the document font-size changes, matching the rest
// of the design system's rem-based type scale") — so this one change
// cascades through spacing, icons, and type across the entire app without
// touching individual components.

const STORAGE_KEY = "pa-ui-scale";
const BASE_FONT_SIZE_PX = 16;
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.6;
const SCALE_STEP = 0.1;
const DEFAULT_SCALE = 1;

interface UiScaleContextValue {
  scale: number;
  increase: () => void;
  decrease: () => void;
  reset: () => void;
}

const UiScaleContext = createContext<UiScaleContextValue | null>(null);

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(value * 100) / 100));
}

function readStoredScale(): number {
  const stored = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampScale(stored) : DEFAULT_SCALE;
}

function applyScale(scale: number) {
  document.documentElement.style.fontSize = `${BASE_FONT_SIZE_PX * scale}px`;
}

export function UiScaleProvider({ children }: { children: ReactNode }) {
  const [scale, setScale] = useState<number>(readStoredScale);

  useEffect(() => {
    applyScale(scale);
    localStorage.setItem(STORAGE_KEY, String(scale));
  }, [scale]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      // "=" is the unshifted key that also carries "+" on a US keyboard —
      // browsers' own native zoom shortcut treats both the same way, so
      // this does too, rather than requiring Shift to be held.
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        setScale((prev) => clampScale(prev + SCALE_STEP));
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setScale((prev) => clampScale(prev - SCALE_STEP));
      } else if (event.key === "0") {
        event.preventDefault();
        setScale(DEFAULT_SCALE);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <UiScaleContext.Provider
      value={{
        scale,
        increase: () => setScale((prev) => clampScale(prev + SCALE_STEP)),
        decrease: () => setScale((prev) => clampScale(prev - SCALE_STEP)),
        reset: () => setScale(DEFAULT_SCALE),
      }}
    >
      {children}
    </UiScaleContext.Provider>
  );
}

export function useUiScale(): UiScaleContextValue {
  const ctx = useContext(UiScaleContext);
  if (!ctx) throw new Error("useUiScale must be used within a UiScaleProvider");
  return ctx;
}
