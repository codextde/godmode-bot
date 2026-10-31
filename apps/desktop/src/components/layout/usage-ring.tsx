import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ClaudeUsageWindow } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { intlLocale } from "@/i18n";

const SIZE = 20;
const STROKE = 2.5;
const GAP = 1.5;

function left(window: ClaudeUsageWindow): number {
  return Math.round(100 - window.percent);
}

function tone(remaining: number): string {
  if (remaining <= 10) return "text-destructive";
  if (remaining <= 25) return "text-warning";
  return "text-brand";
}

function Arc({ radius, remaining }: { radius: number; remaining: number }) {
  const length = 2 * Math.PI * radius;
  const c = SIZE / 2;
  return (
    <g className={tone(remaining)}>
      <circle cx={c} cy={c} r={radius} fill="none" stroke="currentColor" strokeWidth={STROKE} className="opacity-20" />
      <circle
        cx={c}
        cy={c}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - Math.max(0, Math.min(100, remaining)) / 100)}
        transform={`rotate(-90 ${c} ${c})`}
        className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
      />
    </g>
  );
}

export function useResetLabel() {
  const { t } = useTranslation("layout");
  return (iso: string | null): string => {
    if (!iso) return t("usage.notStarted");
    const at = new Date(iso);
    const ms = at.getTime() - Date.now();
    if (ms <= 0) return t("usage.resetsSoon");
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (ms < 24 * 3_600_000) {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      const duration = h ? t("usage.hours", { h, m }) : t("usage.minutes", { m });
      return t("usage.resetsIn", { time: at.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" }), duration });
    }
    return t("usage.resetsOn", { when: at.toLocaleString(intlLocale(), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) });
  };
}

function Row({ label, window }: { label: string; window: ClaudeUsageWindow }) {
  const { t } = useTranslation("layout");
  const resetLabel = useResetLabel();
  const remaining = left(window);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums">{t("usage.left", { percent: remaining })}</span>
      </div>
      <span className="opacity-70">{resetLabel(window.resetsAt)}</span>
    </div>
  );
}

export function UsageRing() {
  const { t } = useTranslation("layout");
  const usage = useQuery({
    queryKey: qk.claudeUsage,
    queryFn: () => api.doctor.claudeUsage(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const qc = useQueryClient();
  const fetching = useIsFetching({ queryKey: qk.claudeUsage }) > 0;
  const refresh = () => void qc.fetchQuery({ queryKey: qk.claudeUsage, queryFn: () => api.doctor.claudeUsage(true), staleTime: 0 });
  const data = usage.data;
  if (!data?.fiveHour || !data.week) return null;
  const fiveHour = left(data.fiveHour);
  const week = left(data.week);
  const outer = SIZE / 2 - STROKE / 2;
  const inner = outer - STROKE - GAP;
  const lowest = Math.min(fiveHour, week);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8", fetching && "opacity-70")}
          aria-label={t("usage.label", { fiveHour, week })}
          onClick={refresh}
        >
          <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden className={cn(lowest <= 10 && "animate-pulse motion-reduce:animate-none")}>
            <Arc radius={outer} remaining={fiveHour} />
            <Arc radius={inner} remaining={week} />
          </svg>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="w-64">
        <div className="flex flex-col gap-2 py-0.5">
          <p className="font-semibold">{t("usage.title")}</p>
          <Row label={t("usage.fiveHour")} window={data.fiveHour} />
          <Row label={t("usage.week")} window={data.week} />
          {data.state !== "ok" && <p className="text-warning">{t("usage.stale")}</p>}
          <p className="opacity-60">{t("usage.hint")}</p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
