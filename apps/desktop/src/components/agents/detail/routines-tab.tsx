import { useState } from "react";
import { motion } from "motion/react";
import { Blocks, CalendarDays, Plus, Radar, Sun, Workflow } from "lucide-react";
import type { Agent, Routine } from "@godmode/shared";
import { useRoutines } from "@/lib/hooks";
import { errorMessage } from "@/lib/api";
import { EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RoutineDialog, type RoutineDraft } from "../routine-dialog";
import { RoutineItem } from "../routine-item";

const QUICK_STARTS: { icon: typeof Sun; label: string; draft: Partial<RoutineDraft> }[] = [
  { icon: Sun, label: "Every morning", draft: { name: "Morning check-in", triggerType: "schedule", cron: "0 8 * * *" } },
  { icon: CalendarDays, label: "Every Monday", draft: { name: "Weekly review", triggerType: "schedule", cron: "0 9 * * 1" } },
  { icon: Blocks, label: "On an app event", draft: { triggerType: "app" } },
  { icon: Radar, label: "When something changes", draft: { triggerType: "condition" } },
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
          Automations put {agent.name} to work on a schedule, when something happens in your apps, when a condition is met or when a webhook is
          called.
        </p>
        <Button onClick={() => openNew()} disabled={!agent.enabled}>
          <Plus /> New automation
        </Button>
      </div>

      {q.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : q.isError ? (
        <EmptyState icon={<Workflow />} title="Couldn't load automations" description={errorMessage(q.error)} />
      ) : routines.length === 0 ? (
        <EmptyState
          icon={<Workflow />}
          title="No automations yet"
          description={`Let ${agent.name} get to work on its own — even while you're away.`}
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
