import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// Theme provider for the Phase 14 visual pass. Three states: explicit light,
// explicit dark, or "system" which follows the OS preference and stays live
// if the OS preference changes mid-session. Persisted to localStorage so the
// choice survives a relaunch of the Tauri window.
//
// Default for a fresh install (nothing in localStorage yet) is "dark", not
// "system" — a real gap found live during Phase 28's own fix pass
// (instrument/FIX_PLAN.md): the Obsidian-violet theme
// (oniObsidianTheme.ts) is dark-mode-first BY DESIGN (the mockup this was
// ported from is dark-only; light mode is new invention this project took
// on, not a port), and "system" was silently handing a light-preference
// Mac a first impression that reads as generic pale SaaS instead of the
// intended identity. "System"/"Light" both stay fully available via the
// existing toggle — this only changes what a NEVER-configured install
// opens to. Anyone with an existing stored preference (including an
// existing explicit "system" choice) is completely unaffected.
export type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "pa-theme";
const DEFAULT_THEME: Theme = "dark";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : DEFAULT_THEME;
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyResolvedTheme(resolved: ResolvedTheme) {
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme,
  );

  useEffect(() => {
    function resolve() {
      const resolved: ResolvedTheme =
        theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
      setResolvedTheme(resolved);
      applyResolvedTheme(resolved);
    }
    resolve();

    if (theme !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", resolve);
    return () => mql.removeEventListener("change", resolve);
  }, [theme]);

  function setTheme(next: Theme) {
    localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
