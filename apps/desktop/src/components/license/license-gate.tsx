import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { differenceInCalendarDays } from "date-fns";
import { motion } from "motion/react";
import { CalendarClock, Clock, KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { MASCOT_CHARACTER, MASCOT_COLOR, type LicenseState, type LicenseUsage } from "@godmode/shared";
import { Backdrop } from "@/components/brand";
import { Character } from "@/components/character";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useLocale } from "@/i18n/language";
import { api, errorMessage } from "@/lib/api";
import { isMac } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { EASE_OUT, useReduceAnimations } from "@/lib/motion";
import { ActivatePanel } from "./activate";

interface Stat {
  key: string;
  icon: ReactNode;
  value: string;
  label: string;
}

/** Replaces the app while the licence refuses new runs; a working key takes it away without a reload. */
export function LicenseGate({ state }: { state: LicenseState }) {
  const reduce = useReduceAnimations();
  const { t } = useTranslation("license");
  const qc = useQueryClient();
  const trialOver = state.status === "missing" && !!state.graceEndsAt;
  const usage = useQuery({ queryKey: qk.licenseUsage, queryFn: api.license.usage, enabled: trialOver, staleTime: 60_000, retry: 1 });
  const refresh = useMutation({
    mutationFn: api.license.refresh,
    onSuccess: (next) => {
      qc.setQueryData(qk.license, next);
      if (next.blocked) toast(t("gate.nothingChanged"), { description: next.message ?? undefined });
    },
    onError: (err) => toast.error(t("gate.checkFailed"), { description: errorMessage(err) }),
  });
  if (trialOver && usage.isPending) return <div className="relative min-h-full bg-background"><Backdrop /></div>;

  const enter = (delay: number) => ({
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: reduce ? 0.25 : 0.5, delay: reduce ? 0 : delay, ease: EASE_OUT },
  });

  return (
    <div className="relative min-h-full overflow-y-auto bg-background">
      <Backdrop />
      <div className="absolute inset-x-0 top-0 h-8" data-tauri-drag-region />
      <div className="relative mx-auto flex min-h-full w-full max-w-[540px] flex-col justify-center px-5 py-10">
        {trialOver ? <TrialOver usage={usage.data ?? null} endedAt={state.graceEndsAt!} enter={enter} /> : <Refused state={state} enter={enter} />}

        <motion.div {...enter(0.16)} className="mt-6 rounded-2xl border bg-card p-6 shadow-float sm:p-7">
          <ActivatePanel source="gate" cta={trialOver || state.status === "expired" ? "keep" : "subscribe"} />
        </motion.div>

        <div className="mt-6 flex min-h-8 items-center justify-center gap-3 text-xs text-muted-foreground">
          {state.keyHint ? (
            <>
              <span>
                <Trans t={t} i18nKey="gate.keyEndingIn" values={{ hint: state.keyHint }} components={{ key: <span className="font-mono text-foreground" /> }} />
              </span>
              <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
                {refresh.isPending ? <Spinner className="size-3.5" /> : <RefreshCw />} {t("checkAgain")}
              </Button>
            </>
          ) : (
            <span className="flex items-center gap-1.5 text-balance">
              <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
              {isMac ? t("gate.dataSafeMac") : t("gate.dataSafe")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

type Enter = (delay: number) => Record<string, unknown>;

/** The end of the free trial: what Godmode already did, or a softer hello when it hasn't done anything yet. */
function TrialOver({ usage, endedAt, enter }: { usage: LicenseUsage | null; endedAt: string; enter: Enter }) {
  const { t } = useTranslation("license");
  const { intlLocale } = useLocale();
  const num = (n: number) => n.toLocaleString(intlLocale);

  if (!usage || usage.tasksDone === 0) {
    return (
      <motion.div {...enter(0)} className="flex flex-col items-center text-center">
        <Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={64} mood="idle" follow title="Godmode" />
        <p className="eyebrow mt-5">{t("gate.trialOver")}</p>
        <h1 className="heading-display mt-2 text-[32px] text-balance sm:text-[36px]">{t("gate.readyTitle")}</h1>
        <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-balance text-muted-foreground">{t("gate.readyText")}</p>
      </motion.div>
    );
  }

  const until = Math.min(Date.now(), Date.parse(endedAt));
  const days = usage.since ? Math.max(1, differenceInCalendarDays(until, new Date(usage.since))) : null;
  const headline =
    days !== null && days >= 2 && days <= 60
      ? t("gate.doneInDays", { count: usage.tasksDone, formatted: num(usage.tasksDone), days })
      : t("gate.doneSoFar", { count: usage.tasksDone, formatted: num(usage.tasksDone) });
  const agents = usage.agents > 0 ? t("gate.yourAgents", { count: usage.agents }) : null;
  const automations = usage.automations > 0 ? t("gate.automationCount", { count: usage.automations }) : null;
  const ready =
    agents && automations
      ? t("gate.readyBoth", { agents, automations })
      : agents
        ? t("gate.readyAgents", { count: usage.agents })
        : automations
          ? t("gate.readyAutomations", { count: usage.automations })
          : null;

  const hours = usage.minutesWorked / 60;
  const time = hours >= 1
    ? t("gate.stats.hoursValue", { value: hours.toLocaleString(intlLocale, { maximumFractionDigits: hours < 10 ? 1 : 0 }) })
    : t("gate.stats.minutesValue", { value: num(usage.minutesWorked) });
  const all: (Stat | false)[] = [
    usage.minutesWorked > 0 && { key: "time", icon: <Clock />, value: time, label: t("gate.stats.time") },
    usage.automationRuns > 0 && { key: "runs", icon: <CalendarClock />, value: num(usage.automationRuns), label: t("gate.stats.automationRuns", { count: usage.automationRuns }) },
    usage.logins > 0 && { key: "logins", icon: <KeyRound />, value: num(usage.logins), label: t("gate.stats.logins", { count: usage.logins }) },
  ];
  const stats = all.filter((s): s is Stat => !!s);

  return (
    <>
      <motion.div {...enter(0)} className="flex flex-col items-center text-center">
        <Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={64} mood="happy" follow title="Godmode" />
        <p className="eyebrow mt-5">{t("gate.trialOver")}</p>
        <h1 className="heading-display mt-2 text-[30px] text-balance sm:text-[34px]">{headline}</h1>
        {ready && <p className="mt-3 max-w-md text-[15px] leading-relaxed text-balance text-muted-foreground">{ready}</p>}
      </motion.div>
      {stats.length > 1 && (
        <motion.ul {...enter(0.08)} className={`mt-6 grid gap-2 ${stats.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          {stats.map((s) => (
            <li key={s.key} className="flex items-center gap-2.5 rounded-xl border bg-card/80 px-3 py-3 shadow-card backdrop-blur-sm">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-strong [&_svg]:size-3.5">{s.icon}</span>
              <span className="min-w-0">
                <span className="block text-[17px] leading-tight font-semibold tracking-[-0.02em] tabular-nums">{s.value}</span>
                <span className="block text-xs leading-snug text-muted-foreground">{s.label}</span>
              </span>
            </li>
          ))}
        </motion.ul>
      )}
    </>
  );
}

/** A key that doesn't work (any more), or no key and no free trial. */
function Refused({ state, enter }: { state: LicenseState; enter: Enter }) {
  const { t } = useTranslation("license");
  return (
    <motion.div {...enter(0)} className="flex flex-col items-center text-center">
      <Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={76} mood="idle" follow title="Godmode" />
      <p className="eyebrow mt-7">Godmode Pro</p>
      <h1 className="heading-display mt-2 text-[32px] sm:text-[36px]">{state.status === "expired" ? t("gate.endedTitle") : t("gate.activateTitle")}</h1>
      <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-balance text-muted-foreground">{state.message ?? t("gate.subtitle")}</p>
    </motion.div>
  );
}
