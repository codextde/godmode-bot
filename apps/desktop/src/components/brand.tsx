import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/** The Godmode mark: the mascot's face on a blue tile. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={cn("size-8 shrink-0", className)} aria-hidden>
      <rect x="16" y="16" width="480" height="480" rx="112" fill="#2453D6" />
      <ellipse cx="152" cy="214" rx="40" ry="48" fill="#FFFFFF" />
      <ellipse cx="360" cy="214" rx="40" ry="48" fill="#FFFFFF" />
      <path d="M204 306Q256 358 308 306" stroke="#FFFFFF" strokeWidth="30" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  const { t } = useTranslation("layout");
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <Logo className="size-7" />
      <div className="leading-none">
        <div className="text-[15px] font-medium tracking-[-0.02em]">Godmode</div>
        <div className="mt-1 text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase">{t("brand.tagline")}</div>
      </div>
    </div>
  );
}

/**
 * Quiet paper backdrop for hero areas: dashed guide rails and a halftone dot field that fades out.
 * (Replaces the old aurora glow — no colour, no gradients.)
 */
export function Backdrop({ className, rails = true }: { className?: string; rails?: boolean }) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      <div className="absolute inset-x-0 top-0 h-[420px] bg-dots [mask-image:radial-gradient(ellipse_60%_70%_at_50%_0%,#000_10%,transparent_75%)] opacity-70" />
      {rails && <div className="guide-rails absolute inset-y-0 left-1/2 w-[min(100%-2rem,56rem)] -translate-x-1/2" />}
    </div>
  );
}
