"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Clipboard write that also works on plain-http addresses (no async clipboard API outside secure contexts). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based copy.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function useCopy(value: string) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    const ok = await copyText(value);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1600);
  };
  return { state, copy };
}

/** Copies `value`; the icon turns into a check for a moment and screen readers hear "Copied". */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  iconOnly = false,
  variant = "outline",
  size,
  className,
}: {
  value: string;
  /** Visible text, or the accessible name when `iconOnly`. */
  label?: string;
  copiedLabel?: string;
  iconOnly?: boolean;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
  className?: string;
}) {
  const { state, copy } = useCopy(value);
  const icon = state === "copied" ? <Check className="text-success" /> : <Copy />;
  const live = (
    <span aria-live="polite" className="sr-only">
      {state === "copied" ? copiedLabel : state === "failed" ? "Could not copy" : ""}
    </span>
  );
  if (iconOnly) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant={variant} size={size ?? "icon-sm"} aria-label={label} onClick={copy} className={className}>
            {icon}
            {live}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{state === "copied" ? copiedLabel : label}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Button type="button" variant={variant} size={size ?? "sm"} onClick={copy} className={className}>
      {icon}
      {state === "copied" ? copiedLabel : label}
      {live}
    </Button>
  );
}

/** A read-only value with a copy button — invite links, the cloud address, ids. The text selects with one click. */
export function CopyField({
  value,
  label = "Copy",
  mono = true,
  className,
}: {
  value: string;
  /** Accessible name of the copy button, e.g. "Copy invite link". */
  label?: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-1 rounded-md border border-input bg-paper-2 py-1 pr-1 pl-3 shadow-xs", className)}>
      <span className={cn("min-w-0 flex-1 truncate text-sm select-all", mono && "font-mono text-[13px] tabular-nums")} title={value}>
        {value}
      </span>
      <CopyButton value={value} label={label} iconOnly variant="ghost" />
    </div>
  );
}
