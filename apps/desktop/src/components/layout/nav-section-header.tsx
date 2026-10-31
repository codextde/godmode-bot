import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** The label of a foldable sidebar section; the chevron shows on hover while folded and turns down when open. */
export function NavSectionHeader({
  label,
  open,
  controls,
  onToggle,
  quiet = false,
}: {
  label: string;
  open: boolean;
  controls: string;
  onToggle: () => void;
  /** While folded, show the chevron only on hover. */
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className="eyebrow group/label flex h-7 min-w-0 shrink items-center gap-1 rounded-md px-2 text-[10.5px] text-sidebar-foreground/70 outline-none transition hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:hidden"
    >
      {label}
      <ChevronRight
        className={cn(
          "size-3 transition",
          quiet && !open && "opacity-0 group-hover/label:opacity-100 group-focus-visible/label:opacity-100",
          open && "rotate-90",
        )}
      />
    </button>
  );
}
