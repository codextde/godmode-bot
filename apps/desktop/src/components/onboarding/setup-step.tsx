import { useCallback, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ChevronDown, CircleAlert, Globe, LogIn, RotateCw, Sparkles, UserRound } from "lucide-react";
import { MASCOT_CHARACTER, MASCOT_COLOR, type DependencyId, type DependencyStatus, type DoctorReport, type InterfaceMode } from "@godmode/shared";
import { Character, SpeechBubble } from "@/components/character";
import { DrawCheck } from "@/components/aicss/Motion";
import { MacPermissionsSummary } from "@/components/permissions/mac-permissions";
import { ModePicker } from "@/components/settings/mode-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { t as translate } from "@/i18n";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { SubmitButton } from "./auth-layout";
import { ClaudeSignInSteps, maySignIn, useClaudeLogin } from "./claude-sign-in";
import { InlineCode, useDoctor } from "./doctor-checklist";
import { StepCard, StepFooter } from "./step-kit";

/** Installed in this order: uv first, the browser tools run on it. */
const INSTALL_ORDER: DependencyId[] = ["claude", "uv", "browser-use", "chrome"];
const BROWSER_IDS: DependencyId[] = ["uv", "browser-use", "chrome"];
const ROW_IDS: DependencyId[] = ["claude", "claude-auth", ...BROWSER_IDS];
const DETAIL_IDS: DependencyId[] = ["claude", "claude-auth", "uv", "browser-use", "chrome", "git"];

type Job = { state: "installing" | "failed" | "done"; output?: string };
type RowState = "idle" | "waiting" | "active" | "action" | "done" | "failed";

const find = (report: DoctorReport | undefined, id: DependencyId) => report?.dependencies.find((d) => d.id === id);
const missing = (dep: DependencyStatus | undefined) => !!dep && dep.required && !dep.ok;

/** The line of an installer's output that says what went wrong. */
function reason(output: string | undefined): string {
  const lines = (output ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.findLast((l) => /error|fail|denied|not found|timed out|unable|cannot|could not/i.test(l)) ?? lines.at(-1) ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}…` : line || translate("onboarding:setup.noReason");
}

export function SetupStep({
  userName,
  onUserName,
  mode,
  onMode,
  onNext,
}: {
  userName: string;
  onUserName: (v: string) => void;
  mode: InterfaceMode;
  onMode: (mode: InterfaceMode) => void;
  onNext: (doctorOk: boolean) => void;
}) {
  const { t } = useTranslation(["onboarding", "common"]);
  const qc = useQueryClient();
  const doctor = useDoctor();
  const report = doctor.data;
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [jobs, setJobs] = useState<Partial<Record<DependencyId, Job>>>({});
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const busy = useRef(false);
  const signInTried = useRef(false);

  const refresh = useCallback(async () => {
    const next = await api.doctor.get(true);
    qc.setQueryData(qk.doctor, next);
    return next;
  }, [qc]);
  const login = useClaudeLogin({ onSignedIn: () => void refresh().catch(() => undefined) });

  const signIn = (r: DoctorReport) => {
    if (signInTried.current || !maySignIn || !find(r, "claude")?.ok || !missing(find(r, "claude-auth"))) return;
    signInTried.current = true;
    if (login.state !== "waiting") login.start.mutate();
  };

  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    setStarted(true);
    setRunning(true);
    setError(null);
    try {
      let r = await refresh();
      for (const id of INSTALL_ORDER) {
        // Claude Code is there: the sign-in runs in the browser while the rest installs.
        if (id !== "claude") signIn(r);
        const dep = find(r, id);
        if (!missing(dep)) continue;
        if (!dep!.installable) {
          setJobs((j) => ({ ...j, [id]: { state: "failed", output: dep!.installHint || dep!.detail } }));
          continue;
        }
        setJobs((j) => ({ ...j, [id]: { state: "installing" } }));
        const res = await api.doctor.install(id).catch((e) => ({ ok: false, output: errorMessage(e) }));
        let ok = res.ok;
        try {
          r = await refresh();
          // A check that started before the install finished may still say it is missing.
          if (res.ok && !find(r, id)?.ok) r = await refresh();
          ok = find(r, id)?.ok ?? res.ok;
        } finally {
          setJobs((j) => ({ ...j, [id]: { state: ok ? "done" : "failed", output: res.output } }));
        }
      }
      signIn(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
      setRunning(false);
    }
  };

  const allOk = !!report && ROW_IDS.every((id) => !missing(find(report, id)));
  const showBrowser = BROWSER_IDS.some((id) => find(report, id)?.required);

  const installRow = (ids: DependencyId[]): { state: RowState; job?: Job & { id: DependencyId } } => {
    const deps = ids.map((id) => find(report, id)).filter((d): d is DependencyStatus => !!d && d.required);
    if (deps.every((d) => d.ok)) return { state: "done" };
    const installing = ids.find((id) => jobs[id]?.state === "installing");
    if (installing) return { state: "active", job: { ...jobs[installing]!, id: installing } };
    const failed = ids.find((id) => jobs[id]?.state === "failed" && missing(find(report, id)));
    if (failed) return { state: "failed", job: { ...jobs[failed]!, id: failed } };
    return { state: started && running ? "waiting" : started ? "failed" : "idle" };
  };

  const claudeRow = installRow(["claude"]);
  const browserRow = installRow(BROWSER_IDS);
  const authDep = find(report, "claude-auth");
  const claudeOk = !!find(report, "claude")?.ok;
  const accountState: RowState =
    authDep?.ok || login.state === "done"
      ? "done"
      : login.state === "waiting"
        ? "active"
        : login.state === "failed"
          ? "failed"
          : !started
            ? "idle"
            : login.start.isPending || (running && maySignIn && (!claudeOk || !signInTried.current))
              ? "waiting"
              : claudeOk && maySignIn
                ? "action"
                : "failed";

  const rows = [claudeRow.state, accountState, ...(showBrowser ? [browserRow.state] : [])];
  const doneCount = rows.filter((s) => s === "done").length;
  const finished = !!report && (allOk || (started && !running && login.state !== "waiting" && !login.start.isPending));
  const first = userName.trim().split(/\s+/)[0];
  const mood = allOk ? "happy" : started && !running && !finished ? "attention" : running || login.state === "waiting" ? "working" : "idle";

  const submit = () => {
    if (!report) return;
    if (allOk) onNext(true);
    else void run();
  };

  return (
    <div>
      <div className="mb-8 flex flex-col items-start">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}
          className="flex items-center gap-4"
        >
          <Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} size={72} mood={mood} follow title="Godmode" />
          <SpeechBubble tail="left" delay={0.35} className="max-w-xs text-[14px]">
            {allOk && started
              ? t("setup.bubble.ready")
              : running || login.state === "waiting"
                ? t("setup.bubble.working")
                : first
                  ? t("setup.bubble.hiNamed", { name: first })
                  : t("setup.bubble.hi")}
          </SpeechBubble>
        </motion.div>
        <h1 className="heading-display mt-7 text-[36px] sm:text-[44px]">
          {t("setup.title")}
          <span className="block text-foreground/35">{t("setup.subtitle")}</span>
        </h1>
        <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-muted-foreground">
          {allOk && !started
            ? t("setup.introReady")
            : t("setup.intro")}
        </p>
      </div>

      <StepCard>
        <div className="space-y-2">
          <Label htmlFor="onboarding-name">{t("setup.nameLabel")}</Label>
          <div className="relative">
            <UserRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="onboarding-name"
              autoFocus
              autoComplete="given-name"
              value={userName}
              onChange={(e) => onUserName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !started) submit();
              }}
              placeholder={t("setup.namePlaceholder")}
              className="h-10 pl-9 text-[15px]"
              maxLength={60}
            />
          </div>
        </div>

        <div className="mt-6">
          {!report ? (
            doctor.isError ? (
              <div className="rounded-lg border border-destructive/25 bg-destructive/[0.05] p-4 text-sm">
                <p className="font-medium text-destructive">{t("setup.checkFailed")}</p>
                <p className="mt-1 text-muted-foreground">{errorMessage(doctor.error)}</p>
                <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => doctor.refetch()}>
                  <RotateCw /> {t("common:actions.tryAgain")}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-[62px] rounded-lg" />
                ))}
              </div>
            )
          ) : (
            <>
              {started && (
                <div className="mb-3 flex items-center gap-3" role="status" aria-live="polite">
                  <p className="min-w-0 flex-1 text-sm font-medium">
                    {allOk ? t("setup.status.ready") : finished ? t("setup.status.almost") : t("setup.status.working")}
                  </p>
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {t("setup.progress", { done: doneCount, total: rows.length })}
                  </span>
                  <div className="h-1 w-24 overflow-hidden rounded-full bg-foreground/[0.07]">
                    <motion.div
                      className={cn("h-full rounded-full", allOk ? "bg-success" : "bg-foreground")}
                      initial={false}
                      animate={{ width: `${(doneCount / rows.length) * 100}%` }}
                      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                    />
                  </div>
                </div>
              )}
              <ul className="divide-y overflow-hidden rounded-xl border bg-card">
                <SetupRow
                  icon={<Sparkles />}
                  title="Claude Code"
                  body={t("setup.rows.claude.body")}
                  state={claudeRow.state}
                  activeText={t("doctor.installing")}
                  doneText={find(report, "claude")?.version ? t("setup.installedVersion", { version: find(report, "claude")!.version }) : t("setup.installed")}
                  failure={claudeRow.job ? { output: claudeRow.job.output, hint: find(report, "claude")?.installHint } : undefined}
                  onRetry={running ? undefined : () => void run()}
                />
                <SetupRow
                  icon={<LogIn />}
                  title={t("setup.rows.account.title")}
                  body={t("setup.rows.account.body")}
                  state={accountState}
                  activeText={t("setup.rows.account.active")}
                  waitingText={claudeOk ? t("setup.rows.account.starting") : t("setup.rows.account.waitsForClaude")}
                  doneText={authDep?.ok ? authDep.detail || t("setup.signedIn") : t("setup.signedIn")}
                  actionText={t("setup.rows.account.action")}
                  failureText={
                    login.state === "failed"
                      ? login.status?.message || t("setup.rows.account.unfinished")
                      : !claudeOk
                        ? t("setup.rows.account.needsClaude")
                        : t("doctor.ownerOnly")
                  }
                  retryLabel={login.state === "failed" ? t("common:actions.tryAgain") : t("setup.rows.account.signIn")}
                  onRetry={claudeOk && maySignIn ? () => login.start.mutate() : undefined}
                  retrying={login.start.isPending}
                >
                  {accountState === "active" && <ClaudeSignInSteps login={login} className="mt-3" />}
                </SetupRow>
                {showBrowser && (
                  <SetupRow
                    icon={<Globe />}
                    title={t("setup.rows.browser.title")}
                    body={t("setup.rows.browser.body")}
                    state={browserRow.state}
                    activeText={browserRow.job?.id === "chrome" ? t("setup.rows.browser.downloading") : t("doctor.installing")}
                    doneText={t("setup.installed")}
                    failure={browserRow.job ? { output: browserRow.job.output, hint: find(report, browserRow.job.id)?.installHint } : undefined}
                    onRetry={running ? undefined : () => void run()}
                  />
                )}
              </ul>
            </>
          )}
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        </div>

        {report && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setDetails((o) => !o)}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              aria-expanded={details}
            >
              {details ? t("setup.hideDetails") : t("setup.showDetails")}
              <ChevronDown className={cn("size-3.5 transition-transform", details && "rotate-180")} />
            </button>
            <AnimatePresence initial={false}>
              {details && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                  <TechDetails report={report} />
                  <MacPermissionsSummary className="mt-3" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {(started || allOk) && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-7 space-y-2">
            <p className="text-sm font-medium">{running || login.state === "waiting" ? t("setup.lookWhileWaiting") : t("setup.look")}</p>
            <ModePicker value={mode} onChange={onMode} />
            <p className="text-xs text-muted-foreground">{t("setup.lookHint")}</p>
          </motion.div>
        )}

        {!started && !allOk ? (
          <div className="mt-7 border-t pt-6">
            <SubmitButton busy={false} disabled={!report} type="button" onClick={submit} className="h-12 text-[15px]">
              {t("setup.start")}
            </SubmitButton>
            <p className="mt-2.5 text-center text-xs text-muted-foreground">{t("setup.startHint")}</p>
          </div>
        ) : (
          <StepFooter>
            {allOk ? (
              <SubmitButton busy={false} type="button" onClick={() => onNext(true)} className="w-auto px-6">
                {t("common:actions.continue")}
              </SubmitButton>
            ) : finished ? (
              <Button type="button" variant="outline" onClick={() => onNext(false)}>
                {t("setup.continueAnyway")}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">{t("setup.keepOpen")}</p>
            )}
          </StepFooter>
        )}
        {finished && !allOk && (
          <p className="mt-3 text-right text-xs text-muted-foreground">{t("setup.finishLater")}</p>
        )}
      </StepCard>
    </div>
  );
}

function SetupRow({
  icon,
  title,
  body,
  state,
  activeText,
  waitingText,
  doneText,
  actionText,
  failure,
  failureText,
  retryLabel,
  onRetry,
  retrying,
  children,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  state: RowState;
  activeText?: string;
  waitingText?: string;
  doneText: string;
  actionText?: string;
  failure?: { output?: string; hint?: string };
  failureText?: string;
  retryLabel?: string;
  onRetry?: () => void;
  retrying?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation(["onboarding", "common"]);
  const [log, setLog] = useState(false);
  const status =
    state === "done"
      ? doneText
      : state === "active"
        ? activeText
        : state === "waiting"
          ? (waitingText ?? t("setup.waiting"))
          : state === "action"
            ? actionText
            : state === "failed"
              ? failure
                ? reason(failure.output)
                : (failureText ?? t("setup.didNotInstall"))
              : body;
  return (
    <li className={cn("px-4 py-3.5 transition-colors", state === "active" && "bg-paper-2/60", state === "failed" && "bg-destructive/[0.03]")}>
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg border transition-colors duration-300 [&_svg]:size-4",
            state === "done" && "border-transparent bg-success/[0.12] text-success",
            state === "failed" && "border-destructive/25 bg-card text-destructive",
            (state === "idle" || state === "waiting") && "bg-paper-2 text-muted-foreground",
            state === "action" && "bg-card text-foreground shadow-card",
            state === "active" && "bg-card text-foreground shadow-card",
          )}
        >
          {state === "done" ? <DrawCheck /> : state === "active" ? <Spinner /> : state === "failed" ? <CircleAlert /> : icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm font-medium tracking-[-0.01em]", state === "waiting" && "text-muted-foreground")}>{title}</p>
          <p className={cn("truncate text-xs text-muted-foreground", state === "failed" && "text-destructive/90")} title={status}>
            {status}
          </p>
        </div>
        {(state === "failed" || state === "action") && onRetry && (
          <Button type="button" size="sm" variant={state === "action" ? "default" : "outline"} onClick={onRetry} disabled={retrying}>
            {retrying ? <Spinner /> : state === "action" ? <LogIn /> : <RotateCw />} {retryLabel ?? t("common:actions.retry")}
          </Button>
        )}
      </div>
      {state === "failed" && failure && (
        <div className="mt-2 pl-12">
          <button
            type="button"
            onClick={() => setLog((o) => !o)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={log}
          >
            {log ? t("setup.hideDetails") : t("setup.showDetails")}
            <ChevronDown className={cn("size-3.5 transition-transform", log && "rotate-180")} />
          </button>
          <AnimatePresence initial={false}>
            {log && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                {failure.hint && (
                  <p className="mt-2 text-xs leading-relaxed text-foreground/85">
                    {t("setup.byHand")} <InlineCode text={failure.hint} />
                  </p>
                )}
                <pre className="mt-2 max-h-48 overflow-auto rounded-md border bg-paper-2 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/85">
                  {failure.output || t("doctor.noOutput")}
                </pre>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
      {children && <div className="pl-12">{children}</div>}
    </li>
  );
}

function TechDetails({ report }: { report: DoctorReport }) {
  const { t } = useTranslation("onboarding");
  const deps = DETAIL_IDS.map((id) => find(report, id)).filter((d): d is DependencyStatus => !!d);
  return (
    <div className="mt-2 rounded-lg border bg-paper-2 p-3">
      <p className="mb-2 font-mono text-[11px] text-muted-foreground">
        {report.platform} · {report.arch}
      </p>
      <ul className="space-y-1.5">
        {deps.map((d) => (
          <li key={d.id} className="flex items-baseline gap-2 text-xs">
            <span className={cn("size-1.5 shrink-0 translate-y-[-1px] rounded-full", d.ok ? "bg-success" : d.required ? "bg-destructive" : "bg-muted-foreground/40")} />
            <span className="w-36 shrink-0 font-medium">{d.name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={d.path ?? d.detail}>
              {d.ok ? [d.version, d.path].filter(Boolean).join("  ") || d.detail : d.detail}
              {!d.required && ` ${t("setup.optionalSuffix")}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
