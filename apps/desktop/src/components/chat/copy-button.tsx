import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for contexts without clipboard permission
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

export function CopyButton({
  text,
  label = "Copy",
  className,
  size = "icon-xs",
  showLabel = false,
}: {
  text: string;
  label?: string;
  className?: string;
  size?: "icon-xs" | "icon-sm" | "xs";
  showLabel?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  const icon = copied ? <Check className="text-success" /> : <Copy />;
  const button = (
    <Button
      type="button"
      variant="ghost"
      size={showLabel ? "xs" : size}
      onClick={onClick}
      aria-label={copied ? "Copied" : label}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    >
      {icon}
      {showLabel && <span>{copied ? "Copied" : label}</span>}
    </Button>
  );
  if (showLabel) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}
