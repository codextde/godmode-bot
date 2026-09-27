import { useState } from "react";
import { cn } from "@/lib/utils";
import { hueFor } from "@/components/vault/vault-utils";

/** Composio toolkit logo on a white tile (logos are mostly dark marks) with an initial-tile fallback. */
export function ToolkitLogo({ src, name, size = "md", className }: { src?: string | null; name: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const [failed, setFailed] = useState(false);
  const sizes = { sm: "size-7 rounded-lg text-xs", md: "size-10 rounded-xl text-sm", lg: "size-14 rounded-2xl text-xl" };
  const hue = hueFor(name.toLowerCase());
  const show = !!src && !failed;
  return (
    <div
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden font-semibold text-white shadow-sm ring-1 ring-black/5 dark:ring-white/10",
        sizes[size],
        show && "bg-white",
        className,
      )}
      style={show ? undefined : { background: `linear-gradient(135deg, oklch(0.68 0.16 ${hue}), oklch(0.52 0.19 ${(hue + 40) % 360}))` }}
    >
      {show ? (
        <img src={src!} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-[64%] object-contain" onError={() => setFailed(true)} />
      ) : (
        <span className="drop-shadow-sm">{name.trim().charAt(0).toUpperCase() || "?"}</span>
      )}
    </div>
  );
}

/** "googlecalendar" → "Googlecalendar"; used when the toolkit isn't in the loaded gallery. */
export function prettySlug(slug: string): string {
  return slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
