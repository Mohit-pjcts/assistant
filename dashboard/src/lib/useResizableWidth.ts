import { useCallback, useEffect, useState } from "react";

// Backs App.tsx's draggable column dividers (thread sidebar / right
// context rail) — same persisted-preference shape as uiScale.tsx
// (localStorage, read once at mount, survives a Tauri relaunch).

interface UseResizableWidthOptions {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function useResizableWidth({
  storageKey,
  defaultWidth,
  min,
  max,
}: UseResizableWidthOptions) {
  const [width, setWidthState] = useState<number>(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0 ? clamp(stored, min, max) : defaultWidth;
  });

  useEffect(() => {
    localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  const setWidth = useCallback(
    (updater: number | ((prev: number) => number)) => {
      setWidthState((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        return clamp(next, min, max);
      });
    },
    [min, max],
  );

  return { width, setWidth };
}
