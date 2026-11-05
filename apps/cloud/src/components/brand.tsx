import { cn } from "@/lib/utils";

/** The product name when nobody renamed the cloud in Settings → General. */
export const DEFAULT_APP_NAME = "Godmode Cloud";

/** The Godmode mark — a flat anthracite tile with a paper bolt (inverts in dark mode). */
export function Logo({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 512 512"
      className={cn("size-8 shrink-0", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
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

/** Name and tagline for the wordmark: "Godmode · Cloud" by default, "<appName> · Godmode Cloud" once renamed. */
export function brandParts(appName?: string | null): { name: string; tagline: string } {
  const name = appName?.trim();
  if (!name || name === DEFAULT_APP_NAME) return { name: "Godmode", tagline: "Cloud" };
  return { name, tagline: DEFAULT_APP_NAME };
}

/** Logo plus the cloud's name, as in the desktop sidebar. `compact` hides the text (the icon rail). */
export function Brand({ appName, className, compact = false }: { appName?: string | null; className?: string; compact?: boolean }) {
  const { name, tagline } = brandParts(appName);
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <Logo className="size-7" />
      {!compact && (
        <div className="min-w-0 leading-none">
          <div className="truncate text-[15px] font-medium tracking-[-0.02em]">{name}</div>
          <div className="mt-1 truncate text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase">{tagline}</div>
        </div>
      )}
    </div>
  );
}

/**
 * Quiet paper backdrop for full-screen pages: dashed guide rails and a halftone dot field that fades out.
 * No colour, no gradients.
 */
export function Backdrop({ className, rails = true }: { className?: string; rails?: boolean }) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      <div className="absolute inset-x-0 top-0 h-[420px] bg-dots [mask-image:radial-gradient(ellipse_60%_70%_at_50%_0%,black_10%,transparent_75%)] opacity-70" />
      {rails && <div className="guide-rails absolute inset-y-0 left-1/2 w-[min(100%-2rem,56rem)] -translate-x-1/2" />}
    </div>
  );
}
