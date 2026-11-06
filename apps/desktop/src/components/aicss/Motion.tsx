import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import styles from "./Motion.module.css";

/**
 * Tick bars — a row of hairline ticks that rise and settle like a quiet equaliser.
 * Used as the "agent is working" signature next to live runs.
 */
const STILL_HEIGHTS = [0.35, 0.6, 0.9, 0.55, 0.3, 0.7, 1, 0.5, 0.4];

export function WorkingTicks({ count = 14, still = false, className, style }: { count?: number; still?: boolean; className?: string; style?: CSSProperties }) {
  return (
    <span aria-hidden className={cn(styles.ticks, className)} style={style}>
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          style={still ? { animation: "none", transform: `scaleY(${STILL_HEIGHTS[i % STILL_HEIGHTS.length]})`, opacity: 0.7 } : { animationDelay: `${(i * 97) % 1100}ms` }}
        />
      ))}
    </span>
  );
}

/** Status dot with a soft outward pulse while live. */
export function LiveDot({ live = true, className }: { live?: boolean; className?: string }) {
  return <span aria-hidden className={cn(styles.dot, live && styles.dotLive, className)} />;
}

export function DrawCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn(styles.check, className)} aria-hidden>
      <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
