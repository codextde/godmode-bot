import type { ReactNode } from "react";
import { colorGradient } from "@/components/common";
import { cn } from "@/lib/utils";

const SIZES = {
  md: "size-10 rounded-xl text-xl",
  lg: "size-14 rounded-2xl text-3xl",
  xl: "size-16 rounded-2xl text-4xl",
} as const;

/** Emoji tile on the workspace color gradient (token like "violet" or a hex color). */
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
        "grid shrink-0 place-items-center bg-gradient-to-br shadow-lg ring-1 ring-white/15 ring-inset",
        !hex && colorGradient(color),
        SIZES[size],
        className,
      )}
      style={hex ? { background: `linear-gradient(135deg, ${color}, color-mix(in oklab, ${color} 70%, black))` } : undefined}
      aria-hidden
    >
      {children ?? <span className="drop-shadow-sm">{icon || "🗂️"}</span>}
    </div>
  );
}
