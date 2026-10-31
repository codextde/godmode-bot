import { formatDistanceToNowStrict } from "date-fns";
import { useTranslation } from "react-i18next";
import { useLocale } from "@/i18n/language";
import { cn } from "@/lib/utils";
import type { WorkspaceActivity } from "@/components/workspaces/workspace-activity";

/** What's going on in a scope, in a line: what waits for the human, what works, what's open, and when it last moved. */
export function ActivityChips({ activity, className, compact }: { activity: WorkspaceActivity; className?: string; compact?: boolean }) {
  const { t } = useTranslation("workspaces");
  const { dateLocale } = useLocale();
  const quiet = !activity.needsYou && !activity.running;
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-1.5 text-xs", className)}>
      {activity.needsYou > 0 && (
        <span className="inline-flex h-5 items-center gap-1 rounded-full bg-warning/12 px-2 font-medium text-warning">
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          {t("page.activity.needsYou", { count: activity.needsYou })}
        </span>
      )}
      {activity.running > 0 && (
        <span className="inline-flex h-5 items-center gap-1 rounded-full bg-brand-strong/10 px-2 font-medium text-brand-strong">
          <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
          {t("page.activity.working", { count: activity.running })}
        </span>
      )}
      {!compact && (
        <span className="truncate text-muted-foreground">
          {[
            activity.openTasks ? t("page.activity.openTasks", { count: activity.openTasks }) : quiet ? t("page.activity.noOpenTasks") : null,
            activity.lastActive ? t("page.activity.activeLower", { when: formatDistanceToNowStrict(new Date(activity.lastActive), { addSuffix: true, locale: dateLocale }) }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
    </div>
  );
}
