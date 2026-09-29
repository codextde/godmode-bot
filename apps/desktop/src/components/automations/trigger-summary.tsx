import type { Routine } from "@godmode/shared";
import { cronToHuman, localTimezone, scheduleToHuman } from "@/components/agents/cron";
import { prettySlug, ToolkitLogo, toolkitLogoUrl } from "@/components/integrations/toolkit-logo";
import { cn } from "@/lib/utils";
import { lowerFirst, TRIGGER_TYPES } from "./trigger-meta";

/** One line describing what starts an automation: schedule, app event (with logo), condition or webhook. */
export function TriggerSummary({ routine, icon = true, className }: { routine: Routine; icon?: boolean; className?: string }) {
  const t = routine.trigger;
  const Icon = TRIGGER_TYPES[t.type].icon;
  const tz = routine.timezone && routine.timezone !== localTimezone() ? routine.timezone.replace(/_/g, " ") : null;

  return (
    <div className={cn("flex min-w-0 items-center gap-x-1.5 text-sm text-foreground/80", className)}>
      {icon &&
        (t.type === "app" ? (
          <ToolkitLogo src={toolkitLogoUrl(t.toolkit)} name={t.toolkit} size="sm" className="size-4 rounded-[4px] text-[9px] shadow-none" />
        ) : (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        ))}
      {t.type === "schedule" && (
        <span className="min-w-0 truncate">
          {scheduleToHuman(routine.cron, t.startWindowMinutes)}
          {tz && <span className="ml-1.5 text-xs text-muted-foreground">({tz})</span>}
        </span>
      )}
      {t.type === "app" && (
        <span className="min-w-0 truncate">
          {t.triggerName}
          <span className="text-muted-foreground"> · {prettySlug(t.toolkit)}</span>
        </span>
      )}
      {t.type === "condition" && (
        <span className="min-w-0 truncate" title={`When ${t.condition}`}>
          When {t.condition}
          <span className="text-muted-foreground"> · checked {lowerFirst(cronToHuman(routine.cron))}</span>
        </span>
      )}
      {t.type === "webhook" && (
        <span className="min-w-0 truncate">
          Webhook<span className="text-muted-foreground"> · runs when its URL is called</span>
        </span>
      )}
    </div>
  );
}
