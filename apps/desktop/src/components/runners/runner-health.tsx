import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Download, ExternalLink, RefreshCw, RotateCw, ShieldCheck, Sparkles, Terminal, WifiOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import type { RemoteRunner, RunnerCheck, RunnerCheckGroup, RunnerFixKind } from "@godmode/shared";
import { InlineCode } from "@/components/onboarding/doctor-checklist";
import { timeAgo } from "@/components/ssh/ssh-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useNow } from "@/components/vault/use-now";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { CHECK_COLOR, CHECK_ICON, blockingChecks, checkTone, type CheckTone } from "./runner-parts";
import type { RunnerActions } from "./use-runner-actions";

const GROUPS: { id: RunnerCheckGroup; title: string }[] = [
  { id: "software", title: "Software" },
  { id: "permissions", title: "Permissions" },
  { id: "access", title: "Access" },
  { id: "system", title: "System" },
];
const KNOWN_GROUPS = new Set<string>(GROUPS.map((g) => g.id));

/** A runner installs what it needs by itself the first time it starts; for this long after pairing a missing tool counts as "on its way". */

const FIX: Record<Exclude<RunnerFixKind, "manual">, { icon: LucideIcon; pending: string }> = {
  install: { icon: Download, pending: "Installing…" },
  request: { icon: ShieldCheck, pending: "Asking…" },
  "open-settings": { icon: ExternalLink, pending: "Opening…" },
  sync: { icon: RefreshCw, pending: "Copying…" },
  restart: { icon: RotateCw, pending: "Restarting…" },
};

const TONE_LABEL: Record<CheckTone, string> = { ok: "OK", warn: "Warning", fail: "Needs fixing", unknown: "Unknown" };

/** Fixes that finish on the runner by themselves or by a click there: worth looking again soon. */
const SETTLING = new Set<RunnerFixKind>(["install", "request", "open-settings", "restart"]);

/**
 * The health report of a runner. The first answer is the runner's last result (instant), every later one runs the
 * checks again. While software is being installed or a permission waits for a click on the runner they repeat every
 * 5 seconds, so the progress shows without a click; while only something the human must do on the runner blocks it
 * (a sign-in), every 30 seconds — every look runs the runner's whole check suite.
 */
export function useRunnerHealth(runner: Pick<RemoteRunner, "id" | "state">, { enabled = true }: { enabled?: boolean } = {}) {
  const qc = useQueryClient();
  const key = qk.runnerHealth(runner.id);
  return useQuery({
    queryKey: key,
    queryFn: () => api.runners.health(runner.id, qc.getQueryData(key) !== undefined),
    enabled: enabled && runner.state === "online",
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      if (data.installing?.length) return 5_000;
      const blocking = blockingChecks(data);
      if (!blocking.length) return false;
      return blocking.some((c) => c.fix && SETTLING.has(c.fix.kind)) ? 5_000 : 30_000;
    },
    retry: false,
  });
}

/** Checks of a runner grouped Software / Permissions / Access / System, each with its fix, and "Fix with Claude" for the rest. */
export function RunnerHealthPanel({ runner, actions, className }: { runner: RemoteRunner; actions: RunnerActions; className?: string }) {
  const health = useRunnerHealth(runner);
  // Keeps "checked … ago" current.
  useNow(5000);
  const online = runner.state === "online";
  const checking = actions.isBusy("health", runner.id);
  const repairing = actions.isBusy("autofix", runner.id);
  const data = health.data;

  if (!data) {
    if (!online) {
      return (
        <div className={cn("flex items-start gap-2.5 text-xs text-muted-foreground", className)}>
          <WifiOff className="mt-px size-3.5 shrink-0" aria-hidden />
          <p className="min-w-0 leading-relaxed">
            <span className="font-medium text-foreground">{runner.name} isn't connected,</span> so Godmode can't look at it. The checks run as soon as it's back.
          </p>
        </div>
      );
    }
    if (health.isError) {
      return (
        <div className={cn("rounded-lg border border-destructive/25 bg-destructive/[0.05] p-3.5 text-sm", className)} role="alert">
          <p className="font-medium text-destructive">Couldn't check {runner.name}</p>
          <p className="mt-1 text-xs leading-relaxed break-words text-muted-foreground">{errorMessage(health.error)}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void health.refetch()} disabled={health.isFetching}>
            {health.isFetching ? <Spinner /> : <RefreshCw />} Try again
          </Button>
        </div>
      );
    }
    return (
      <div className={cn("space-y-2", className)} aria-busy aria-label={`Checking ${runner.name}`}>
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-10 rounded-lg" />
        ))}
      </div>
    );
  }

  const isInstalling = (c: RunnerCheck) => online && c.status !== "ok" && (data.installing ?? []).includes(c.id);
  const blocking = blockingChecks(data);
  const installing = blocking.filter(isInstalling).length;
  const warnings = data.checks.filter((c) => checkTone(c) === "warn").length;
  const groupOf = (c: RunnerCheck): RunnerCheckGroup => (KNOWN_GROUPS.has(c.group) ? c.group : "system");

  const count = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("%", String(n)));
  // One sentence: can it work, and if not, how much is in the way.
  const headline: { tone: CheckTone | "busy" | "offline"; text: string } = !online
    ? { tone: "offline", text: `${runner.name} isn't connected — this is how it looked ${timeAgo(data.checkedAt)}.` }
    : blocking.length > 0 && installing === blocking.length
      ? { tone: "busy", text: count(installing, "Setting up — 1 thing is still being installed", "Setting up — % things are still being installed") }
      : blocking.length > 0
        ? { tone: "fail", text: count(blocking.length, `1 thing to fix before ${runner.name} can work`, `% things to fix before ${runner.name} can work`) }
        : warnings > 0
          ? { tone: "warn", text: count(warnings, "Ready to work — 1 thing to look at when you have a minute", "Ready to work — % things to look at when you have a minute") }
          : { tone: "ok", text: "Ready to work — everything is in order" };
  const HeadIcon = headline.tone === "busy" ? null : headline.tone === "offline" ? WifiOff : CHECK_ICON[headline.tone];
  const headColor = headline.tone === "busy" || headline.tone === "offline" ? "text-muted-foreground" : CHECK_COLOR[headline.tone];

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-[13px] font-medium" aria-live="polite">
          {HeadIcon ? <HeadIcon className={cn("mt-0.5 size-4 shrink-0", headColor)} aria-hidden /> : <Spinner className={cn("mt-0.5 size-4 shrink-0", headColor)} aria-hidden />}
          <span className="min-w-0">{headline.text}</span>
        </p>
        <div className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          {online && <span>{blocking.length > 0 ? "Checks again by itself" : `Checked ${timeAgo(data.checkedAt)}`}</span>}
          <Button size="xs" variant="ghost" onClick={() => actions.checkHealth.mutate(runner)} disabled={!online || checking}>
            {checking ? <Spinner className="size-3" /> : <RefreshCw />} Check again
          </Button>
        </div>
      </div>

      {GROUPS.map((group) => {
        const checks = data.checks.filter((c) => groupOf(c) === group.id);
        if (checks.length === 0) return null;
        const asksOnScreen = group.id === "permissions" && checks.some((c) => c.status !== "ok");
        return (
          <section key={group.id} aria-label={group.title}>
            <h4 className="eyebrow mb-1.5 text-[10.5px]">{group.title}</h4>
            {asksOnScreen && (
              <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
                Godmode can ask for these, but macOS shows the question on {runner.name}'s own screen — someone has to click Allow there, or through macOS Screen
                Sharing. Nobody can grant them from here.
              </p>
            )}
            <div className={cn("divide-y overflow-hidden rounded-lg border bg-card", !online && "opacity-70")}>
              {checks.map((check) => (
                <CheckRow key={check.id} runner={runner} check={check} installing={isInstalling(check)} readOnly={!online} />
              ))}
            </div>
          </section>
        );
      })}

      {online && (blocking.length > 0 || warnings > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-paper-2 px-3.5 py-3">
          <p className="min-w-0 flex-1 basis-56 text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Rather not do this yourself?</span> Claude reads {runner.name}'s log, repairs what it can and tells you exactly what
            only you can do.
          </p>
          <Button size="sm" variant="outline" disabled={repairing} onClick={() => actions.autofix.mutate({ runner })}>
            {repairing ? <Spinner /> : <Sparkles />} Fix with Claude
          </Button>
        </div>
      )}
    </div>
  );
}

function fixToast(runner: RemoteRunner, check: RunnerCheck, kind: Exclude<RunnerFixKind, "manual">, ok: boolean) {
  // Asking for a permission only asks: until someone clicks Allow on the runner, the answer is "not yet", not a failure.
  if (!ok && kind !== "request") return void toast.error(`Couldn't fix “${check.name}” on ${runner.name}`, { description: "See the output for details." });
  switch (kind) {
    case "install":
      return void toast.success(`${check.name} installed on ${runner.name}`);
    case "request":
      return void toast.success(`Asked on ${runner.name}'s screen`, { description: "macOS shows the question there — click Allow, then check again." });
    case "open-settings":
      return void toast.success(`System Settings is open on ${runner.name}`, { description: "Turn Godmode on in the list there, then check again." });
    case "sync":
      return void toast.success(`Setup copied to ${runner.name}`);
    case "restart":
      return void toast.success(`${check.name} restarted on ${runner.name}`);
  }
}

function CheckRow({ runner, check, installing, readOnly }: { runner: RemoteRunner; check: RunnerCheck; installing: boolean; readOnly: boolean }) {
  const qc = useQueryClient();
  const [log, setLog] = useState<{ ok: boolean; output: string } | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const tone = checkTone(check);
  const kind = check.fix?.kind;
  const action = kind && kind !== "manual" ? FIX[kind] : null;

  const fix = useMutation({
    mutationFn: () => api.runners.fix(runner.id, check.id),
    onSuccess: async (res) => {
      const asked = kind === "request";
      setLog({ ok: res.ok || asked, output: res.output });
      setLogOpen(!res.ok && !asked);
      // A repeating check that started before the fix must not put the older report back.
      await qc.cancelQueries({ queryKey: qk.runnerHealth(runner.id) });
      qc.setQueryData(qk.runnerHealth(runner.id), res.health);
      if (kind && kind !== "manual") fixToast(runner, check, kind, res.ok);
    },
    onError: (e) => {
      setLog({ ok: false, output: errorMessage(e) });
      setLogOpen(true);
    },
  });

  if (tone === "ok" && !log) {
    const Icon = CHECK_ICON.ok;
    return (
      <div className="flex items-center gap-3 px-3.5 py-2">
        <Icon className={cn("size-4 shrink-0", CHECK_COLOR.ok)} aria-label={TONE_LABEL.ok} />
        <span className="shrink-0 text-[13px]">{check.name}</span>
        <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground" title={check.detail}>
          {check.detail}
        </span>
      </div>
    );
  }

  const Icon = CHECK_ICON[tone];
  const needsFix = tone === "fail" || tone === "warn";
  const FixIcon = action?.icon;
  return (
    <div className="px-3.5 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        {installing || fix.isPending ? (
          <Spinner className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Working on it" />
        ) : (
          <Icon className={cn("mt-0.5 size-4 shrink-0", CHECK_COLOR[tone])} aria-label={TONE_LABEL[tone]} />
        )}
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[13px] font-medium">{check.name}</span>
            {!check.required && needsFix && (
              <Badge variant="outline" className="h-5 rounded-[5px] text-[10px] font-normal text-muted-foreground">
                optional
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed break-words text-muted-foreground">
            {installing ? "Being installed — a runner sets itself up the first time it starts." : check.detail}
          </p>
          {needsFix && !installing && check.fix && (check.fix.hint || kind === "manual") && (
            <p className="mt-1.5 text-xs leading-relaxed break-words text-foreground/85">
              <InlineCode text={check.fix.hint ?? check.fix.label} />
            </p>
          )}
        </div>
        {needsFix && !installing && !readOnly && action && FixIcon && check.fix && (
          <Button size="sm" variant={tone === "fail" ? "default" : "outline"} onClick={() => fix.mutate()} disabled={fix.isPending}>
            {fix.isPending ? <Spinner /> : <FixIcon />}
            {fix.isPending ? action.pending : check.fix.label}
          </Button>
        )}
      </div>
      {log && (
        <div className="mt-2.5 pl-7">
          <button
            type="button"
            onClick={() => setLogOpen((o) => !o)}
            className="flex items-center gap-1.5 rounded-sm text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            aria-expanded={logOpen}
          >
            <Terminal className="size-3.5" />
            {log.ok ? "Show what happened" : "That didn't work — show the output"}
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
