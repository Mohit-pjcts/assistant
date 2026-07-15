import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme, type Theme } from "@/lib/theme";

// Cycles system -> light -> dark -> system. "System" is the default and the
// icon always reflects the CURRENTLY RESOLVED appearance, not the setting
// name, so the button reads correctly even while following the OS.
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

const ICON = { system: Monitor, light: Sun, dark: Moon } as const;

const LABEL = {
  system: "Following system appearance",
  light: "Light theme",
  dark: "Dark theme",
} as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const Icon = ICON[theme];

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Theme: ${LABEL[theme]}. Click to change.`}
      title={LABEL[theme]}
      onClick={() => setTheme(NEXT[theme])}
    >
      <Icon />
    </Button>
  );
}
