import type { ReactNode } from "react";
import { colorGradient } from "@/components/common";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "size-6 rounded-md text-[13px]",
  md: "size-10 rounded-lg text-xl",
  lg: "size-14 rounded-xl text-3xl",
  xl: "size-16 rounded-2xl text-4xl",
} as const;

/** Emoji on a flat, softly tinted tile in the workspace colour (token like "violet" or a hex color). */
export function WorkspaceTile({
  icon,
  color,
  size = "lg",
  className,
  children,
}: {
  icon?: string;
  color: string;
  size?: keyof typeof SIZES;
  className?: string;
  children?: ReactNode;
}) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color);
  return (
    <div
      className={cn(
        "grid shrink-0 place-items-center ring-1 ring-inset",
        hex ? "ring-foreground/10" : colorGradient(color),
        SIZES[size],
        className,
      )}
      style={hex ? { backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)` } : undefined}
      aria-hidden
    >
      {children ?? <span>{icon || "🗂️"}</span>}
    </div>
  );
}
