import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ClaudeAccount, ClaudeUsage, ClaudeUsageWindow } from "@godmode/shared";
import { DefaultTag, useAccountName, useClaudeAccounts } from "@/components/claude-accounts/shared";
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

function Rings({ fiveHour, week }: { fiveHour: number | null; week: number }) {
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

function UsageRows({ usage }: { usage: ClaudeUsage & { week: ClaudeUsageWindow } }) {
  const { t } = useTranslation("layout");
  return (
    <>
      {usage.fiveHour && <Row label={t("usage.fiveHour")} window={usage.fiveHour} />}
      <Row label={t("usage.week")} window={usage.week} />
    </>
  );
}

function hasWeek(usage: ClaudeUsage | null): usage is ClaudeUsage & { week: ClaudeUsageWindow } {
  return !!usage?.week;
}

function AccountUsage({ account }: { account: ClaudeAccount }) {
  const { t } = useTranslation("layout");
  const accountName = useAccountName();
  return (
    <div className="flex flex-col gap-1.5 border-t border-current/15 pt-2 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-medium">{accountName(account)}</span>
        {account.isDefault && <DefaultTag className="shrink-0 bg-current/10 text-current" />}
      </div>
      {account.needsSignIn ? (
        <span className="text-warning">{t("usage.signedOut")}</span>
      ) : hasWeek(account.usage) ? (
        <UsageRows usage={account.usage} />
      ) : (
        <span className="opacity-70">{t("usage.noReading")}</span>
      )}
    </div>
  );
}

export function UsageRing() {
  const { t } = useTranslation("layout");
  const accountName = useAccountName();
  const qc = useQueryClient();
  const accounts = useClaudeAccounts();
  const list = accounts.data?.accounts ?? [];
  const shown = list.find((a) => a.isDefault && hasWeek(a.usage)) ?? list.find((a) => hasWeek(a.usage));
  if (!shown || !hasWeek(shown.usage)) return null;
  const usage = shown.usage;
  const multi = list.length > 1;
  const name = accountName(shown);
  const fiveHour = usage.fiveHour ? left(usage.fiveHour) : null;
  const week = left(usage.week);
  const label = fiveHour === null ? t("usage.labelWeek", { week }) : t("usage.label", { fiveHour, week });
  const refresh = () => void qc.fetchQuery({ queryKey: qk.claudeAccounts, queryFn: api.claudeAccounts.refresh, staleTime: 0 });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8", accounts.isFetching && "opacity-70")}
          aria-label={multi ? `${name}: ${label}` : label}
          onClick={refresh}
        >
          <Rings fiveHour={fiveHour} week={week} />
        </Button>
      </TooltipTrigger>
      <TooltipContent className={multi ? "w-72" : "w-64"}>
        <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto py-0.5">
          <p className="font-semibold">{t("usage.title")}</p>
          {multi ? list.map((a) => <AccountUsage key={a.id} account={a} />) : <UsageRows usage={usage} />}
          {usage.state !== "ok" && <p className="text-warning">{t("usage.stale")}</p>}
          <p className="opacity-60">{multi ? t("usage.hintAccounts", { name }) : fiveHour === null ? t("usage.hintWeek") : t("usage.hint")}</p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
