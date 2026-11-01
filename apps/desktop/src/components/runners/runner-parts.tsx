import { useEffect, useRef, useState, type ReactNode } from "react";
import { format } from "date-fns";
import { Check, Copy, SquareTerminal, TriangleAlert, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RemoteRunner, RunnerState } from "@godmode/shared";
import { LiveDot } from "@/components/aicss/Motion";
import { copyText } from "@/components/chat/copy-button";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/language";
import { isMac } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { toastApiError } from "@/components/vault/vault-utils";

export function useRemoveRunner({ onRemoved, failed }: { onRemoved: () => void; failed: string }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.runners.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.runners });
      void qc.invalidateQueries({ queryKey: qk.conversationsAll });
      onRemoved();
    },
    onError: (e) => toastApiError(e, failed, qc),
  });
}

/** What the computer the human sits at is called in "run on" choices — and inside a sentence. */
export const thisComputer = () => (isMac ? t("runners:thisMac") : t("runners:thisComputer"));
export const thisComputerInline = () => (isMac ? t("runners:thisMacInline") : t("runners:thisComputerInline"));

/* ------------------------------------------------------------------ */
/* Connection                                                           */
/* ------------------------------------------------------------------ */

export const RUNNER_STATE_LABEL: Record<RunnerState, string> = {
  get online() {
    return t("runners:state.online");
  },
  get connecting() {
    return t("runners:state.connecting");
  },
  get offline() {
    return t("runners:state.offline");
  },
  get update_required() {
    return t("runners:state.updateRequired");
  },
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

/** "Runner" next to a name, where a runner and a computer of the device group may be called the same. */
export function RunnerTag({ className }: { className?: string }) {
  const { t } = useTranslation("runners");
  return (
    <span className={cn("inline-flex h-[18px] shrink-0 items-center rounded-[4px] border bg-secondary px-1 text-[10.5px] leading-none font-medium text-muted-foreground", className)}>
      {t("tag")}
    </span>
  );
}

const STATE_BADGE: Record<RunnerState, string> = {
  online: "border-brand/25 bg-brand-soft text-brand-strong",
  connecting: "border-border bg-secondary text-foreground",
  offline: "border-destructive/25 bg-destructive/[0.06] text-destructive",
  update_required: "border-warning/30 bg-warning/[0.07] text-warning",
};

export function RunnerStateBadge({ runner, className }: { runner: Pick<RemoteRunner, "state" | "latencyMs" | "lastSeenAt">; className?: string }) {
  const { t } = useTranslation("runners");
  const { dateLocale } = useLocale();
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
      <TooltipContent>{t("lastOnline", { when: format(new Date(seen), "PPp", { locale: dateLocale }) })}</TooltipContent>
    </Tooltip>
  );
}

/** "3 chats · 1 working" */
export function runnerWorkLine(runner: Pick<RemoteRunner, "conversations" | "activeRuns">): string {
  const chats = runner.conversations === 0 ? t("runners:work.noChats") : t("runners:work.chats", { count: runner.conversations });
  return runner.activeRuns > 0 ? t("runners:work.withWorking", { chats, count: runner.activeRuns }) : chats;
}

/* ------------------------------------------------------------------ */
/* Commands                                                             */
/* ------------------------------------------------------------------ */

/**
 * A long shell command: it wraps instead of scrolling sideways, a click selects all of it, and Copy shows a check for
 * two seconds. `children` renders the same text with something highlighted.
 */
export function CommandBlock({ text, label, title, children, className }: { text: string; label?: string; title?: ReactNode; children?: ReactNode; className?: string }) {
  const { t } = useTranslation(["runners", "common"]);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const copy = async () => {
    if (!(await copyText(text))) return void toast.error(t("command.copyFailed"), { description: t("command.copyFailedHint") });
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={cn("overflow-hidden rounded-lg border bg-paper-2", className)}>
      <div className="flex items-center gap-2 border-b py-1 pr-1 pl-3 text-[11px] text-muted-foreground">
        <SquareTerminal className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{title ?? t("command.terminal")}</span>
        <Button type="button" variant="outline" size="xs" onClick={() => void copy()} aria-label={copied ? t("common:actions.copied") : (label ?? t("command.copy"))}>
          {copied ? <Check className="text-success" /> : <Copy />}
          <span aria-live="polite">{copied ? t("common:actions.copied") : t("common:actions.copy")}</span>
        </Button>
      </div>
      <pre className="max-h-40 overflow-y-auto px-3 py-2.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-foreground/90 select-all">{children ?? text}</pre>
    </div>
  );
}
