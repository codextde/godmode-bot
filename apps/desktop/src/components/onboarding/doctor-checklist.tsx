import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
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
const FIX_FALLBACK: Partial<Record<DependencyId, string>> = {
  "browser-use": "Install it with uv: `uv tool install browser-use`.",
};

/** Context shown under the fix: why it matters or an alternative. */
const DEFAULT_HINTS: Partial<Record<DependencyId, string>> = {
  "claude-auth": "Prefer an API key? Add an Anthropic key later in Integrations → API keys.",
  "browser-use": "Gives agents a real browser to work in.",
  chrome: "Used to import your existing sign-ins into Godmode's browser.",
  git: "Optional — agent memory is versioned with a built-in git implementation.",
};

/** Installed one after another without a click (uv before what needs it). */
const AUTO_INSTALL: DependencyId[] = ["claude", "uv", "browser-use", "chrome"];

export function useDoctor() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: qk.doctor, queryFn: () => api.doctor.get(false), staleTime: 60_000 });
  const refresh = useMutation({
    mutationFn: () => api.doctor.get(true),
    onSuccess: (report) => qc.setQueryData(qk.doctor, report),
    onError: (e) => toast.error("Check failed", { description: errorMessage(e) }),
  });
  return { ...query, refresh };
}

/**
 * Dependency checklist (claude, claude-auth, uv, browser-use, chrome, git) with one-click installs.
 * Used by onboarding (system check step) and Settings → System.
 * With `auto`, missing required tools install by themselves and the Claude sign-in starts once Claude Code is there.
 */
export function DoctorChecklist({
  ids,
  hints,
  className,
  onReport,
  auto = false,
}: {
  /** Order + filter. Defaults to every dependency in the report. */
  ids?: DependencyId[];
  hints?: Partial<Record<DependencyId, string>>;
  className?: string;
  onReport?: (report: DoctorReport) => void;
  auto?: boolean;
}) {
  const { data, isLoading, isError, error, refresh, refetch } = useDoctor();
  const [tried, setTried] = useState<DependencyId[]>([]);
  const attempt = (id: DependencyId) => setTried((t) => (t.includes(id) ? t : [...t, id]));
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
        <p className="font-medium text-destructive">Could not run the system check</p>
        <p className="mt-1 text-muted-foreground">{errorMessage(error)}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
          <RefreshCw /> Try again
        </Button>
      </div>
    );

  const deps = ids ? ids.map((id) => data.dependencies.find((d) => d.id === id)).filter((d): d is DependencyStatus => !!d) : data.dependencies;
  const mergedHints = { ...DEFAULT_HINTS, ...hints };
  const missing = (id: DependencyId) => data.dependencies.find((d) => d.id === id && d.required && !d.ok);
  const autoTarget =
    auto && !refresh.isPending ? AUTO_INSTALL.find((id) => missing(id)?.installable && !tried.includes(id) && deps.some((d) => d.id === id)) : undefined;
  const autoSignIn = auto && !refresh.isPending && !autoTarget && !missing("claude") && !tried.includes("claude-auth");

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2 pb-1 text-xs text-muted-foreground">
        <span className="font-mono text-[11px]">
          {data.platform} · {data.arch}
        </span>
        <Button size="xs" variant="ghost" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? <Spinner className="size-3" /> : <RefreshCw />} Re-check
        </Button>
      </div>
      {deps.map((dep, i) => (
        <motion.div key={dep.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
          <DependencyRow
            dep={dep}
            hint={mergedHints[dep.id]}
            onInstalled={() => refresh.mutate()}
            auto={dep.id === "claude-auth" ? autoSignIn : dep.id === autoTarget}
            onAuto={() => attempt(dep.id)}
          />
        </motion.div>
      ))}
    </div>
  );
}

function DependencyRow({
  dep,
  hint,
  onInstalled,
  auto = false,
  onAuto,
}: {
  dep: DependencyStatus;
  hint?: string;
  onInstalled: () => void;
  /** Start the install (or the Claude sign-in) without a click. */
  auto?: boolean;
  onAuto?: () => void;
}) {
  const [log, setLog] = useState<{ ok: boolean; output: string } | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const install = useMutation({
    mutationFn: () => api.doctor.install(dep.id),
    onSuccess: (res) => {
      setLog(res);
      setLogOpen(!res.ok);
      if (res.ok) toast.success(`${dep.name} installed`);
      else toast.error(`Installing ${dep.name} failed`, { description: "See the log for details." });
      onInstalled();
    },
    onError: (e) => {
      setLog({ ok: false, output: errorMessage(e) });
      setLogOpen(true);
      onInstalled();
    },
  });
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!auto || autoStarted.current || dep.id === "claude-auth" || dep.ok) return;
    autoStarted.current = true;
    onAuto?.();
    install.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

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
          aria-label={state === "ok" ? "OK" : "Missing"}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{dep.name}</span>
            {dep.version && <span className="font-mono text-xs text-muted-foreground">{dep.version}</span>}
            {!dep.required && (
              <Badge variant="outline" className="h-5 rounded-[5px] text-[10px] font-normal text-muted-foreground">
                optional
              </Badge>
            )}
          </div>
          {dep.detail && <p className="mt-0.5 text-xs text-muted-foreground">{dep.detail}</p>}
          {dep.path && dep.ok && <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">{dep.path}</p>}
          {!dep.ok && dep.id === "claude-auth" && <ClaudeSignIn onDone={onInstalled} auto={auto} onAuto={onAuto} />}
          {!dep.ok && dep.id !== "claude-auth" && (dep.installHint || FIX_FALLBACK[dep.id]) && (
            <p className="mt-1.5 text-xs leading-relaxed text-foreground/85">
              <InlineCode text={dep.installHint || FIX_FALLBACK[dep.id]!} />
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
            {install.isPending ? "Installing…" : "Install"}
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
            {log.ok ? "Install log" : "Install failed — show log"}
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
                {log.output || "(no output)"}
              </motion.pre>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

/** Signs Claude Code in from Godmode: the browser opens, the person approves, the row turns green by itself. */
function ClaudeSignIn({ onDone, auto = false, onAuto }: { onDone: () => void; auto?: boolean; onAuto?: () => void }) {
  const login = useClaudeLogin({ onSignedIn: onDone });
  const { status: data, state, start } = login;
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!auto || !data || autoStarted.current) return;
    autoStarted.current = true;
    onAuto?.();
    if (data.state === "idle" && maySignIn) start.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, data]);

  if (state === "done")
    return (
      <p className="mt-2.5 flex items-center gap-2 text-xs font-medium text-success">
        <CircleCheck className="size-3.5" /> Signed in. Checking…
      </p>
    );

  if (state === "waiting") return <ClaudeSignInSteps login={login} className="mt-2.5" />;

  if (!maySignIn) return <p className="mt-2.5 text-xs text-muted-foreground">Only the owner of this computer can sign Claude in.</p>;

  return (
    <div className="mt-2.5 space-y-2">
      {state === "failed" && data?.message && <p className="text-xs text-destructive">{data.message}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
          {start.isPending ? <Spinner /> : <LogIn />}
          {state === "failed" ? "Try again" : data?.signedOut ? "Sign in again" : "Sign in to Claude"}
        </Button>
        <span className="text-xs text-muted-foreground">{signsInFromAfar ? "Opens the sign-in page here." : "Opens your browser."} Works with a Claude Pro or Max plan.</span>
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
