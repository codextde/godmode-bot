import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { copySecret, copyText } from "./clipboard";

/** Icon button that copies a value (or the result of an async getter, e.g. reveal) with a check-mark flash. */
export function CopyButton({
  value,
  getValue,
  secret = false,
  label = "Copy",
  toastLabel,
  className,
  size = "icon-sm",
  icon,
}: {
  value?: string;
  getValue?: () => Promise<string | null | undefined>;
  secret?: boolean;
  label?: string;
  toastLabel?: string;
  className?: string;
  size?: "icon-sm" | "icon-xs" | "icon";
  icon?: ReactNode;
}) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      const v = value ?? (await getValue?.());
      if (!v) return;
      await (secret ? copySecret(v, toastLabel ?? `${label.replace(/^Copy /, "")} copied`) : copyText(v, toastLabel ?? "Copied"));
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size={size} className={cn("text-muted-foreground hover:text-foreground", className)} aria-label={label} onClick={onClick} disabled={busy}>
          {done ? <Check className="text-success" /> : (icon ?? <Copy />)}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
