import { useState } from "react";
import { cn } from "@/lib/utils";

/** Composio toolkit logo on a white tile (logos are mostly dark marks) with a neutral initial-tile fallback. */
export function ToolkitLogo({ src, name, size = "md", className }: { src?: string | null; name: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const [failed, setFailed] = useState(false);
  const sizes = { sm: "size-7 rounded-md text-xs", md: "size-10 rounded-lg text-sm", lg: "size-14 rounded-xl text-xl" };
  const show = !!src && !failed;
  return (
    <div
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden border font-medium shadow-card",
        sizes[size],
        show ? "bg-white" : "bg-secondary text-foreground",
        className,
      )}
    >
      {show ? (
        <img src={src!} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-[64%] object-contain" onError={() => setFailed(true)} />
      ) : (
        <span>{name.trim().charAt(0).toUpperCase() || "?"}</span>
      )}
    </div>
  );
}

/** "googlecalendar" → "Googlecalendar"; used when the toolkit isn't in the loaded gallery. */
export function prettySlug(slug: string): string {
  return slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
