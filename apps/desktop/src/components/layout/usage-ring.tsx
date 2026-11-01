import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { Star } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ClaudeAccount, ClaudeUsage, ClaudeUsageWindow } from "@godmode/shared";
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

function Rings({ usage }: { usage: ClaudeUsage }) {
  const fiveHour = usage.fiveHour ? left(usage.fiveHour) : null;
  const week = usage.week ? left(usage.week) : 100;
  const outer = SIZE / 2 - STROKE / 2;
  const inner = outer - STROKE - GAP;
  const lowest = Math.min(fiveHour ?? 100, week);
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden className={cn(lowest <= 10 && "animate-pulse motion-reduce:animate-none")}>
      {fiveHour === null ? (
        <Arc radius={outer} remaining={week} />
      ) : (
        <>
          <Arc radius={outer} remaining={fiveHour} />
          <Arc radius={inner} remaining={week} />
        </>
      )}
    </svg>
  );
}

function ringLabel(t: TFunction<"layout">, usage: ClaudeUsage): string {
  const week = usage.week ? left(usage.week) : 100;
  return usage.fiveHour ? t("usage.label", { fiveHour: left(usage.fiveHour), week }) : t("usage.labelWeek", { week });
}

function accountName(t: TFunction<"layout">, account: ClaudeAccount): string {
  return account.name || account.email || (account.system ? t("usage.thisComputer") : t("usage.account"));
}

function AccountUsage({ account }: { account: ClaudeAccount }) {
  const { t } = useTranslation("layout");
  const usage = account.usage;
  return (
    <div className="flex flex-col gap-1.5 border-t border-current/15 pt-2 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-medium">{accountName(t, account)}</span>
        {account.isDefault && (
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded-[4px] bg-current/10 px-1 text-[10px] leading-4 font-medium">
            <Star className="size-2 fill-current" aria-hidden />
            {t("usage.default")}
          </span>
        )}
      </div>
      {account.needsSignIn ? (
        <span className="text-warning">{t("usage.signedOut")}</span>
      ) : usage?.week ? (
        <>
          {usage.fiveHour && <Row label={t("usage.fiveHour")} window={usage.fiveHour} />}
          <Row label={t("usage.week")} window={usage.week} />
        </>
      ) : (
        <span className="opacity-70">{t("usage.noReading")}</span>
      )}
    </div>
  );
}

export function UsageRing() {
  const { t } = useTranslation("layout");
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: qk.claudeAccounts, queryFn: api.claudeAccounts.list, refetchInterval: 60_000, refetchOnWindowFocus: true });
  const list = accounts.data?.accounts ?? [];
  const multi = list.length > 1;
  const usage = useQuery({
    queryKey: qk.claudeUsage,
    queryFn: () => api.doctor.claudeUsage(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    enabled: accounts.isFetched && !multi,
  });
  const fetchingUsage = useIsFetching({ queryKey: qk.claudeUsage }) > 0;
  const fetchingAccounts = useIsFetching({ queryKey: qk.claudeAccounts }) > 0;

  if (multi) {
    const shown = [list.find((a) => a.isDefault), ...list].find((a) => a?.usage?.state === "ok" && a.usage.week) ?? null;
    if (!shown?.usage) return null;
    const refresh = () => void qc.fetchQuery({ queryKey: qk.claudeAccounts, queryFn: api.claudeAccounts.refresh, staleTime: 0 });
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-8", fetchingAccounts && "opacity-70")}
            aria-label={`${accountName(t, shown)}: ${ringLabel(t, shown.usage)}`}
            onClick={refresh}
          >
            <Rings usage={shown.usage} />
          </Button>
        </TooltipTrigger>
        <TooltipContent className="w-72">
          <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto py-0.5">
            <p className="font-semibold">{t("usage.title")}</p>
            {list.map((a) => (
              <AccountUsage key={a.id} account={a} />
            ))}
            <p className="opacity-60">{t("usage.hintAccounts", { name: accountName(t, shown) })}</p>
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  const refresh = () => void qc.fetchQuery({ queryKey: qk.claudeUsage, queryFn: () => api.doctor.claudeUsage(true), staleTime: 0 });
  const data = usage.data;
  if (!data?.week) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className={cn("size-8", fetchingUsage && "opacity-70")} aria-label={ringLabel(t, data)} onClick={refresh}>
          <Rings usage={data} />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="w-64">
        <div className="flex flex-col gap-2 py-0.5">
          <p className="font-semibold">{t("usage.title")}</p>
          {data.fiveHour && <Row label={t("usage.fiveHour")} window={data.fiveHour} />}
          <Row label={t("usage.week")} window={data.week} />
          {data.state !== "ok" && <p className="text-warning">{t("usage.stale")}</p>}
          <p className="opacity-60">{data.fiveHour ? t("usage.hint") : t("usage.hintWeek")}</p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
