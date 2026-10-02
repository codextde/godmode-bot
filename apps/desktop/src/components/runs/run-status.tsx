import type { RunStatus, RunTrigger } from "@godmode/shared";
import { findModel } from "@godmode/shared";
import { AlarmClock, Ban, CheckCircle2, CirclePause, Clock3, Hand, MessageSquare, Moon, Plug, Radar, Share2, SquareKanban, Workflow, XCircle } from "lucide-react";
import { Orb } from "@/components/aicss/Orb";
import { useModelCatalog } from "@/lib/hooks";
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

/** Label lookup: "Opus 5.5" for model ids and aliases Claude Code knows, the raw id otherwise. */
export function useModelLabel(): (id: string | null | undefined) => string {
  const { catalog } = useModelCatalog();
  return (id) => (id ? (findModel(catalog.models, id)?.label ?? id) : "Default");
}

const STATUS_META: Record<RunStatus, { label: string; className: string; dot: string }> = {
  queued: { label: "Queued", className: "border-border bg-secondary text-muted-foreground", dot: "bg-muted-foreground/60" },
  running: { label: "Running", className: "border-brand/25 bg-brand-soft text-brand-strong", dot: "bg-brand animate-live-dot" },
  paused: { label: "Paused", className: "border-warning/30 bg-warning/[0.07] text-warning", dot: "bg-warning" },
  succeeded: { label: "Succeeded", className: "border-success/20 bg-success/[0.08] text-success", dot: "bg-success" },
  failed: { label: "Failed", className: "border-destructive/20 bg-destructive/[0.06] text-destructive", dot: "bg-destructive" },
  cancelled: { label: "Cancelled", className: "border-border bg-secondary text-muted-foreground", dot: "bg-muted-foreground/60" },
};

export function runStatusLabel(status: RunStatus): string {
  return STATUS_META[status]?.label ?? status;
}

/** Compact pill: coloured dot + label. */
export function RunStatusBadge({ status, className }: { status: RunStatus; className?: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.queued;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-[5px] border px-2 py-0.5 text-[11px] font-medium", meta.className, className)}>
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}

/** Icon-only status (running shows the working orb). */
export function RunStatusIcon({ status, className }: { status: RunStatus; className?: string }) {
  const cls = cn("size-4 shrink-0", className);
  switch (status) {
    case "running":
      return (
        <span className={cn(cls, "grid place-items-center")}>
          <Orb variant="S3" size={16} label="Running" />
        </span>
      );
    case "queued":
      return <Clock3 className={cn(cls, "text-muted-foreground")} aria-label="Queued" />;
    case "paused":
      return <CirclePause className={cn(cls, "text-warning")} aria-label="Paused" />;
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
  routine: { label: "Automation", icon: Workflow },
  check: { label: "Condition check", icon: Radar },
  dream: { label: "Dream", icon: Moon },
  delegation: { label: "Delegation", icon: Share2 },
  manual: { label: "Manual", icon: Hand },
  api: { label: "API", icon: Plug },
  task: { label: "Task", icon: SquareKanban },
  followup: { label: "Follow-up", icon: AlarmClock },
};

export function TriggerBadge({ trigger, className }: { trigger: RunTrigger; className?: string }) {
  const meta = TRIGGER_META[trigger] ?? TRIGGER_META.manual;
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[5px] border bg-card px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-3" />
      {meta.label}
    </span>
  );
}
