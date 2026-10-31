import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { CircleCheck, CircleX, Radar, RotateCw, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import type { BotCheckReport, BotCheckStatus, BrowserSettings } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { dateLocale, t as translate } from "@/i18n";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { SettingRow } from "./settings-kit";

const STATUS = {
  pass: { icon: CircleCheck, text: "text-success", bar: "bg-success", labelKey: "botCheck.status.pass" },
  warn: { icon: TriangleAlert, text: "text-warning", bar: "bg-warning", labelKey: "botCheck.status.warn" },
  fail: { icon: CircleX, text: "text-destructive", bar: "bg-destructive", labelKey: "botCheck.status.fail" },
} as const satisfies Record<BotCheckStatus, { icon: typeof CircleCheck; text: string; bar: string; labelKey: string }>;

function verdict(report: BotCheckReport) {
  const fails = report.checks.filter((c) => c.status === "fail").length;
  const warns = report.checks.filter((c) => c.status === "warn").length;
  const passed = report.checks.length - fails - warns;
  if (fails) return { tone: "fail" as const, title: translate("settings:botCheck.verdictFail", { count: fails }), passed };
  if (warns) return { tone: "pass" as const, title: translate("settings:botCheck.verdictWarn"), passed };
  return { tone: "pass" as const, title: translate("settings:botCheck.verdictPass"), passed };
}

/** Bot check of the global default profile's browser, shown inline in Settings → Browser. */
export function BotCheck({ browser }: { browser: BrowserSettings }) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const { data: profiles } = useQuery({ queryKey: qk.browserProfiles, queryFn: api.browser.profiles });
  const profile = profiles?.find((p) => p.isDefault && !p.workspaceId) ?? null;
  const key = [...qk.botCheck, profile?.id ?? ""];
  const report = useQuery<BotCheckReport | null>({ queryKey: key, queryFn: () => null, enabled: false, initialData: null, staleTime: Infinity });

  const run = useMutation({
    mutationFn: async (restart: boolean) => {
      if (!profile) throw new Error(t("botCheck.profileNotReady"));
      if (restart) {
        await api.browser.stop(profile.id);
        await api.browser.launch(profile.id, profile.headless ?? undefined);
      }
      return api.browser.botCheck(profile.id);
    },
    onSuccess: (r) => {
      qc.setQueryData([...qk.botCheck, r.profileId], r);
      void qc.invalidateQueries({ queryKey: qk.browserProfiles });
    },
    onError: (e) => toastApiError(e, t("botCheck.failed"), qc),
  });

  const r = report.data;
  const restartNeeded = !!profile?.running && profile.stealth !== null && profile.stealth !== browser.stealth;
  const stale = !!r && !restartNeeded && r.stealth !== browser.stealth;
  const disabled = !browser.enabled || !profile;

  if (!r && !run.isPending) {
    return (
      <SettingRow
        label={t("botCheck.label")}
        disabled={!browser.enabled}
        description={t("botCheck.description")}
      >
        <Button variant="outline" size="sm" onClick={() => run.mutate(false)} disabled={disabled}>
          <Radar /> {t("botCheck.run")}
        </Button>
      </SettingRow>
    );
  }

  const v = r ? verdict(r) : null;
  return (
    <div className="py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div
            className={cn(
              "grid size-10 shrink-0 place-items-center rounded-full border [&_svg]:size-[18px]",
              !v && "bg-paper-2 text-muted-foreground",
              v?.tone === "pass" && "border-success/25 bg-success/[0.08] text-success",
              v?.tone === "fail" && "border-destructive/25 bg-destructive/[0.07] text-destructive",
            )}
          >
            {!v ? <Spinner /> : v.tone === "pass" ? <ShieldCheck /> : <ShieldAlert />}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium tracking-[-0.01em]">{v ? v.title : t("botCheck.checking")}</div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {r ? (
                <>
                  {r.browser.replace("/", " ")} · {r.headless ? t("botCheck.headless") : t("botCheck.visible")} · {r.stealth ? t("botCheck.stealthOn") : t("botCheck.stealthOff")} · {format(new Date(r.checkedAt), "HH:mm", { locale: dateLocale() })}
                </>
              ) : (
                t("botCheck.opening")
              )}
            </div>
          </div>
        </div>
        {r && (
          <div className="flex items-center gap-3">
            <Meter report={r} />
            <Button variant="ghost" size="sm" onClick={() => run.mutate(false)} disabled={run.isPending || disabled}>
              {run.isPending ? <Spinner /> : <RotateCw />} {t("botCheck.again")}
            </Button>
          </div>
        )}
      </div>

      <AnimatePresence initial={false}>
        {(restartNeeded || stale) && !run.isPending && (
          <motion.div
            key={restartNeeded ? "restart" : "stale"}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div
              className={cn(
                "mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3.5 py-2.5 text-xs",
                restartNeeded ? "border-warning/25 bg-warning/[0.06]" : "bg-paper-2/60 py-3",
              )}
            >
              <span className="min-w-0 flex-1 text-foreground/85">
                {restartNeeded
                  ? profile?.stealth
                    ? t("botCheck.restartNeededOn")
                    : t("botCheck.restartNeededOff")
                  : browser.stealth
                    ? t("botCheck.staleOn")
                    : t("botCheck.staleOff")}
              </span>
              {restartNeeded && (
                <Button size="xs" variant="outline" onClick={() => run.mutate(true)} disabled={disabled}>
                  <RotateCw /> {t("botCheck.restart")}
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ul className="mt-4 overflow-hidden rounded-lg border">
        {r && !run.isPending
          ? r.checks.map((c, i) => {
              const s = STATUS[c.status];
              return (
                <motion.li
                  key={c.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.025 }}
                  className="grid grid-cols-[auto_1fr] items-start gap-x-3 border-b px-3.5 py-2.5 last:border-b-0 @lg:grid-cols-[auto_9rem_1fr]"
                >
                  <s.icon role="img" className={cn("mt-px size-4", s.text)} aria-label={t(s.labelKey)} />
                  <span className="text-[13px] font-medium">{c.label}</span>
                  <span className="col-start-2 text-xs leading-relaxed break-words text-muted-foreground @lg:col-start-3 @lg:pt-px">{c.detail}</span>
                </motion.li>
              );
            })
          : Array.from({ length: 10 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 border-b px-3.5 py-3 last:border-b-0">
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 flex-1" style={{ maxWidth: `${40 + ((i * 37) % 45)}%` }} />
              </li>
            ))}
      </ul>
    </div>
  );
}

function Meter({ report }: { report: BotCheckReport }) {
  const { t } = useTranslation("settings");
  const v = verdict(report);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          role="img"
          className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label={t("botCheck.passedOf", { passed: v.passed, total: report.checks.length })}
        >
          <div className="flex gap-[3px]">
            {report.checks.map((c) => (
              <span key={c.id} className={cn("h-3.5 w-1.5 rounded-full", STATUS[c.status].bar, c.status === "pass" && "opacity-80")} />
            ))}
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {v.passed}/{report.checks.length}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {t("botCheck.passedOf", { passed: v.passed, total: report.checks.length })}
      </TooltipContent>
    </Tooltip>
  );
}
