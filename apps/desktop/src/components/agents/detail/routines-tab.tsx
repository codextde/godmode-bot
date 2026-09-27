import { useState } from "react";
import { motion } from "motion/react";
import { CalendarClock, Plus, Sun, CalendarDays, CalendarRange } from "lucide-react";
import type { Agent, Routine } from "@godmode/shared";
import { useRoutines } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RoutineDialog, type RoutineDraft } from "../routine-dialog";
import { RoutineItem } from "../routine-item";

const QUICK_STARTS: { icon: typeof Sun; label: string; draft: Partial<RoutineDraft> }[] = [
  { icon: Sun, label: "Every morning", draft: { name: "Morning check-in", cron: "0 8 * * *" } },
  { icon: CalendarDays, label: "Every Monday", draft: { name: "Weekly review", cron: "0 9 * * 1" } },
  { icon: CalendarRange, label: "1st of the month", draft: { name: "Monthly run", cron: "0 9 1 * *" } },
];

export function RoutinesTab({ agent }: { agent: Agent }) {
  const q = useRoutines(agent.id);
  const [dialog, setDialog] = useState<{ key: string; open: boolean; routine: Routine | null; initial?: Partial<RoutineDraft> } | null>(null);
  const routines = [...(q.data ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));

  const openNew = (initial?: Partial<RoutineDraft>) => setDialog({ key: `new-${Date.now()}`, open: true, routine: null, initial });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Routines run {agent.name} on a schedule with a fixed prompt — perfect for recurring chores.
        </p>
        <Button onClick={() => openNew()} disabled={!agent.enabled}>
          <Plus /> New routine
        </Button>
      </div>

      {q.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-2xl" />
          ))}
        </div>
      ) : q.isError ? (
        <EmptyState icon={<CalendarClock />} title="Couldn't load routines" description={errorMessage(q.error)} />
      ) : routines.length === 0 ? (
        <EmptyState
          icon={<CalendarClock />}
          title="No routines yet"
          description={`Schedule ${agent.name} to work automatically — even while you're away.`}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {QUICK_STARTS.map((s) => (
                <Button key={s.label} variant="outline" size="sm" onClick={() => openNew(s.draft)} disabled={!agent.enabled}>
                  <s.icon /> {s.label}
                </Button>
              ))}
            </div>
          }
        />
      ) : (
        <div className="space-y-3">
          {routines.map((r, i) => (
            <motion.div key={r.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 10) * 0.03 }}>
              <RoutineItem routine={r} onEdit={(routine) => setDialog({ key: `${routine.id}-${Date.now()}`, open: true, routine })} />
            </motion.div>
          ))}
        </div>
      )}

      {dialog && (
        <RoutineDialog
          key={dialog.key}
          open={dialog.open}
          onOpenChange={(o) => !o && setDialog((d) => d && { ...d, open: false })}
          routine={dialog.routine}
          agentId={agent.id}
          initial={dialog.initial}
        />
      )}
    </div>
  );
}
