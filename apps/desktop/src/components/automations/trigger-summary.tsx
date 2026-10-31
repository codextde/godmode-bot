import { useTranslation } from "react-i18next";
import type { Routine } from "@godmode/shared";
import { cronToHuman, localTimezone, scheduleToHuman } from "@/components/agents/cron";
import { prettySlug, ToolkitLogo, toolkitLogoUrl } from "@/components/integrations/toolkit-logo";
import { cn } from "@/lib/utils";
import { lowerFirst, TRIGGER_TYPES } from "./trigger-meta";

/** One line describing what starts an automation: schedule, app event (with logo), condition or webhook. */
export function TriggerSummary({ routine, icon = true, className }: { routine: Routine; icon?: boolean; className?: string }) {
  const { t } = useTranslation("automations");
  const trigger = routine.trigger;
  const Icon = TRIGGER_TYPES[trigger.type].icon;
  const tz = routine.timezone && routine.timezone !== localTimezone() ? routine.timezone.replace(/_/g, " ") : null;

  return (
    <div className={cn("flex min-w-0 items-center gap-x-1.5 text-sm text-foreground/80", className)}>
      {icon &&
        (trigger.type === "app" ? (
          <ToolkitLogo src={toolkitLogoUrl(trigger.toolkit)} name={trigger.toolkit} size="sm" className="size-4 rounded-[4px] text-[9px] shadow-none" />
        ) : (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        ))}
      {trigger.type === "schedule" && (
        <span className="min-w-0 truncate">
          {scheduleToHuman(routine.cron, trigger.startWindowMinutes, trigger.runsPerWindow)}
          {tz && <span className="ml-1.5 text-xs text-muted-foreground">({tz})</span>}
        </span>
      )}
      {trigger.type === "app" && (
        <span className="min-w-0 truncate">
          {trigger.triggerName}
          <span className="text-muted-foreground"> · {prettySlug(trigger.toolkit)}</span>
        </span>
      )}
      {trigger.type === "condition" && (
        <span className="min-w-0 truncate" title={t("trigger.when", { condition: trigger.condition })}>
          {t("trigger.when", { condition: trigger.condition })}
          <span className="text-muted-foreground"> · {t("trigger.checked", { schedule: lowerFirst(cronToHuman(routine.cron)) })}</span>
        </span>
      )}
      {trigger.type === "webhook" && (
        <span className="min-w-0 truncate">
          {t("trigger.webhook.label")}<span className="text-muted-foreground"> · {t("trigger.webhookRuns")}</span>
        </span>
      )}
    </div>
  );
}
