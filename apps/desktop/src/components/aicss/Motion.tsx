import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import styles from "./Motion.module.css";

/**
 * Tick bars — a row of hairline ticks that rise and settle like a quiet equaliser.
 * Used as the "agent is working" signature next to live runs.
 */
export function WorkingTicks({ count = 14, className, style }: { count?: number; className?: string; style?: CSSProperties }) {
  return (
    <span aria-hidden className={cn(styles.ticks, className)} style={style}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} style={{ animationDelay: `${(i * 97) % 1100}ms` }} />
      ))}
    </span>
  );
}

/** Status dot with a soft outward pulse while live. */
export function LiveDot({ live = true, className }: { live?: boolean; className?: string }) {
  return <span aria-hidden className={cn(styles.dot, live && styles.dotLive, className)} />;
}

/**
 * Animated check — the stroke draws itself in when a step completes.
 */
export function DrawCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn(styles.check, className)} aria-hidden>
      <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
