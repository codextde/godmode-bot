import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CalendarClock, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  buildCron,
  CRON_KIND_LABELS,
  formatTime,
  ordinal,
  parseCron,
  scheduleToHuman,
  SEVERAL_EVERY,
  SEVERAL_TIMES,
  severalProblem,
  severalSpan,
  severalStarts,
  severalWindow,
  validateCron,
  WEEKDAYS,
  type CronDraft,
  type CronKind,
  type SeveralMode,
} from "./cron";

const KINDS: CronKind[] = ["hourly", "several", "daily", "weekdays", "weekly", "monthly", "custom"];
// Monday-first order reads more naturally in a picker
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const CUSTOM_EXAMPLES = [
  { cron: "*/15 * * * *", label: "every 15 min" },
  { cron: "0 */2 * * *", label: "every 2 hours" },
  { cron: "0 9,17 * * 1-5", label: "9:00 & 17:00 weekdays" },
  { cron: "0 8 1,15 * *", label: "1st & 15th" },
];

const TOGGLE_ON = "data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

const DAY = 24 * 60;
const pct = (minutes: number) => `${(Math.min(Math.max(minutes, 0), DAY) / DAY) * 100}%`;

/** 24 h strip: the time range, and where the runs fall in it (random: one part per run, interval: a tick per run). */
function DayTimeline({ draft }: { draft: CronDraft }) {
  const starts = severalStarts(draft);
  if (!starts.length) return null;
  const from = draft.hour * 60 + draft.minute;
  const until = draft.untilHour * 60 + draft.untilMinute;
  const part = (until - from) / Math.max(1, draft.times);
  const random = draft.mode === "random";
  return (
    <div className="space-y-1" aria-hidden>
      <div className="relative h-7 rounded-md border bg-card">
        {[6, 12, 18].map((h) => (
          <div key={h} className="absolute inset-y-0 w-px bg-border/70" style={{ left: pct(h * 60) }} />
        ))}
        <div className="absolute inset-y-1 rounded-[5px] bg-primary/10" style={{ left: pct(from), width: `calc(${pct(until)} - ${pct(from)})` }} />
        {random
          ? starts.map((s, i) => (
              <div
                key={s}
                className="absolute inset-y-1.5 rounded-[4px] border border-primary/30 bg-primary/20"
                style={{ left: `calc(${pct(s)} + ${i ? 1 : 0}px)`, width: `calc(${pct(s + part)} - ${pct(s)} - ${i ? 1 : 0}px)` }}
              />
            ))
          : starts.map((s) => <div key={s} className="absolute inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-primary" style={{ left: pct(s) }} />)}
      </div>
      <div className="relative h-3.5 text-[10px] text-muted-foreground tabular-nums">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h} className={cn("absolute", h === 0 ? "left-0" : h === 24 ? "right-0" : "-translate-x-1/2")} style={h > 0 && h < 24 ? { left: pct(h * 60) } : undefined}>
            {formatTime(h % 24, 0)}
          </span>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {random
          ? `One run at a random moment in each of the ${draft.times} blocks — a new moment every day.`
          : `${starts.length} runs a day: ${starts
              .slice(0, 8)
              .map((s) => formatTime(Math.floor(s / 60), s % 60))
              .join(", ")}${starts.length > 8 ? ` and ${starts.length - 8} more` : ""}`}
      </p>
    </div>
  );
}

/**
 * Friendly schedule editor. Emits a cron expression via `onChange`.
 * Mount with a `key` when the underlying routine changes so the draft re-initialises.
 * `children` render above the summary, which includes `startWindowMinutes`; `problem` shows there like an invalid expression.
 * With `onWindowChange` it also offers random runs spread over a time range ("5 times a day at random times"): the
 * builder then owns the start window and the runs per window, and hides `children` while that mode is on.
 */
export function CronBuilder({
  value,
  onChange,
  idPrefix = "cron",
  startWindowMinutes = 0,
  runsPerWindow = 1,
  onWindowChange,
  onProblemChange,
  problem = null,
  children,
}: {
  value: string;
  onChange: (cron: string) => void;
  idPrefix?: string;
  startWindowMinutes?: number;
  runsPerWindow?: number;
  onWindowChange?: (window: { startWindowMinutes: number; runsPerWindow: number }) => void;
  /** Problems the cron can't show (an end before the start): the caller blocks saving while there is one. */
  onProblemChange?: (problem: string | null) => void;
  problem?: string | null;
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState<CronDraft>(() => parseCron(value, startWindowMinutes, runsPerWindow));
  const cron = buildCron(draft);
  const invalid = useMemo(() => validateCron(cron), [cron]);
  const error = invalid ?? severalProblem(draft) ?? problem;
  const randomRuns = draft.kind === "several" && draft.mode === "random";
  const draftProblem = severalProblem(draft);
  useEffect(() => onProblemChange?.(draftProblem), [draftProblem, onProblemChange]);

  const update = (patch: Partial<CronDraft>) => {
    const next = { ...draft, ...patch };
    if (!onWindowChange && next.kind === "several") next.mode = "interval";
    if (patch.kind === "several" && severalSpan(next) < 120) Object.assign(next, { hour: 9, minute: 0, untilHour: 21, untilMinute: 0 });
    // Carry the current expression into the custom editor when switching to it
    if (patch.kind === "custom" && draft.kind !== "custom") next.custom = buildCron(draft);
    setDraft(next);
    onChange(buildCron(next));
    const window = severalWindow(next);
    if (window) onWindowChange?.(window);
    else if (severalWindow(draft)) onWindowChange?.({ startWindowMinutes: 0, runsPerWindow: 1 });
  };

  const time = `${pad(draft.hour)}:${pad(draft.minute)}`;
  const onTime = (v: string) => {
    const [h, m] = v.split(":").map(Number);
    if (Number.isFinite(h) && Number.isFinite(m)) update({ hour: h, minute: m });
  };
  const onUntil = (v: string) => {
    const [h, m] = v.split(":").map(Number);
    if (Number.isFinite(h) && Number.isFinite(m)) update({ untilHour: h, untilMinute: m });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-3">
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

        {draft.kind === "several" && onWindowChange && (
          <div className="space-y-1.5">
            <Label id={`${idPrefix}-mode-label`} className="text-xs text-muted-foreground">
              Timing
            </Label>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={draft.mode}
              onValueChange={(v) => v && update({ mode: v as SeveralMode })}
              aria-labelledby={`${idPrefix}-mode-label`}
              className="h-9"
            >
              <ToggleGroupItem value="random" className={cn("h-9 px-3", TOGGLE_ON)}>
                Random times
              </ToggleGroupItem>
              <ToggleGroupItem value="interval" className={cn("h-9 px-3", TOGGLE_ON)}>
                Fixed interval
              </ToggleGroupItem>
            </ToggleGroup>
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

      {draft.kind === "several" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start gap-3">
            {randomRuns ? (
              <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-times`} className="text-xs text-muted-foreground">
                  Runs per day
                </Label>
                <Select value={String(draft.times)} onValueChange={(v) => v && update({ times: Number(v) })}>
                  <SelectTrigger id={`${idPrefix}-times`} className="w-28 tabular-nums">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {[...new Set([...SEVERAL_TIMES, draft.times])].sort((a, b) => a - b).map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n} times
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-every`} className="text-xs text-muted-foreground">
                  Every
                </Label>
                <Select value={String(draft.every)} onValueChange={(v) => v && update({ every: Number(v) })}>
                  <SelectTrigger id={`${idPrefix}-every`} className="w-28 tabular-nums">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {[...new Set([...SEVERAL_EVERY, draft.every])].sort((a, b) => a - b).map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n === 1 ? "1 hour" : `${n} hours`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-from`} className="text-xs text-muted-foreground">
                {randomRuns ? "Between" : "From"}
              </Label>
              <Input id={`${idPrefix}-from`} type="time" value={time} onChange={(e) => onTime(e.target.value)} className="w-32" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-until`} className="text-xs text-muted-foreground">
                {randomRuns ? "and" : "Until"}
              </Label>
              <Input
                id={`${idPrefix}-until`}
                type="time"
                value={`${pad(draft.untilHour)}:${pad(draft.untilMinute)}`}
                onChange={(e) => onUntil(e.target.value)}
                className="w-32"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label id={`${idPrefix}-days-label`} className="text-xs text-muted-foreground">
              On
            </Label>
            <ToggleGroup
              type="multiple"
              variant="outline"
              size="sm"
              value={draft.days.map(String)}
              onValueChange={(v) => v.length && update({ days: v.map(Number).sort((a, b) => a - b) })}
              aria-labelledby={`${idPrefix}-days-label`}
              className="flex-wrap"
            >
              {WEEK_ORDER.map((d) => (
                <ToggleGroupItem key={d} value={String(d)} aria-label={WEEKDAYS[d]} className={cn("px-2.5", TOGGLE_ON)}>
                  {WEEKDAYS[d].slice(0, 3)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <DayTimeline draft={draft} />
        </div>
      )}

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
              <ToggleGroupItem key={d} value={String(d)} aria-label={WEEKDAYS[d]} className="px-2.5 data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset">
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
            aria-invalid={!!invalid}
            className="font-mono"
          />
          <div className="flex flex-wrap gap-1.5">
            {CUSTOM_EXAMPLES.map((ex) => (
              <button
                key={ex.cron}
                type="button"
                onClick={() => update({ custom: ex.cron })}
                className="rounded-[5px] border bg-card px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span className="font-mono">{ex.cron}</span> · {ex.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {!randomRuns && children}

      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
          error ? "border-destructive/30 bg-destructive/[0.06] text-destructive" : "bg-paper-2 text-foreground",
        )}
        role="status"
        aria-live="polite"
      >
        {error ? <TriangleAlert className="size-4 shrink-0" /> : <CalendarClock className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate">{error ?? scheduleToHuman(cron, startWindowMinutes, runsPerWindow)}</span>
        {!error && <code className="shrink-0 rounded-[5px] border bg-card px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{cron}</code>}
      </div>
    </div>
  );
}
