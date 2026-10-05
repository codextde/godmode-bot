import { useState } from "react";
import type { Agent, TaskPriority, TaskStatus, TaskType } from "@godmode/shared";
import { MAX_TASK_LABELS, TASK_PRIORITIES, TASK_TYPES, cleanTaskLabel, isOverdue, localDay } from "@godmode/shared";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AgentAvatar } from "@/components/common";
import { cn } from "@/lib/utils";
import { BOARD_COLUMNS, PRIORITY_META, PriorityIcon, STATUS_META, StatusIcon, TYPE_META, TypeIcon, daysUntil, dueLabel, labelTone } from "./task-meta";

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
            <AgentAvatar agent={a} size="sm" still className="size-4" /> {a.name}
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

export function PrioritySelect({ value, onChange, className }: { value: TaskPriority; onChange: (p: TaskPriority) => void; className?: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TaskPriority)}>
      <SelectTrigger className={cn("w-full", className)} aria-label="Priority">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {TASK_PRIORITIES.map((p) => (
          <SelectItem key={p} value={p}>
            <PriorityIcon priority={p} /> {PRIORITY_META[p].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A due day: the native date field, the day in words next to it, and a way to clear it. */
export function DueDateField({
  value,
  status,
  onChange,
  className,
}: {
  value: string | null;
  status: TaskStatus;
  onChange: (day: string | null) => void;
  className?: string;
}) {
  const overdue = !!value && isOverdue({ dueDate: value, status });
  const late = value ? -daysUntil(value) : 0;
  return (
    <span className={cn("flex h-8 min-w-0 items-center gap-1.5", className)}>
      <input
        type="date"
        value={value ?? ""}
        min={value && value < localDay() ? undefined : localDay()}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label="Due date"
        className={cn(
          "-ml-1.5 h-8 rounded-md border border-transparent bg-transparent px-1.5 text-[13px] [color-scheme:light] hover:bg-accent/60 dark:[color-scheme:dark] focus-visible:border-ring focus-visible:outline-none [&::-webkit-calendar-picker-indicator]:opacity-60",
          value ? (overdue ? "text-rose-600 dark:text-rose-400" : "text-foreground") : "text-muted-foreground",
        )}
      />
      {value ? (
        <>
          <span className={cn("truncate text-xs", overdue ? "font-medium text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>
            {overdue ? `overdue by ${late} day${late === 1 ? "" : "s"}` : dueLabel(value)}
          </span>
          <Button size="icon-xs" variant="ghost" aria-label="Remove the due date" onClick={() => onChange(null)} className="text-muted-foreground">
            <X />
          </Button>
        </>
      ) : (
        <span className="text-xs text-muted-foreground">No due date</span>
      )}
    </span>
  );
}

export function LabelChip({ label, onRemove, className }: { label: string; onRemove?: () => void; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 max-w-40 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium", labelTone(label), className)}>
      <span className="truncate">{label}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove label ${label}`} className="-mr-0.5 rounded-sm opacity-70 hover:opacity-100">
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

/** Chips with a remove button and a field: Enter or a comma adds, Backspace on an empty field removes the last. */
export function LabelsInput({ value, onChange, suggestions = [] }: { value: string[]; onChange: (labels: string[]) => void; suggestions?: string[] }) {
  const [draft, setDraft] = useState("");
  const full = value.length >= MAX_TASK_LABELS;
  const add = (raw: string) => {
    const label = cleanTaskLabel(raw);
    setDraft("");
    if (!label || full || value.some((l) => l.toLowerCase() === label.toLowerCase())) return;
    onChange([...value, label]);
  };
  const listId = "task-label-suggestions";
  return (
    <span className="flex min-h-8 min-w-0 flex-wrap items-center gap-1 py-1">
      {value.map((l) => (
        <LabelChip key={l} label={l} onRemove={() => onChange(value.filter((x) => x !== l))} />
      ))}
      {full ? (
        <span className="text-xs text-muted-foreground">Up to {MAX_TASK_LABELS} labels</span>
      ) : (
        <>
          <input
            value={draft}
            list={listId}
            onChange={(e) => {
              const v = e.target.value;
              if (v.endsWith(",")) add(v.slice(0, -1));
              else setDraft(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add(draft);
              } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
            }}
            onBlur={() => draft.trim() && add(draft)}
            placeholder={value.length ? "" : "Add a label…"}
            aria-label="Add a label"
            className="h-6 min-w-24 flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-muted-foreground"
          />
          <datalist id={listId}>
            {suggestions
              .filter((s) => !value.some((l) => l.toLowerCase() === s.toLowerCase()))
              .map((s) => (
                <option key={s} value={s} />
              ))}
          </datalist>
        </>
      )}
    </span>
  );
}
