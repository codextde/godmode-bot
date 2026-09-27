import { cn } from "@/lib/utils";

/** The Godmode mark — a flat anthracite tile with a paper bolt (inverts in dark mode). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={cn("size-8 shrink-0", className)} aria-hidden>
      <rect x="16" y="16" width="480" height="480" rx="112" className="fill-primary" />
      <path
        d="M283 92 158 288h86l-22 132 132-204h-88l17-124Z"
        className="fill-primary-foreground stroke-primary-foreground"
        strokeWidth="10"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <Logo className="size-7" />
      <div className="leading-none">
        <div className="text-[15px] font-medium tracking-[-0.02em]">Godmode</div>
        <div className="mt-1 text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase">AI coworker</div>
      </div>
    </div>
  );
}

/**
 * Quiet paper backdrop for hero areas: dashed guide rails and a halftone dot field that fades out.
 * (Replaces the old aurora glow — no colour, no gradients.)
 */
export function Backdrop({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      <div className="absolute inset-x-0 top-0 h-[420px] bg-dots [mask-image:radial-gradient(ellipse_60%_70%_at_50%_0%,#000_10%,transparent_75%)] opacity-70" />
      <div className="guide-rails absolute inset-y-0 left-1/2 w-[min(100%-2rem,56rem)] -translate-x-1/2" />
    </div>
  );
}
