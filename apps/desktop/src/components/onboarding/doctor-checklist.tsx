import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, CircleAlert, CircleCheck, CircleX, Download, RefreshCw, Terminal } from "lucide-react";
import type { DependencyId, DependencyStatus, DoctorReport } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/** "How to fix" fallbacks when the core doesn't send an install hint. */
const FIX_FALLBACK: Partial<Record<DependencyId, string>> = {
  "claude-auth": "Run `claude` once in a terminal to sign in.",
  "browser-use": "Install it with uv: `uv tool install browser-use`.",
};

/** Context shown under the fix: why it matters or an alternative. */
const DEFAULT_HINTS: Partial<Record<DependencyId, string>> = {
  "claude-auth": "Prefer an API key? Add an Anthropic key later in Integrations → API keys.",
  "browser-use": "Gives agents a real browser to work in.",
  chrome: "Used to import your existing sign-ins into Godmode's browser.",
  git: "Optional — agent memory is versioned with a built-in git implementation.",
};

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
 */
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
  const { data, isLoading, isError, error, refresh, refetch } = useDoctor();
  useEffect(() => {
    if (data) onReport?.(data);
  }, [data, onReport]);

  if (isLoading)
    return (
      <div className={cn("space-y-2", className)}>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-xl" />
        ))}
      </div>
    );
  if (isError || !data)
    return (
      <div className={cn("rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm", className)}>
        <p className="font-medium text-destructive">Could not run the system check</p>
        <p className="mt-1 text-muted-foreground">{errorMessage(error)}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
          <RefreshCw /> Try again
        </Button>
      </div>
    );

  const deps = ids ? ids.map((id) => data.dependencies.find((d) => d.id === id)).filter((d): d is DependencyStatus => !!d) : data.dependencies;
  const mergedHints = { ...DEFAULT_HINTS, ...hints };

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-2 pb-1 text-xs text-muted-foreground">
        <span>
          {data.platform} · {data.arch}
        </span>
        <Button size="xs" variant="ghost" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? <Spinner className="size-3" /> : <RefreshCw />} Re-check
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

function DependencyRow({ dep, hint, onInstalled }: { dep: DependencyStatus; hint?: string; onInstalled: () => void }) {
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
    },
  });

  const state: "ok" | "warn" | "error" = dep.ok ? "ok" : dep.required ? "error" : "warn";
  const Icon = state === "ok" ? CircleCheck : state === "error" ? CircleX : CircleAlert;

  return (
    <div
      className={cn(
        "rounded-xl border bg-card/60 p-3.5 transition-colors",
        state === "error" && "border-destructive/30",
        state === "warn" && "border-warning/30",
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
              <Badge variant="outline" className="h-5 text-[10px] font-normal text-muted-foreground">
                optional
              </Badge>
            )}
          </div>
          {dep.detail && <p className="mt-0.5 text-xs text-muted-foreground">{dep.detail}</p>}
          {dep.path && dep.ok && <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">{dep.path}</p>}
          {!dep.ok && (dep.installHint || FIX_FALLBACK[dep.id]) && (
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
                className="mt-2 max-h-56 overflow-auto rounded-lg border bg-black/80 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-200"
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

/** Renders `backtick` spans as inline code. */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
