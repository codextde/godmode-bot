import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Brain, Clock3, NotebookText, Trash2 } from "lucide-react";
import type { Agent, AgentFilesOverview } from "@godmode/shared";
import { formatBytes, memoryBudget } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useBootstrap } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { plural } from "./use-files";

export function useFilesOverview() {
  return useQuery({ queryKey: qk.filesOverview, queryFn: () => api.files.overview(), staleTime: 60_000 });
}

function compactChars(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

/** Every agent's files at a glance, the largest first: where tidying pays off. */
export function FilesOverview({ agents }: { agents: Agent[] }) {
  const overview = useFilesOverview();
  const boot = useBootstrap();
  const budget = memoryBudget(boot.data?.settings.memory.dreaming.maxMemoryChars);
  const [sort, setSort] = useState<"size" | "name">("size");
  const rows = useMemo(() => {
    const by = new Map((overview.data ?? []).map((r) => [r.agentId, r]));
    const list = agents.map((a) => ({ agent: a, row: by.get(a.id) ?? null }));
    return sort === "size" ? list.sort((a, b) => (b.row?.bytes ?? 0) - (a.row?.bytes ?? 0)) : list.sort((a, b) => a.agent.name.localeCompare(b.agent.name));
  }, [agents, overview.data, sort]);
  const largest = Math.max(1, ...rows.map((r) => r.row?.bytes ?? 0));
  const total = rows.reduce((n, r) => n + (r.row?.bytes ?? 0), 0);
  const scratch = rows.reduce((n, r) => n + (r.row?.scratchBytes ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[13px] text-muted-foreground">
            {overview.data ? (
              <>
                <span className="font-medium text-foreground tabular-nums">{formatBytes(total)}</span> across {plural(rows.length, "agent")}
                {scratch > 0 && <> · {formatBytes(scratch)} of it scratch in tmp/, which goes by itself</>}
              </>
            ) : (
              "Counting what every agent keeps…"
            )}
          </p>
        </div>
        <ToggleGroup type="single" size="sm" variant="outline" value={sort} onValueChange={(v) => v && setSort(v as "size" | "name")} aria-label="Sort agents">
          <ToggleGroupItem value="size" className="px-2.5 text-xs">
            Largest first
          </ToggleGroupItem>
          <ToggleGroupItem value="name" className="px-2.5 text-xs">
            A–Z
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {overview.isError && <p className="text-sm text-destructive">{errorMessage(overview.error)}</p>}
      <ul className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
        {rows.map(({ agent, row }) => (
          <li key={agent.id}>
            <AgentCard agent={agent} row={row} largest={largest} memoryLimit={budget.target} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentCard({ agent, row, largest, memoryLimit }: { agent: Agent; row: AgentFilesOverview | null; largest: number; memoryLimit: number }) {
  const over = row ? row.memoryChars > memoryLimit : false;
  return (
    <Link
      to={`/files/${agent.id}`}
      className="group/card block rounded-xl border bg-card p-4 shadow-card transition hover:border-foreground/15 hover:shadow-float focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agent} size="md" still />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium tracking-[-0.01em]">{agent.name}</p>
          <p className="truncate text-xs text-muted-foreground">{agent.role || "Agent"}</p>
        </div>
        <ArrowUpRight className="size-4 text-muted-foreground/0 transition group-hover/card:text-muted-foreground" />
      </div>
      <div className="mt-4">
        {row ? (
          <>
            <p className="text-[22px] leading-none font-medium tracking-[-0.03em] tabular-nums">
              {row.partial && <span className="text-base text-muted-foreground">≥ </span>}
              {formatBytes(row.bytes)}
            </p>
            <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-foreground/[0.06]">
              <div className="flex h-full" style={{ width: `${Math.max(1.5, (row.bytes / largest) * 100)}%` }}>
                <span className="h-full bg-foreground/45" style={{ flexGrow: Math.max(row.bytes - row.scratchBytes, 0) }} />
                <span className="h-full bg-foreground/15" style={{ flexGrow: row.scratchBytes }} />
              </div>
            </div>
          </>
        ) : (
          <>
            <Skeleton className="h-6 w-24" />
            <Skeleton className="mt-2.5 h-1 w-full" />
          </>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {row && (
          <>
            <span className="inline-flex items-center gap-1">
              <NotebookText className="size-3" /> {plural(row.notes, "note")}
            </span>
            <span className={cn("inline-flex items-center gap-1", over && "text-warning")} title={`MEMORY.md: ${row.memoryChars.toLocaleString()} of ${memoryLimit.toLocaleString()} characters`}>
              <Brain className="size-3" /> {compactChars(row.memoryChars)} / {compactChars(memoryLimit)}
            </span>
            {row.scratchBytes > 0 && (
              <span className="inline-flex items-center gap-1" title="Scratch in workspace/tmp — goes by itself a week after its last change">
                <Clock3 className="size-3" /> tmp {formatBytes(row.scratchBytes)}
              </span>
            )}
            {row.deleted > 0 && (
              <span className="inline-flex items-center gap-1">
                <Trash2 className="size-3" /> {row.deleted} in bin
              </span>
            )}
          </>
        )}
      </div>
    </Link>
  );
}
