"use client";

import type { ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Segmented } from "@/components/controls";
import { useTheme, type Theme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const OPTIONS: { value: Theme; label: string; icon: ReactNode }[] = [
  { value: "light", label: "Light", icon: <Sun /> },
  { value: "dark", label: "Dark", icon: <Moon /> },
  { value: "system", label: "System", icon: <Monitor /> },
];

/**
 * Light / Dark / System. `segmented` (default) for menus and the account page; `icon` is a single button that flips
 * between light and dark (AuthShell corner).
 */
export function ThemeToggle({ variant = "segmented", className }: { variant?: "segmented" | "icon"; className?: string }) {
  const { theme, resolved, setTheme } = useTheme();
  if (variant === "icon") {
    const next = resolved === "dark" ? "light" : "dark";
    const label = next === "dark" ? "Switch to dark theme" : "Switch to light theme";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={label} onClick={() => setTheme(next)} className={className}>
            {/* Both icons render on the server; CSS shows the right one before hydration. */}
            <Sun className="hidden dark:block" aria-hidden />
            <Moon className="block dark:hidden" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Segmented
      aria-label="Theme"
      size="sm"
      value={theme}
      onChange={setTheme}
      options={OPTIONS.map((o) => ({ value: o.value, label: o.label, icon: o.icon }))}
      className={className}
    />
  );
}
