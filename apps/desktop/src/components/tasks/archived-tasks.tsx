import { useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { differenceInCalendarDays, format, formatDistanceToNowStrict, isToday, isYesterday } from "date-fns";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import type { Agent, Task, Workspace } from "@godmode/shared";
import { AgentAvatar, EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { STATUS_META, StatusIcon, TypeIcon } from "./task-meta";

function bucket(d: Date, now: Date): string {
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  const days = differenceInCalendarDays(now, d);
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return format(d, d.getFullYear() === now.getFullYear() ? "MMMM" : "MMMM yyyy");
}

export function ArchivedTasks({
  tasks,
  agents,
  workspaces,
  filtered,
  onClearFilters,
  onOpen,
  onRestore,
  onDelete,
}: {
  /** Latest archived first. */
  tasks: Task[];
  agents: Map<string, Agent>;
  /** Given when the list spans several workspaces: rows show theirs. */
  workspaces?: Map<string, Workspace>;
  filtered: boolean;
  onClearFilters: () => void;
  onOpen: (task: Task) => void;
  onRestore: (task: Task) => void;
  onDelete: (task: Task) => void;
}) {
  const groups = useMemo(() => {
    const now = new Date();
    const out: { label: string; items: Task[] }[] = [];
    for (const t of tasks) {
      const label = bucket(new Date(t.archivedAt ?? t.updatedAt), now);
      const last = out.at(-1);
      if (last?.label === label) last.items.push(t);
      else out.push({ label, items: [t] });
    }
    return out;
  }, [tasks]);

  if (!tasks.length) {
    return (
      <div className="px-5 @2xl:px-8">
        <EmptyState
          icon={<Archive />}
          title={filtered ? "No archived tasks match" : "Nothing archived yet"}
          description={
            filtered
              ? "Try another filter."
              : "Archive finished work to keep the board focused: right-click a card, or clear a whole Done column from its header. Archived tasks keep everything and come back in one click."
          }
          action={
            filtered ? (
              <Button variant="outline" onClick={onClearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
          className="max-w-4xl"
        />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-5 pb-10 @2xl:px-8">
      <div className="max-w-4xl space-y-6">
        {groups.map((g) => (
          <section key={g.label}>
            <h2 className="eyebrow mb-2 px-1">{g.label}</h2>
            <div className="space-y-0.5 rounded-xl border bg-card p-1.5 shadow-card">
              <AnimatePresence initial={false}>
                {g.items.map((t) => (
                  <ArchivedRow
                    key={t.id}
                    task={t}
                    agent={t.agentId ? agents.get(t.agentId) : undefined}
                    workspace={workspaces ? (t.workspaceId ? (workspaces.get(t.workspaceId) ?? null) : null) : undefined}
                    onOpen={() => onOpen(t)}
                    onRestore={() => onRestore(t)}
                    onDelete={() => onDelete(t)}
                  />
                ))}
              </AnimatePresence>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ArchivedRow({
  task,
  agent,
  workspace,
  onOpen,
  onRestore,
  onDelete,
}: {
  task: Task;
  agent?: Agent;
  workspace?: Workspace | null;
  onOpen: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const when = new Date(task.archivedAt ?? task.updatedAt);
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, height: 0, transition: { duration: 0.18 } }}
      className="group relative overflow-hidden rounded-lg"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition group-hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <StatusIcon status={task.status} className="size-4" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">#{task.number}</span>
            <span className="truncate text-sm font-medium tracking-[-0.01em]">{task.title}</span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <TypeIcon type={task.type} className="size-3" />
            <span className="shrink-0">{STATUS_META[task.status].label}</span>
            {workspace !== undefined && (
              <span className="truncate">
                · {workspace?.icon ?? "🌐"} {workspace?.name ?? "Global"}
              </span>
            )}
          </span>
        </span>
        {agent ? (
          <span className="flex max-w-40 shrink-0 items-center gap-1.5 text-xs text-foreground/75 transition-opacity group-focus-within:opacity-0 group-hover:opacity-0">
            <AgentAvatar agent={agent} size="sm" still className="size-5 rounded-[5px] text-[11px]" />
            <span className="truncate">{agent.name}</span>
          </span>
        ) : null}
        <span
          className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
          title={`Archived ${when.toLocaleString()}`}
        >
          {formatDistanceToNowStrict(when, { addSuffix: true })}
        </span>
      </button>
      <div className="absolute inset-y-0 right-2 flex items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <Button size="xs" variant="outline" className="bg-card" onClick={onRestore}>
          <ArchiveRestore /> Restore
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label={`Delete #${task.number}`} onClick={onDelete} className="text-muted-foreground hover:text-destructive">
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Delete forever</TooltipContent>
        </Tooltip>
      </div>
    </motion.div>
  );
}
