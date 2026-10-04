import { useEffect, useRef, useState, type ReactNode } from "react";
import { format } from "date-fns";
import { Check, ChevronDown, CircleAlert, CircleCheck, CircleDashed, CircleX, Copy, SquareTerminal, TriangleAlert, WifiOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import type { RemoteRunner, RunnerCheck, RunnerHealth, RunnerHealthSummary, RunnerState } from "@godmode/shared";
import { LiveDot } from "@/components/aicss/Motion";
import { copyText } from "@/components/chat/copy-button";
import { timeAgo } from "@/components/ssh/ssh-parts";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isMac } from "@/lib/desktop";
import { cn } from "@/lib/utils";

/** What the computer the human sits at is called in "run on" choices — and inside a sentence. */
export const THIS_COMPUTER = isMac ? "This Mac" : "This computer";
export const THIS_COMPUTER_INLINE = isMac ? "this Mac" : "this computer";

/* ------------------------------------------------------------------ */
/* Connection                                                           */
/* ------------------------------------------------------------------ */

export const RUNNER_STATE_LABEL: Record<RunnerState, string> = {
  online: "Online",
  connecting: "Connecting…",
  offline: "Offline",
  update_required: "Update needed",
};

/** Small dot for pickers and pills: green while connected, pulsing while dialing, amber when the versions differ. */
export function RunnerStateDot({ state, className }: { state: RunnerState; className?: string }) {
  if (state === "online") return <LiveDot live={false} className={cn("size-1.5 bg-brand", className)} />;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        state === "connecting" ? "animate-pulse bg-brand/60" : state === "update_required" ? "bg-warning" : "bg-muted-foreground/45",
        className,
      )}
    />
  );
}

const STATE_BADGE: Record<RunnerState, string> = {
  online: "border-brand/25 bg-brand-soft text-brand-strong",
  connecting: "border-border bg-secondary text-foreground",
  offline: "border-destructive/25 bg-destructive/[0.06] text-destructive",
  update_required: "border-warning/30 bg-warning/[0.07] text-warning",
};

export function RunnerStateBadge({ runner, className }: { runner: Pick<RemoteRunner, "state" | "latencyMs" | "lastSeenAt">; className?: string }) {
  const { state } = runner;
  const seen = state !== "online" && runner.lastSeenAt ? runner.lastSeenAt : null;
  const badge = (
    <span
      tabIndex={seen ? 0 : undefined}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[5px] border px-1.5 text-[11px] font-medium whitespace-nowrap outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3",
        STATE_BADGE[state],
        className,
      )}
    >
      {state === "online" ? (
        <LiveDot live={false} className="size-1.5 bg-brand" />
      ) : state === "connecting" ? (
        <Spinner className="size-3" aria-hidden />
      ) : state === "offline" ? (
        <WifiOff aria-hidden />
      ) : (
        <TriangleAlert aria-hidden />
      )}
      {RUNNER_STATE_LABEL[state]}
      {state === "online" && runner.latencyMs !== null && <span className="font-normal tabular-nums opacity-75">· {runner.latencyMs} ms</span>}
    </span>
  );
  if (!seen) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>Last online {format(new Date(seen), "PPp")}</TooltipContent>
    </Tooltip>
  );
}

const OS_NAME: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

/** "macOS · Apple silicon"; null until the runner has connected once and said what it is. */
export function runnerPlatform(runner: Pick<RemoteRunner, "platform" | "arch">): string | null {
  if (!runner.platform) return null;
  const os = OS_NAME[runner.platform] ?? runner.platform;
  const chip = runner.platform !== "darwin" ? runner.arch : runner.arch === "arm64" ? "Apple silicon" : runner.arch === "x64" ? "Intel" : runner.arch;
  return chip ? `${os} · ${chip}` : os;
}

/** Where the link goes: the address it is connected through, else the first one Godmode tries (IPv6 in brackets). */
export function runnerEndpoint(runner: Pick<RemoteRunner, "address" | "addresses" | "port">): string | null {
  const host = runner.address ?? runner.addresses[0];
  if (!host) return null;
  return `${host.includes(":") ? `[${host}]` : host}:${runner.port}`;
}

/** "3 chats · 1 working" */
export function runnerWorkLine(runner: Pick<RemoteRunner, "conversations" | "activeRuns">): string {
  const chats = runner.conversations === 0 ? "No chats yet" : runner.conversations === 1 ? "1 chat" : `${runner.conversations} chats`;
  return runner.activeRuns > 0 ? `${chats} · ${runner.activeRuns} working` : chats;
}

/** Whether the setup (agents, logins, integrations, settings) on the runner matches this computer's. */
export function runnerSyncLine(runner: Pick<RemoteRunner, "sync" | "state">): { text: string; tone: "muted" | "busy" | "error" } {
  const { state, syncedAt } = runner.sync;
  if (state === "syncing") return { text: "Copying your setup…", tone: "busy" };
  if (state === "failed") return { text: "Setup not copied", tone: "error" };
  if (state === "pending") return { text: runner.state === "online" ? "Setup changes waiting to be copied" : "Setup is copied when it's back", tone: "muted" };
  return { text: syncedAt ? `Setup copied ${timeAgo(syncedAt)}` : "Setup copied", tone: "muted" };
}

/* ------------------------------------------------------------------ */
/* Health                                                               */
/* ------------------------------------------------------------------ */

export type CheckTone = "ok" | "warn" | "fail" | "unknown";

/** What a check means for the work: only a failing required check blocks it, everything else that isn't fine is a warning. */
export function checkTone(check: Pick<RunnerCheck, "status" | "required">): CheckTone {
  if (check.status === "ok" || check.status === "unknown") return check.status;
  return check.status === "fail" && check.required ? "fail" : "warn";
}

export const CHECK_ICON: Record<CheckTone, LucideIcon> = { ok: CircleCheck, warn: CircleAlert, fail: CircleX, unknown: CircleDashed };
export const CHECK_COLOR: Record<CheckTone, string> = { ok: "text-success", warn: "text-warning", fail: "text-destructive", unknown: "text-muted-foreground" };

/** The checks that keep the runner from working. */
export function blockingChecks(health: RunnerHealth): RunnerCheck[] {
  return health.checks.filter((c) => checkTone(c) === "fail");
}

function summarize(health: RunnerHealth): RunnerHealthSummary {
  const tones = health.checks.map(checkTone);
  const failing = tones.filter((t) => t === "fail").length;
  return { ok: failing === 0, failing, warnings: tones.filter((t) => t === "warn").length, checkedAt: health.checkedAt };
}

/** The newer of the summary the runner list carries and a full report loaded on this screen. */
export function latestSummary(summary: RunnerHealthSummary | null, health: RunnerHealth | undefined): RunnerHealthSummary | null {
  if (!health) return summary;
  return summary && summary.checkedAt > health.checkedAt ? summary : summarize(health);
}

export function healthTone(summary: RunnerHealthSummary | null): CheckTone {
  if (!summary) return "unknown";
  return summary.failing > 0 ? "fail" : summary.warnings > 0 ? "warn" : "ok";
}

export function healthLabel(summary: RunnerHealthSummary | null): string {
  if (!summary) return "Not checked yet";
  if (summary.failing > 0) return `${summary.failing} to fix`;
  if (summary.warnings > 0) return summary.warnings === 1 ? "1 warning" : `${summary.warnings} warnings`;
  return "All good";
}

const HEALTH_PILL: Record<CheckTone, string> = {
  ok: "border-success/25 bg-success/[0.06] text-success",
  warn: "border-warning/30 bg-warning/[0.07] text-warning",
  fail: "border-destructive/25 bg-destructive/[0.06] text-destructive",
  unknown: "border-border bg-secondary text-muted-foreground",
};

/**
 * "All good" / "2 to fix" / "1 warning". With `onClick` it is the button that opens the checks. `stale`: the runner is
 * away, so what was found last time is no statement about now.
 */
export function HealthPill({
  summary,
  checking,
  stale,
  expanded,
  controls,
  onClick,
  className,
}: {
  summary: RunnerHealthSummary | null;
  checking?: boolean;
  stale?: boolean;
  expanded?: boolean;
  /** Id of the panel the pill opens. */
  controls?: string;
  onClick?: () => void;
  className?: string;
}) {
  const tone = stale ? "unknown" : healthTone(summary);
  const Icon = CHECK_ICON[tone];
  const cls = cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium whitespace-nowrap [&_svg]:size-3", HEALTH_PILL[tone], className);
  const content = (
    <>
      {checking ? <Spinner className="size-3" aria-hidden /> : <Icon aria-hidden />}
      {checking ? "Checking…" : stale && summary ? "Last checks" : healthLabel(summary)}
      {onClick && <ChevronDown aria-hidden className={cn("opacity-60 transition-transform", expanded && "rotate-180")} />}
    </>
  );
  if (!onClick) return <span className={cls}>{content}</span>;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onClick}
      className={cn(cls, "transition outline-none hover:opacity-80 focus-visible:ring-[3px] focus-visible:ring-ring/50")}
    >
      {content}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Can it work? What is wrong? What to do next?                         */
/* ------------------------------------------------------------------ */

/** One line that answers "can I give it work right now?". */
export function runnerVerdict(runner: RemoteRunner, summary: RunnerHealthSummary | null): { tone: CheckTone | "busy"; label: string } {
  switch (runner.state) {
    case "connecting":
      return { tone: "busy", label: "Looking for it on the network…" };
    case "offline":
      return { tone: "fail", label: runner.lastSeenAt ? `Not reachable — last online ${timeAgo(runner.lastSeenAt)}` : "Not reachable" };
    case "update_required":
      return { tone: "warn", label: "Waiting for an update" };
    case "online":
      if (!summary) return { tone: "unknown", label: "Connected" };
      return summary.failing > 0 ? { tone: "fail", label: "Can't work yet" } : { tone: "ok", label: "Ready to work" };
  }
}

/** Ends a sentence that came without its full stop (errors from the core often do). */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

export interface RunnerProblem {
  /** What fixes it: dial again, or copy the setup again. */
  kind: "connection" | "sync";
  tone: "fail" | "warn";
  title: string;
  detail: string;
}

/**
 * What stands between this computer and the runner, most urgent first; null when nothing does. (What is wrong on the
 * runner itself is the checks' business.)
 */
export function runnerProblem(runner: RemoteRunner): RunnerProblem | null {
  if (runner.state === "offline") {
    return {
      kind: "connection",
      tone: "fail",
      title: `${runner.name} is offline`,
      detail: `${sentence(runner.error ?? "Is it awake and on the same network?")} Godmode keeps trying — its chats continue when it's back.`,
    };
  }
  if (runner.state === "update_required") {
    return {
      kind: "connection",
      tone: "warn",
      title: `${runner.name} runs another version of Godmode`,
      detail: `${runner.error ? `${sentence(runner.error)} ` : ""}Update Godmode on both computers to the same version, then try again.`,
    };
  }
  if (runner.state !== "online") return null;
  if (runner.sync.state === "failed") {
    return {
      kind: "sync",
      tone: "fail",
      title: "Your setup couldn't be copied",
      detail: `${runner.sync.error ? `${sentence(runner.sync.error)} ` : ""}Until it is, ${runner.name} works with the agents and logins it got last time.`,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Commands                                                             */
/* ------------------------------------------------------------------ */

/**
 * A long shell command: it wraps instead of scrolling sideways, a click selects all of it, and Copy shows a check for
 * two seconds. `children` renders the same text with something highlighted.
 */
export function CommandBlock({ text, label = "Copy command", title = "Terminal", children, className }: { text: string; label?: string; title?: ReactNode; children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const copy = async () => {
    if (!(await copyText(text))) return void toast.error("Couldn't copy the command", { description: "Select it and copy it by hand." });
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={cn("overflow-hidden rounded-lg border bg-paper-2", className)}>
      <div className="flex items-center gap-2 border-b py-1 pr-1 pl-3 text-[11px] text-muted-foreground">
        <SquareTerminal className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <Button type="button" variant="outline" size="xs" onClick={() => void copy()} aria-label={copied ? "Copied" : label}>
          {copied ? <Check className="text-success" /> : <Copy />}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
      <pre className="max-h-40 overflow-y-auto px-3 py-2.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground/90 select-all">{children ?? text}</pre>
    </div>
  );
}
