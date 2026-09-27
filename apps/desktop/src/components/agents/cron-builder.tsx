import { useMemo, useState } from "react";
import { CalendarClock, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  buildCron,
  CRON_KIND_LABELS,
  cronToHuman,
  ordinal,
  parseCron,
  validateCron,
  WEEKDAYS,
  type CronDraft,
  type CronKind,
} from "./cron";

const KINDS: CronKind[] = ["hourly", "daily", "weekdays", "weekly", "monthly", "custom"];
// Monday-first order reads more naturally in a picker
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const CUSTOM_EXAMPLES = [
  { cron: "*/15 * * * *", label: "every 15 min" },
  { cron: "0 */2 * * *", label: "every 2 hours" },
  { cron: "0 9,17 * * 1-5", label: "9:00 & 17:00 weekdays" },
  { cron: "0 8 1,15 * *", label: "1st & 15th" },
];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/**
 * Friendly schedule editor. Emits a cron expression via `onChange`.
 * Mount with a `key` when the underlying routine changes so the draft re-initialises.
 */
export function CronBuilder({ value, onChange, idPrefix = "cron" }: { value: string; onChange: (cron: string) => void; idPrefix?: string }) {
  const [draft, setDraft] = useState<CronDraft>(() => parseCron(value));
  const cron = buildCron(draft);
  const error = useMemo(() => validateCron(cron), [cron]);

  const update = (patch: Partial<CronDraft>) => {
    const next = { ...draft, ...patch };
    // Carry the current expression into the custom editor when switching to it
    if (patch.kind === "custom" && draft.kind !== "custom") next.custom = buildCron(draft);
    setDraft(next);
    onChange(buildCron(next));
  };

  const time = `${pad(draft.hour)}:${pad(draft.minute)}`;
  const onTime = (v: string) => {
    const [h, m] = v.split(":").map(Number);
    if (Number.isFinite(h) && Number.isFinite(m)) update({ hour: h, minute: m });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-kind`} className="text-xs text-muted-foreground">
            Repeat
          </Label>
          <Select value={draft.kind} onValueChange={(v) => update({ kind: v as CronKind })}>
            <SelectTrigger id={`${idPrefix}-kind`} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {CRON_KIND_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {draft.kind === "hourly" && (
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-minute`} className="text-xs text-muted-foreground">
              At minute
            </Label>
            <Input
              id={`${idPrefix}-minute`}
              type="number"
              min={0}
              max={59}
              value={draft.minute}
              onChange={(e) => update({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })}
              className="w-24"
            />
          </div>
        )}

        {draft.kind === "monthly" && (
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-dom`} className="text-xs text-muted-foreground">
              On day
            </Label>
            <Select value={String(draft.monthDay)} onValueChange={(v) => update({ monthDay: Number(v) })}>
              <SelectTrigger id={`${idPrefix}-dom`} className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" className="max-h-64">
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {ordinal(d)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {(draft.kind === "daily" || draft.kind === "weekdays" || draft.kind === "weekly" || draft.kind === "monthly") && (
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-time`} className="text-xs text-muted-foreground">
              At
            </Label>
            <Input id={`${idPrefix}-time`} type="time" value={time} onChange={(e) => onTime(e.target.value)} className="w-32" />
          </div>
        )}
      </div>

      {draft.kind === "weekly" && (
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">On</span>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={String(draft.weekday)}
            onValueChange={(v) => v && update({ weekday: Number(v) })}
            aria-label="Day of week"
            className="flex-wrap"
          >
            {WEEK_ORDER.map((d) => (
              <ToggleGroupItem key={d} value={String(d)} aria-label={WEEKDAYS[d]} className="px-2.5 data-[state=on]:bg-primary/15 data-[state=on]:text-primary">
                {WEEKDAYS[d].slice(0, 3)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      )}

      {draft.kind === "custom" && (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-custom`} className="text-xs text-muted-foreground">
            Cron expression <span className="font-normal">(minute hour day month weekday)</span>
          </Label>
          <Input
            id={`${idPrefix}-custom`}
            value={draft.custom}
            onChange={(e) => update({ custom: e.target.value })}
            placeholder="0 9 * * 1-5"
            spellCheck={false}
            aria-invalid={!!error}
            className="font-mono"
          />
          <div className="flex flex-wrap gap-1.5">
            {CUSTOM_EXAMPLES.map((ex) => (
              <button
                key={ex.cron}
                type="button"
                onClick={() => update({ custom: ex.cron })}
                className="rounded-md border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span className="font-mono">{ex.cron}</span> · {ex.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        className={cn(
          "flex items-center gap-2 rounded-xl border px-3 py-2 text-sm",
          error ? "border-destructive/40 bg-destructive/5 text-destructive" : "bg-primary/5 text-foreground",
        )}
        role="status"
        aria-live="polite"
      >
        {error ? <TriangleAlert className="size-4 shrink-0" /> : <CalendarClock className="size-4 shrink-0 text-primary" />}
        <span className="min-w-0 flex-1 truncate">{error ?? cronToHuman(cron)}</span>
        {!error && <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{cron}</code>}
      </div>
    </div>
  );
}
