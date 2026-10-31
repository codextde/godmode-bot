import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, ArrowRight, Bot, ChevronDown, CircleCheck, CircleDashed, Cookie, KeyRound, ShieldCheck } from "lucide-react";
import { MASCOT_CHARACTER, MASCOT_COLOR, type ChromeImportResult, type LicenseState, type LocalChromeProfile } from "@godmode/shared";
import { Character } from "@/components/character";
import { ActivatePanel } from "@/components/license/activate";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLocale } from "@/i18n/language";
import { api, errorMessage } from "@/lib/api";
import { isMac } from "@/lib/desktop";
import { useLicense } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { FormError, SubmitButton } from "./auth-layout";
import { Confetti, StepCard, StepFooter } from "./step-kit";

export interface OnboardingSummary {
  doctorOk: boolean | null;
  vault: "created" | "unlocked" | "existing" | null;
  dashboardPassword: boolean | null;
}

const NEXT = [
  { to: "/agents/new", icon: <Bot />, key: "agent" },
  { to: "/vault/logins", icon: <KeyRound />, key: "logins" },
  { to: "/vault/2fa?import=1", icon: <ShieldCheck />, key: "totp" },
  { to: "/settings/memory?import=1", icon: <ArrowDownToLine />, key: "memory" },
] as const;

const LICENSED: LicenseState["status"][] = ["active", "trial", "past_due", "unverified"];

export function DoneStep({
  userName,
  summary,
  serverMode,
  onFinish,
}: {
  userName: string;
  summary: OnboardingSummary;
  serverMode: boolean;
  onFinish: (to: string) => Promise<void>;
}) {
  const { t } = useTranslation("onboarding");
  const { dateLocale } = useLocale();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: license, isLoading: licenseLoading } = useLicense();
  const licensed = !!license?.keyHint && !license.blocked && LICENSED.includes(license.status);
  const freeUntil = license?.enforced && license.status === "grace" && license.graceEndsAt ? new Date(license.graceEndsAt) : null;
  const needsKey = !!license && !licensed && !freeUntil;
  const [activateOpen, setActivateOpen] = useState(false);
  const blocked = !!license?.blocked;
  const first = userName.trim().split(/\s+/)[0];

  const finish = async (to: string) => {
    if (busy || blocked || licenseLoading) return;
    setBusy(to);
    setError(null);
    try {
      await onFinish(to);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  const licenseDetail = licensed
    ? license!.status === "trial" && license!.trialEndsAt
      ? t("done.trialUntil", { date: format(new Date(license!.trialEndsAt), t("done.shortDate"), { locale: dateLocale }) })
      : t("done.activated")
    : freeUntil
      ? t("done.freeUntil", { date: format(freeUntil, t("done.shortDate"), { locale: dateLocale }) })
      : license && !license.enforced
        ? t("done.freeBuild")
        : blocked
          ? t("done.needsKey")
          : t("done.notActivated");

  return (
    <div>
      {!blocked && <Confetti />}
      <div className="mb-8 flex flex-col items-center text-center">
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 20, delay: 0.1 }}
        >
          <Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={88} mood={blocked ? "attention" : "happy"} follow title="Godmode" />
        </motion.div>
        <h2 className="heading-display mt-7 text-[40px] sm:text-[48px]">
          {first ? t("done.allSetNamed", { name: first }) : t("done.allSet")}
          <span className="block text-foreground/35">{t("done.ready")}</span>
        </h2>
        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted-foreground">
          {t("done.intro")}
        </p>
      </div>

      <StepCard>
        <ul className="divide-y overflow-hidden rounded-xl border bg-paper-2">
          <SummaryRow
            i={0}
            ok={summary.doctorOk}
            label={t("done.setup")}
            detail={summary.doctorOk === false ? t("done.setupMissing") : summary.doctorOk ? t("done.setupOk") : undefined}
          />
          <SummaryRow i={1} ok={summary.vault !== null} label={t("done.vault")} detail={summary.vault === "created" ? t("done.vaultCreated") : summary.vault ? t("done.vaultUnlocked") : undefined} />
          <ChromeImportRow i={2} />
          <SummaryRow
            i={3}
            ok={licensed || !!freeUntil || (!!license && !license.enforced) ? true : blocked ? false : null}
            label="Godmode Pro"
            detail={licenseDetail}
            action={
              needsKey && license?.enforced ? (
                <Button size="xs" variant={blocked ? "default" : "outline"} className="h-7 px-2.5" onClick={() => setActivateOpen((o) => !o)} aria-expanded={activateOpen || blocked}>
                  {t("done.activate")} <ChevronDown className={cn("transition-transform", (activateOpen || blocked) && "rotate-180")} />
                </Button>
              ) : undefined
            }
          />
          {serverMode && (
            <SummaryRow
              i={4}
              ok={summary.dashboardPassword}
              label={t("remote.passwordLabel")}
              detail={summary.dashboardPassword ? t("done.passwordSet") : t("done.passwordNotSet")}
            />
          )}
        </ul>

        <AnimatePresence initial={false}>
          {needsKey && (activateOpen || blocked) && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <div className="mt-4 rounded-xl border p-5">
                {blocked && license?.message && <p className="mb-4 text-sm text-muted-foreground">{license.message}</p>}
                <ActivatePanel source="onboarding" onActivated={() => setActivateOpen(false)} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <p className="eyebrow mt-7 mb-3">{t("done.nextUp")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {NEXT.map((n, i) => (
            <motion.button
              key={n.to}
              type="button"
              disabled={!!busy || blocked || licenseLoading}
              onClick={() => finish(n.to)}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.45 + i * 0.07 }}
              className="group rounded-lg border bg-card p-4 text-left shadow-card transition hover:border-foreground/15 hover:shadow-float focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
            >
              <div className="mb-2.5 grid size-8 place-items-center rounded-md border bg-secondary text-foreground [&_svg]:size-4">{n.icon}</div>
              <p className="flex items-center gap-1 text-sm font-medium tracking-[-0.01em]">
                {t(`done.next.${n.key}.title`)}
                <ArrowRight className="size-3.5 opacity-0 transition-all calm-motion:transition-[opacity,transform] group-hover:translate-x-0.5 group-hover:opacity-100" />
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t(`done.next.${n.key}.body`)}</p>
            </motion.button>
          ))}
        </div>

        {error && (
          <div className="mt-5">
            <FormError message={error} />
          </div>
        )}

        <StepFooter>
          {blocked && <span className="text-xs text-muted-foreground">{t("done.activateToStart")}</span>}
          <SubmitButton busy={busy === "/"} disabled={!!busy || blocked || licenseLoading} type="button" onClick={() => finish("/")} className="w-auto px-8">
            {t("done.start")}
          </SubmitButton>
        </StepFooter>
      </StepCard>
    </div>
  );
}

function SummaryRow({ i, ok, label, detail, action }: { i: number; ok: boolean | null; label: string; detail?: string; action?: ReactNode }) {
  return (
    <motion.li
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.25 + i * 0.07 }}
      className="flex min-h-12 items-center gap-3 px-3.5 py-2 text-sm"
    >
      {ok ? (
        <CircleCheck className="size-4 shrink-0 text-success" />
      ) : (
        <CircleDashed className={cn("size-4 shrink-0", ok === false ? "text-warning" : "text-muted-foreground")} />
      )}
      <span className="font-medium">{label}</span>
      {detail && <span className="ml-auto truncate text-xs text-muted-foreground">{detail}</span>}
      {action && <span className={cn("shrink-0", !detail && "ml-auto")}>{action}</span>}
    </motion.li>
  );
}

/** One click brings Chrome's sign-ins into Godmode's browser; hidden when this computer has no Chrome profile. */
function ChromeImportRow({ i }: { i: number }) {
  const { t } = useTranslation("onboarding");
  const { intlLocale } = useLocale();
  const chrome = useQuery({ queryKey: qk.chromeProfiles, queryFn: api.browser.chromeProfiles, retry: false });
  const profiles = chrome.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = profiles.find((p) => p.path === selected) ?? profiles[0] ?? null;
  const [result, setResult] = useState<ChromeImportResult | null>(null);
  const importMut = useMutation({
    mutationFn: async (profile: LocalChromeProfile) => {
      const targets = await api.browser.profiles();
      const target = targets.find((p) => p.isDefault) ?? targets.find((p) => !p.workspaceId) ?? targets[0];
      if (!target) throw new Error(t("done.chrome.noProfile"));
      return api.browser.import(target.id, { sourcePath: profile.path });
    },
    onSuccess: setResult,
  });

  if (result)
    return <SummaryRow i={i} ok label={t("done.chrome.label")} detail={t("done.chrome.imported", { count: result.domains.length, formatted: result.domains.length.toLocaleString(intlLocale) })} />;
  if (chrome.isLoading || chrome.isError || !chosen)
    return <SummaryRow i={i} ok={null} label={t("done.chrome.label")} detail={chrome.isLoading ? t("done.chrome.looking") : t("done.chrome.none")} />;

  return (
    <motion.li initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 + i * 0.07 }} className="px-3.5 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <CircleDashed className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">{t("done.chrome.label")}</span>
          <span className="block text-xs text-muted-foreground">{t("done.chrome.hint")}</span>
        </span>
        {profiles.length > 1 && (
          <Select value={chosen.path} onValueChange={setSelected}>
            <SelectTrigger size="sm" className="h-7 w-56 bg-card text-xs" aria-label={t("done.chrome.profile")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {profiles.map((p) => (
                <SelectItem key={p.path} value={p.path} className="text-xs">
                  {p.name}
                  {p.email ? ` · ${p.email}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button size="xs" variant="outline" className="h-7 px-2.5" onClick={() => importMut.mutate(chosen)} disabled={importMut.isPending}>
          <Cookie /> {importMut.isPending ? t("done.chrome.importing") : profiles.length > 1 ? t("done.chrome.import") : t("done.chrome.importFrom", { name: chosen.name })}
        </Button>
      </div>
      {importMut.isError && <p className="mt-2 pl-7 text-xs text-destructive">{errorMessage(importMut.error)}</p>}
      {!importMut.isError && isMac && importMut.isPending && (
        <p className="mt-2 pl-7 text-xs text-muted-foreground">{t("done.chrome.keychain")}</p>
      )}
    </motion.li>
  );
}
