import type { RunStatus, RunTrigger } from "@godmode/shared";
import { MODEL_OPTIONS } from "@godmode/shared";
import { Ban, CalendarClock, CheckCircle2, Clock3, Hand, Loader2, MessageSquare, Plug, Share2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/** "850ms", "12s", "3m 04s", "1h 12m" */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Live timer format: 0:07, 1:23, 1:02:03 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  if (usd < 10) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "Opus 5.5" for known ids, the raw id otherwise. */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return "Default";
  return MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id;
}

const STATUS_META: Record<RunStatus, { label: string; className: string; dot: string }> = {
  queued: { label: "Queued", className: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/60" },
  running: { label: "Running", className: "bg-primary/12 text-primary", dot: "bg-primary animate-pulse" },
  succeeded: { label: "Succeeded", className: "bg-success/12 text-success", dot: "bg-success" },
  failed: { label: "Failed", className: "bg-destructive/12 text-destructive", dot: "bg-destructive" },
  cancelled: { label: "Cancelled", className: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/60" },
};

export function runStatusLabel(status: RunStatus): string {
  return STATUS_META[status]?.label ?? status;
}

/** Compact pill: coloured dot + label. */
export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.queued;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium", meta.className, className)}>
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}

/** Icon-only status (running spins). */
export function RunStatusIcon({ status, className }: { status: RunStatus; className?: string }) {
  const cls = cn("size-4 shrink-0", className);
  switch (status) {
    case "running":
      return <Loader2 className={cn(cls, "animate-spin text-primary")} aria-label="Running" />;
    case "queued":
      return <Clock3 className={cn(cls, "text-muted-foreground")} aria-label="Queued" />;
    case "succeeded":
      return <CheckCircle2 className={cn(cls, "text-success")} aria-label="Succeeded" />;
    case "failed":
      return <XCircle className={cn(cls, "text-destructive")} aria-label="Failed" />;
    case "cancelled":
      return <Ban className={cn(cls, "text-muted-foreground")} aria-label="Cancelled" />;
  }
}

const TRIGGER_META: Record<RunTrigger, { label: string; icon: typeof MessageSquare }> = {
  chat: { label: "Chat", icon: MessageSquare },
  routine: { label: "Routine", icon: CalendarClock },
  delegation: { label: "Delegation", icon: Share2 },
  manual: { label: "Manual", icon: Hand },
  api: { label: "API", icon: Plug },
};

export function TriggerBadge({ trigger, className }: { trigger: RunTrigger; className?: string }) {
  const meta = TRIGGER_META[trigger] ?? TRIGGER_META.manual;
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border bg-background/40 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-3" />
      {meta.label}
    </span>
  );
}
