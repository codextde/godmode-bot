import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ChevronDown, CircleAlert, CircleCheck, CircleX, Download, LogIn, RefreshCw, Terminal } from "lucide-react";
import type { DependencyId, DependencyStatus, DoctorReport } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ClaudeSignInSteps, maySignIn, signsInFromAfar, useClaudeLogin } from "./claude-sign-in";

/** "How to fix" fallbacks when the core doesn't send an install hint. */
const FIX_FALLBACK = {
  "browser-use": "doctor.fix.browserUse",
} as const satisfies Partial<Record<DependencyId, string>>;

/** Context shown under the fix: why it matters or an alternative. */
const DEFAULT_HINTS = {
  "claude-auth": "doctor.hints.claudeAuth",
  "browser-use": "doctor.hints.browserUse",
  chrome: "doctor.hints.chrome",
  git: "doctor.hints.git",
} as const satisfies Partial<Record<DependencyId, string>>;

const fixFallback = (id: DependencyId) => (id in FIX_FALLBACK ? FIX_FALLBACK[id as keyof typeof FIX_FALLBACK] : undefined);

export function useDoctor() {
  const { t } = useTranslation("onboarding");
  const qc = useQueryClient();
  const query = useQuery({ queryKey: qk.doctor, queryFn: () => api.doctor.get(false), staleTime: 60_000 });
  const refresh = useMutation({
    mutationFn: () => api.doctor.get(true),
    onSuccess: (report) => qc.setQueryData(qk.doctor, report),
    onError: (e) => toast.error(t("doctor.checkFailed"), { description: errorMessage(e) }),
  });
  return { ...query, refresh };
}

/** Dependency checklist (claude, claude-auth, uv, browser-use, chrome, git) with one-click installs, for Settings → System. */
export function DoctorChecklist({
  ids,
  hints,
  className,
  onReport,
}: {
  /** Order + filter. Defaults to every dependency in the report. */
  ids?: DependencyId[];
  hints?: Partial<Record<DependencyId, string>>;
  className?: string;
  onReport?: (report: DoctorReport) => void;
}) {
  const { t } = useTranslation(["onboarding", "common"]);
  const { data, isLoading, isError, error, refresh, refetch } = useDoctor();
  useEffect(() => {
    if (data) onReport?.(data);
  }, [data, onReport]);

  if (isLoading)
    return (
      <div className={cn("space-y-2", className)}>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  if (isError || !data)
    return (
      <div className={cn("rounded-lg border border-destructive/25 bg-destructive/[0.05] p-4 text-sm", className)}>
        <p className="font-medium text-destructive">{t("doctor.runFailed")}</p>
        <p className="mt-1 text-muted-foreground">{errorMessage(error)}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
          <RefreshCw /> {t("common:actions.tryAgain")}
        </Button>
      </div>
    );

  const deps = ids ? ids.map((id) => data.dependencies.find((d) => d.id === id)).filter((d): d is DependencyStatus => !!d) : data.dependencies;
  const defaults: Partial<Record<DependencyId, string>> = Object.fromEntries(Object.entries(DEFAULT_HINTS).map(([id, key]) => [id, t(key)]));
  const mergedHints = { ...defaults, ...hints };

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2 pb-1 text-xs text-muted-foreground">
        <span className="font-mono text-[11px]">
          {data.platform} · {data.arch}
        </span>
        <Button size="xs" variant="ghost" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? <Spinner className="size-3" /> : <RefreshCw />} {t("doctor.recheck")}
        </Button>
      </div>
      {deps.map((dep, i) => (
        <motion.div key={dep.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
          <DependencyRow dep={dep} hint={mergedHints[dep.id]} onInstalled={() => refresh.mutate()} />
        </motion.div>
      ))}
    </div>
  );
}

function DependencyRow({
  dep,
  hint,
  onInstalled,
}: {
  dep: DependencyStatus;
  hint?: string;
  onInstalled: () => void;
}) {
  const { t } = useTranslation(["onboarding", "common"]);
  const [log, setLog] = useState<{ ok: boolean; output: string } | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const install = useMutation({
    mutationFn: () => api.doctor.install(dep.id),
    onSuccess: (res) => {
      setLog(res);
      setLogOpen(!res.ok);
      if (res.ok) toast.success(t("doctor.installed", { name: dep.name }));
      else toast.error(t("doctor.installFailed", { name: dep.name }), { description: t("doctor.seeLog") });
      onInstalled();
    },
    onError: (e) => {
      setLog({ ok: false, output: errorMessage(e) });
      setLogOpen(true);
      onInstalled();
    },
  });

  const state: "ok" | "warn" | "error" = dep.ok ? "ok" : dep.required ? "error" : "warn";
  const Icon = state === "ok" ? CircleCheck : state === "error" ? CircleX : CircleAlert;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3.5 transition-colors",
        state === "error" && "border-destructive/25",
        state === "warn" && "border-warning/25",
      )}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={cn(
            "mt-0.5 size-5 shrink-0",
            state === "ok" && "text-success",
            state === "warn" && "text-warning",
            state === "error" && "text-destructive",
          )}
          aria-label={state === "ok" ? t("doctor.ok") : t("doctor.missing")}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{dep.name}</span>
            {dep.version && <span className="font-mono text-xs text-muted-foreground">{dep.version}</span>}
            {!dep.required && (
              <Badge variant="outline" className="h-5 rounded-[5px] text-[10px] font-normal text-muted-foreground">
                {t("common:words.optional")}
              </Badge>
            )}
          </div>
          {dep.detail && <p className="mt-0.5 text-xs text-muted-foreground">{dep.detail}</p>}
          {dep.path && dep.ok && <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">{dep.path}</p>}
          {!dep.ok && dep.id === "claude-auth" && <ClaudeSignIn onDone={onInstalled} />}
          {!dep.ok && dep.id !== "claude-auth" && (dep.installHint || fixFallback(dep.id)) && (
            <p className="mt-1.5 text-xs leading-relaxed text-foreground/85">
              <InlineCode text={dep.installHint || t(fixFallback(dep.id)!)} />
            </p>
          )}
          {!dep.ok && hint && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              <InlineCode text={hint} />
            </p>
          )}
        </div>
        {!dep.ok && dep.installable && (
          <Button size="sm" variant={dep.required ? "default" : "outline"} onClick={() => install.mutate()} disabled={install.isPending}>
            {install.isPending ? <Spinner /> : <Download />}
            {install.isPending ? t("doctor.installing") : t("doctor.install")}
          </Button>
        )}
      </div>
      {log && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setLogOpen((o) => !o)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={logOpen}
          >
            <Terminal className="size-3.5" />
            {log.ok ? t("doctor.installLog") : t("doctor.installFailedShowLog")}
            <ChevronDown className={cn("size-3.5 transition-transform", logOpen && "rotate-180")} />
          </button>
          <AnimatePresence initial={false}>
            {logOpen && (
              <motion.pre
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="mt-2 max-h-56 overflow-auto rounded-md border bg-paper-2 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/85"
              >
                {log.output || t("doctor.noOutput")}
              </motion.pre>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

/** Signs Claude Code in from Godmode: the browser opens, the person approves, the row turns green by itself. */
function ClaudeSignIn({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation(["onboarding", "common"]);
  const login = useClaudeLogin({ onSignedIn: onDone });
  const { status: data, state, start } = login;

  if (state === "done")
    return (
      <p className="mt-2.5 flex items-center gap-2 text-xs font-medium text-success">
        <CircleCheck className="size-3.5" /> {t("doctor.signedInChecking")}
      </p>
    );

  if (state === "waiting") return <ClaudeSignInSteps login={login} className="mt-2.5" />;

  if (!maySignIn) return <p className="mt-2.5 text-xs text-muted-foreground">{t("doctor.ownerOnly")}</p>;

  return (
    <div className="mt-2.5 space-y-2">
      {state === "failed" && data?.message && <p className="text-xs text-destructive">{data.message}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
          {start.isPending ? <Spinner /> : <LogIn />}
          {state === "failed" ? t("common:actions.tryAgain") : data?.signedOut ? t("doctor.signInAgain") : t("doctor.signIn")}
        </Button>
        <span className="text-xs text-muted-foreground">{signsInFromAfar ? t("doctor.opensHere") : t("doctor.opensBrowser")}</span>
      </div>
    </div>
  );
}

/** Renders `backtick` spans as inline code. */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="rounded-[4px] bg-secondary px-1 py-0.5 font-mono text-[0.92em]">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
