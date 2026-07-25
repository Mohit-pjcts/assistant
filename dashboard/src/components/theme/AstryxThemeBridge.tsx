import type { ReactNode } from "react";
import { Theme } from "@astryxdesign/core/theme";
import { oniMatchaTheme } from "@/themes/oniMatcha/oni-matcha";
import { useTheme } from "@/lib/theme";

// Keeps ONE toggle (lib/theme.tsx's ThemeProvider) driving both the
// existing shadcn `.dark` class and Astryx's own <Theme mode>, rather than
// introducing a second light/dark control. Must be rendered INSIDE
// ThemeProvider (useTheme() throws otherwise).
export function AstryxThemeBridge({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  return (
    <Theme theme={oniMatchaTheme} mode={resolvedTheme}>
      {children}
    </Theme>
  );
}
