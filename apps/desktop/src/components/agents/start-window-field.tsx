import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Shuffle } from "lucide-react";
import { formatMinutes } from "@godmode/shared";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { maxStartWindow, START_WINDOW_PRESETS } from "./cron";

/**
 * "Random start time": the run begins somewhere in a window after the scheduled time, 0 = on time.
 * Problems (a window longer than the gap between runs) show in the schedule summary.
 */
export function StartWindowField({
  cron,
  timezone,
  value,
  onChange,
}: {
  cron: string;
  timezone: string;
  value: number;
  onChange: (minutes: number) => void;
}) {
  const [initial] = useState(value);
  const [remembered, setRemembered] = useState(value || 60);
  const on = value > 0;
  const max = useMemo(() => maxStartWindow(cron, timezone), [cron, timezone]);
  const options = [...new Set([...START_WINDOW_PRESETS.filter((m) => m <= max), ...(initial ? [initial] : []), ...(on ? [value] : [])])].sort((a, b) => a - b);

  const pick = (minutes: number) => {
    setRemembered(minutes);
    onChange(minutes);
  };

  return (
    <div className="rounded-lg border bg-card shadow-card">
      <div className="flex items-start gap-3 p-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-md border bg-paper-2 text-muted-foreground">
          <Shuffle className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <Label htmlFor="routine-start-window" className="cursor-pointer text-sm">
            Random start time
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">Starts at a different moment every time — like a coworker who doesn't clock in on the dot.</p>
        </div>
        <Switch id="routine-start-window" checked={on} onCheckedChange={(v) => onChange(v ? Math.min(remembered, max) : 0)} />
      </div>
      <AnimatePresence initial={false}>
        {on && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-3 py-2.5">
              <span id="routine-start-window-label" className="text-xs text-muted-foreground">
                Start within
              </span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={String(value)}
                onValueChange={(v) => v && pick(Number(v))}
                aria-labelledby="routine-start-window-label"
                className="flex-wrap"
              >
                {options.map((m) => (
                  <ToggleGroupItem
                    key={m}
                    value={String(m)}
                    className="px-2.5 tabular-nums data-[state=on]:bg-secondary data-[state=on]:text-foreground data-[state=on]:ring-1 data-[state=on]:ring-foreground/15 data-[state=on]:ring-inset"
                  >
                    {formatMinutes(m)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
