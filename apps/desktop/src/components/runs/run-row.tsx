import { useEffect, useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import type { Agent, Run } from "@godmode/shared";
import { useLive } from "@/stores/live";
import { AgentAvatar } from "@/components/common";
import { cn } from "@/lib/utils";
import { formatCost, formatDuration, formatElapsed, RunStatusIcon, TriggerBadge } from "./run-status";

/** Re-render every `interval` ms while `active`; returns Date.now(). */
export function useNow(active: boolean, interval = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [active, interval]);
  return now;
}

/** Live-aware status + elapsed time of a run. */
export function useRunLiveState(run: Run) {
  const live = useLive((s) => s.runs[run.id] ?? null);
  const status = live ? "running" : run.status;
  const running = status === "running";
  const now = useNow(running);
  const startedMs = run.startedAt ? new Date(run.startedAt).getTime() : live?.startedAt;
  const elapsed = running && startedMs ? now - startedMs : null;
  return { live, status, running, elapsed } as const;
}

/** Compact, clickable run line used in Activity and agent overviews. */
export function RunRow({
  run,
  agent,
  showAgent = true,
  selected,
  onSelect,
  className,
}: {
  run: Run;
  agent?: Agent;
  showAgent?: boolean;
  selected?: boolean;
  onSelect?: (run: Run) => void;
  className?: string;
}) {
  const { live, status, running, elapsed } = useRunLiveState(run);
  const when = run.startedAt ?? run.createdAt;
  const snippet = (run.prompt || "").replace(/\s+/g, " ").trim() || "(no prompt)";

  return (
    <button
      type="button"
      onClick={() => onSelect?.(run)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition",
        "hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        selected && "bg-accent/60",
        running && "bg-primary/5",
        className,
      )}
    >
      <RunStatusIcon status={status} />
      {showAgent && agent && <AgentAvatar agent={agent} size="sm" />}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {showAgent && <span className="truncate text-sm font-medium">{agent?.name ?? "Unknown agent"}</span>}
          <TriggerBadge trigger={run.trigger} />
        </div>
        <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
          {running && live?.activity ? <span className="text-shimmer font-medium">{live.activity}</span> : snippet}
        </p>
      </div>
      <div className="hidden shrink-0 items-center gap-4 text-xs text-muted-foreground tabular-nums md:flex">
        <span className="w-16 text-right" title="Duration">
          {elapsed != null ? <span className="text-primary">{formatElapsed(elapsed)}</span> : formatDuration(run.durationMs)}
        </span>
        <span className="w-14 text-right" title="Cost">
          {formatCost(run.costUsd)}
        </span>
      </div>
      <span className="w-20 shrink-0 text-right text-xs text-muted-foreground" title={new Date(when).toLocaleString()}>
        {formatDistanceToNowStrict(new Date(when), { addSuffix: true })}
      </span>
    </button>
  );
}
