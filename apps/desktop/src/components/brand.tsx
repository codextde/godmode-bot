import { cn } from "@/lib/utils";

/** The Godmode mark (inline SVG so it scales crisply and themes nicely). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={cn("size-8 shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id="gm-logo-bg" x1="48" y1="32" x2="464" y2="480" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8B5CF6" />
          <stop offset="0.55" stopColor="#6366F1" />
          <stop offset="1" stopColor="#06B6D4" />
        </linearGradient>
      </defs>
      <rect x="16" y="16" width="480" height="480" rx="120" fill="url(#gm-logo-bg)" />
      <circle cx="256" cy="256" r="150" stroke="#fff" strokeOpacity="0.28" strokeWidth="14" fill="none" />
      <path d="M283 92 158 288h86l-22 132 132-204h-88l17-124Z" fill="#fff" stroke="#fff" strokeWidth="10" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <Logo className="size-7" />
      <div className="leading-none">
        <div className="text-[15px] font-semibold tracking-tight">Godmode</div>
        <div className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-muted-foreground">AI coworker</div>
      </div>
    </div>
  );
}

/** Soft animated aurora used behind hero areas. */
export function Aurora({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      <div className="absolute -top-1/3 left-1/2 h-[60vh] w-[70vw] -translate-x-1/2 rounded-full bg-glow-a/25 blur-[120px] animate-aurora" />
      <div className="absolute top-1/4 -left-1/4 h-[45vh] w-[45vw] rounded-full bg-glow-b/15 blur-[120px] animate-aurora [animation-delay:-6s]" />
      <div className="absolute -bottom-1/4 right-0 h-[40vh] w-[40vw] rounded-full bg-glow-c/10 blur-[120px] animate-aurora [animation-delay:-12s]" />
    </div>
  );
}
