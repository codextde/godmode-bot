import { useId, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { formatBytes, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Status                                                               */
/* ------------------------------------------------------------------ */

export type Status = "online" | "offline" | "ok" | "warn" | "error" | "idle";

const DOT: Record<Status, string> = {
  online: "bg-brand",
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
  offline: "bg-muted-foreground/45",
  idle: "bg-muted-foreground/45",
};

/**
 * A small status dot. Brand green is reserved for live states (`online`), which pulse unless `pulse={false}`.
 * Give it a `label` when no text next to it says the same.
 */
export function StatusDot({
  status,
  pulse,
  label,
  className,
}: {
  status: Status;
  pulse?: boolean;
  label?: string;
  className?: string;
}) {
  const live = pulse ?? status === "online";
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        DOT[status],
        live && (status === "online" ? "animate-live-dot" : "animate-pulse"),
        className,
      )}
    />
  );
}

export type BadgeTone = "positive" | "neutral" | "info" | "warning" | "danger";

const BADGE: Record<BadgeTone, { cls: string; dot: string }> = {
  positive: { cls: "border-brand/25 bg-brand-soft text-brand-strong", dot: "bg-brand" },
  neutral: { cls: "border-border text-muted-foreground", dot: "bg-muted-foreground/60" },
  info: { cls: "border-border bg-paper-2 text-foreground", dot: "bg-foreground/70" },
  warning: { cls: "border-warning/30 bg-warning/[0.08] text-warning", dot: "bg-warning" },
  danger: { cls: "border-destructive/25 bg-destructive/[0.06] text-destructive", dot: "bg-destructive" },
};

/** The house status badge ("Active", "Online", "Suspended", "Past due"). `live` pulses the dot (positive only). */
export function StatusBadge({
  tone = "neutral",
  children,
  dot = true,
  live = false,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  dot?: boolean;
  live?: boolean;
  className?: string;
}) {
  const t = BADGE[tone];
  return (
    <span
      data-slot="badge"
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        t.cls,
        className,
      )}
    >
      {dot && <span aria-hidden className={cn("size-1.5 rounded-full", t.dot, live && tone === "positive" && "animate-live-dot")} />}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Figures                                                              */
/* ------------------------------------------------------------------ */

/**
 * A single headline number. `delta` compares with a named period ("+12% vs last month"); `good` says whether its
 * direction is good news (colour follows that, never the sign alone). `mono` for amounts and ids (house rule 3).
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  delta,
  href,
  mono = false,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  delta?: { value: string; direction: "up" | "down" | "flat"; good?: boolean };
  href?: string;
  mono?: boolean;
  className?: string;
}) {
  const DeltaIcon = delta?.direction === "up" ? ArrowUpRight : delta?.direction === "down" ? ArrowDownRight : ArrowRight;
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">{label}</p>
        {icon && (
          <span aria-hidden className="text-muted-foreground [&_svg]:size-4">
            {icon}
          </span>
        )}
      </div>
      <p className={cn("mt-2 text-[26px] leading-none font-medium tracking-[-0.03em] break-words", mono && "font-mono text-[22px] tracking-[-0.02em] tabular-nums")}>
        {value}
      </p>
      {(delta || hint) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {delta && (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 font-medium tabular-nums",
                delta.good === true && "text-success",
                delta.good === false && "text-destructive",
              )}
            >
              <DeltaIcon aria-hidden className="size-3.5" />
              {delta.value}
            </span>
          )}
          {hint && <span className="min-w-0">{hint}</span>}
        </div>
      )}
    </>
  );
  const cls = cn("animate-enter block rounded-xl border bg-card p-4 shadow-card @2xl:p-5", className);
  if (href) {
    return (
      <Link
        href={href}
        className={cn(cls, "outline-none transition-colors hover:border-foreground/15 focus-visible:ring-[3px] focus-visible:ring-ring/50")}
      >
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}

/** A responsive row of StatCards: two columns, four from `@4xl`. */
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-1 gap-3 @md:grid-cols-2 @4xl:grid-cols-4", className)}>{children}</div>;
}

/**
 * A usage bar. Anthracite while there is room, warning from 90 %, danger at the limit. `max = null` means unlimited.
 * `format` chooses how the default "x of y" label prints values.
 */
export function Meter({
  label,
  value,
  max,
  format = "number",
  valueLabel,
  hint,
  className,
}: {
  label: ReactNode;
  value: number;
  max: number | null;
  format?: "number" | "bytes";
  /** Replaces the default "1.2 GB of 10 GB". */
  valueLabel?: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const fmt = (n: number) => (format === "bytes" ? formatBytes(n) : formatNumber(n));
  const unlimited = max === null;
  const ratio = unlimited || max <= 0 ? 0 : Math.min(value / max, 1);
  const text = valueLabel ?? (unlimited ? `${fmt(value)} · Unlimited` : `${fmt(value)} of ${fmt(max)}`);
  const valueText = unlimited ? `${fmt(value)}, unlimited` : `${fmt(value)} of ${fmt(max)}`;
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-sm">
        <span id={`${id}-label`} className="font-medium">
          {label}
        </span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{text}</span>
      </div>
      <div
        role="meter"
        aria-labelledby={`${id}-label`}
        aria-valuemin={0}
        aria-valuemax={unlimited ? undefined : max}
        aria-valuenow={value}
        aria-valuetext={valueText}
        className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]"
      >
        {!unlimited && (
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              ratio >= 1 ? "bg-destructive" : ratio >= 0.9 ? "bg-warning" : "bg-foreground",
            )}
            style={{ width: `${Math.max(ratio * 100, value > 0 ? 2 : 0)}%` }}
          />
        )}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
