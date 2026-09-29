import type { Agent, TaskStatus, TaskType } from "@godmode/shared";
import { TASK_TYPES } from "@godmode/shared";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { BOARD_COLUMNS, STATUS_META, StatusIcon, TYPE_META, TypeIcon } from "./task-meta";

const NONE = "__none";

/** Agents that may work on a task of this workspace: its own and global ones (enabled, or the current pick). */
export function agentsInReach(agents: Agent[], workspaceId: string | null, current?: string | null): Agent[] {
  return agents.filter((a) => (a.workspaceId === null || a.workspaceId === workspaceId) && (a.enabled || a.id === current));
}

export function AgentSelect({
  id,
  agents,
  value,
  onChange,
  className,
}: {
  id?: string;
  agents: Agent[];
  value: string | null;
  onChange: (agentId: string | null) => void;
  className?: string;
}) {
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger id={id} className={cn("w-full", className)}>
        <SelectValue placeholder="Unassigned" />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectItem value={NONE}>
          <span className="size-4 rounded-[4px] border border-dashed border-muted-foreground/50" /> Unassigned
        </SelectItem>
        {agents.length > 0 && <SelectSeparator />}
        {agents.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            <span>{a.avatar}</span> {a.name}
            {!a.workspaceId && !a.isDefault && <span className="text-xs text-muted-foreground">· global</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function StatusSelect({ value, onChange, className }: { value: TaskStatus; onChange: (s: TaskStatus) => void; className?: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TaskStatus)}>
      <SelectTrigger className={cn("w-full", className)} aria-label="Status">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {BOARD_COLUMNS.map((s) => (
          <SelectItem key={s} value={s}>
            <StatusIcon status={s} /> {STATUS_META[s].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Three tiles: what kind of work it is decides what Godmode prepares and delivers. */
export function TypePicker({ value, onChange }: { value: TaskType; onChange: (t: TaskType) => void }) {
  return (
    <div role="radiogroup" aria-label="Type" className="grid grid-cols-3 gap-2">
      {TASK_TYPES.map((t) => {
        const selected = value === t;
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(t)}
            className={cn(
              "flex flex-col items-start gap-1 rounded-lg border bg-card p-2.5 text-left transition outline-none hover:border-foreground/25 focus-visible:ring-[3px] focus-visible:ring-ring/50",
              selected && "border-foreground/60 ring-1 ring-foreground/60",
            )}
          >
            <span className="flex items-center gap-1.5 text-[13px] font-medium">
              <TypeIcon type={t} className={cn("text-muted-foreground", selected && "text-foreground")} />
              {TYPE_META[t].label}
            </span>
            <span className="text-[11.5px] leading-snug text-muted-foreground">{TYPE_META[t].hint}</span>
          </button>
        );
      })}
    </div>
  );
}
