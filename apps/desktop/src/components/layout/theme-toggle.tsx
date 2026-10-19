import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTheme } from "@/components/theme-provider";
import { modKey } from "@/lib/desktop";

export const THEME_SHORTCUT = `${modKey}⇧L`;

/** Light and dark in one click; "System" stays in Settings → General. */
export function ThemeToggle() {
  const { theme, resolved, toggle } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={`Switch to ${next} mode`} onClick={toggle}>
          {resolved === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>
          Switch to {next} mode <span className="opacity-60">({THEME_SHORTCUT})</span>
        </p>
        {theme === "system" && <p className="opacity-70">Following your system until you pick one</p>}
      </TooltipContent>
    </Tooltip>
  );
}
