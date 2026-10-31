import { useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Blocks, CalendarDays, Plus, Radar, Sun, Workflow } from "lucide-react";
import type { Agent, Routine } from "@godmode/shared";
import { useRoutines } from "@/lib/hooks";
import { useEasyMode } from "@/lib/mode";
import { errorMessage } from "@/lib/api";
import { EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RoutineDialog, type RoutineDraft } from "../routine-dialog";
import { RoutineItem } from "../routine-item";

const QUICK_STARTS = [
  { icon: Sun, labelKey: "routinesTab.quickStarts.morning", nameKey: "routinesTab.quickStarts.morningName", draft: { triggerType: "schedule", cron: "0 8 * * *" } },
  { icon: CalendarDays, labelKey: "routinesTab.quickStarts.monday", nameKey: "routinesTab.quickStarts.mondayName", draft: { triggerType: "schedule", cron: "0 9 * * 1" } },
  { icon: Blocks, labelKey: "routinesTab.quickStarts.appEvent", nameKey: null, draft: { triggerType: "app" } },
  { icon: Radar, labelKey: "routinesTab.quickStarts.condition", nameKey: null, draft: { triggerType: "condition" } },
] as const satisfies readonly { icon: typeof Sun; labelKey: string; nameKey: string | null; draft: Partial<RoutineDraft> }[];

export function RoutinesTab({ agent }: { agent: Agent }) {
  const { t } = useTranslation("agents");
  const q = useRoutines(agent.id);
  const easy = useEasyMode();
  const [dialog, setDialog] = useState<{ key: string; open: boolean; routine: Routine | null; initial?: Partial<RoutineDraft> } | null>(null);
  const routines = [...(q.data ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));

  const openNew = (initial?: Partial<RoutineDraft>) => setDialog({ key: `new-${Date.now()}`, open: true, routine: null, initial });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {easy ? t("routinesTab.introEasy", { name: agent.name }) : t("routinesTab.introPro", { name: agent.name })}
        </p>
        <Button onClick={() => openNew()} disabled={!agent.enabled}>
          <Plus /> {t("routinesTab.newAutomation")}
        </Button>
      </div>

      {q.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : q.isError ? (
        <EmptyState icon={<Workflow />} title={t("routinesTab.loadError")} description={errorMessage(q.error)} />
      ) : routines.length === 0 ? (
        <EmptyState
          icon={<Workflow />}
          title={t("routinesTab.emptyTitle")}
          description={t("routinesTab.emptyDescription", { name: agent.name })}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {QUICK_STARTS.map((s) => (
                <Button key={s.labelKey} variant="outline" size="sm" onClick={() => openNew(s.nameKey ? { ...s.draft, name: t(s.nameKey) } : s.draft)} disabled={!agent.enabled}>
                  <s.icon /> {t(s.labelKey)}
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
