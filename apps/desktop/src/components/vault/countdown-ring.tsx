import { cn } from "@/lib/utils";

/**
 * Circular countdown. `progress` 0..1 = fraction of the period remaining.
 * Driven by a local clock (see useNow) so it animates smoothly between server polls.
 */
export function CountdownRing({
  progress,
  seconds,
  size = 36,
  stroke = 3.5,
  className,
}: {
  progress: number;
  seconds: number;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, progress));
  const urgent = seconds <= 5;
  const soon = seconds <= 10;
  return (
    <div className={cn("relative grid shrink-0 place-items-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-foreground/[0.08]" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p)}
          className={cn("transition-[stroke] duration-500", urgent ? "stroke-destructive" : soon ? "stroke-warning" : "stroke-brand")}
        />
      </svg>
      <span className={cn("absolute font-mono text-[11px] font-medium tabular-nums", urgent ? "text-destructive" : soon ? "text-warning" : "text-muted-foreground")}>
        {Math.max(0, Math.ceil(seconds))}
      </span>
    </div>
  );
}
