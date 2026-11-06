import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { AnimatePresence, motion } from "motion/react";
import { Brain, ChevronDown, CircleCheck, CircleDashed, MessagesSquare, Sparkles, Zap } from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { OptimizeReport, OptimizeRun } from "@godmode/shared";
import { DEFAULT_CONTEXT_BUDGET, formatBytes, tokensLabel } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { dateLocale, intlLocale, t as translate } from "@/i18n";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useReduceAnimations } from "@/lib/motion";

const DAY = 86_400_000;
const UNUSED_DAYS = 30;

function toastRun(run: OptimizeRun, dreaming: boolean) {
  const dreams = run.dreams.started.length;
  toast.success(run.cleanup.freedBytes ? translate("settings:cleanup.optimize.doneFreed", { size: formatBytes(run.cleanup.freedBytes) }) : translate("settings:cleanup.optimize.done"), {
    description: dreams ? translate("settings:cleanup.optimize.dreamsStarted", { count: dreams }) : dreaming ? translate("settings:cleanup.optimize.memoryCurrent") : undefined,
  });
}

/** Chats within the context budget and memory tasks actually use, with one click to optimize everything. */
export function OptimizeCard() {
  const reduce = useReduceAnimations();
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const report = useQuery({ queryKey: qk.optimize, queryFn: () => api.optimize.report(), staleTime: 60_000 });
  const run = useMutation({
    mutationFn: () => api.optimize.run(),
    onSuccess: (result) => {
      toastRun(result, !!report.data?.memory.dreaming);
      for (const key of [qk.optimize, qk.cleanup, qk.dreams]) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toastApiError(e, t("cleanup.optimize.error"), qc),
  });
  const data = report.data;
  const [open, setOpen] = useState<"context" | "memory" | null>(null);
  const toggle = (which: "context" | "memory") => setOpen(open === which ? null : which);
  return (
    <motion.section initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex items-center justify-between gap-3 px-5 pt-4">
        <div className="eyebrow flex items-center gap-1.5">
          <Zap className="size-3.5" /> {t("cleanup.optimize.title")}
        </div>
        <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending || !data}>
          {run.isPending ? <Spinner /> : <Sparkles />} {run.isPending ? t("cleanup.optimize.running") : t("cleanup.optimize.now")}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 px-5 pt-3.5 pb-5 @xl:grid-cols-2">
        {data ? (
          <>
            <ContextTile report={data} open={open === "context"} onToggle={() => toggle("context")} />
            <MemoryTile report={data} open={open === "memory"} onToggle={() => toggle("memory")} />
          </>
        ) : (
          [0, 1].map((i) => <Skeleton key={i} className="h-[136px] rounded-lg" />)
        )}
      </div>
      <AnimatePresence initial={false}>
        {data && open && (
          <motion.div
            key={open}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <ul className="mx-5 mb-5 max-h-80 divide-y overflow-y-auto rounded-lg border">{open === "context" ? <ContextList report={data} /> : <MemoryList report={data} />}</ul>
          </motion.div>
        )}
      </AnimatePresence>
      {data && <Automatic report={data} />}
    </motion.section>
  );
}

function Tile({
  icon,
  label,
  value,
  caption,
  lines,
  more,
  open,
  onToggle,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  caption: string;
  lines: { text: string; tone?: "warn" | "ok" | "muted" }[];
  more?: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border bg-paper-2/50">
      <div className="flex-1 p-4">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:size-3.5">
          {icon} {label}
        </span>
        <div className="mt-2.5 flex items-baseline gap-2">
          <span className="text-[28px] leading-none font-medium tracking-[-0.04em] tabular-nums">{value}</span>
          <span className="truncate text-xs text-muted-foreground">{caption}</span>
        </div>
        <ul className="mt-3 space-y-1">
          {lines.map((l) => (
            <li
              key={l.text}
              className={cn("flex items-start gap-1.5 text-xs leading-snug", l.tone === "warn" ? "text-warning" : l.tone === "ok" ? "text-foreground" : "text-muted-foreground")}
            >
              <span className={cn("mt-[5px] size-1.5 shrink-0 rounded-full", l.tone === "warn" ? "bg-warning" : l.tone === "ok" ? "bg-success" : "bg-foreground/25")} />
              <span>{l.text}</span>
            </li>
          ))}
        </ul>
      </div>
      {more && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cn(
            "flex items-center justify-between gap-2 border-t px-4 py-2 text-left text-xs outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
            open ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {more}
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      )}
    </div>
  );
}

function Meter({ value, max, over }: { value: number; max: number; over: boolean }) {
  return (
    <span className="relative h-1 w-14 shrink-0 overflow-hidden rounded-full bg-foreground/[0.08]">
      <span className={cn("absolute inset-y-0 left-0 rounded-full", over ? "bg-warning" : "bg-foreground/45")} style={{ width: `${Math.max(4, Math.min(1, value / max) * 100)}%` }} />
    </span>
  );
}

function ContextTile({ report, open, onToggle }: { report: OptimizeReport; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation("settings");
  const { budget, share, over, largest } = report.context;
  const limit = budget ?? DEFAULT_CONTEXT_BUDGET;
  const lines: { text: string; tone?: "warn" | "ok" | "muted" }[] = [
    over
      ? { text: t(budget ? "cleanup.optimize.context.over" : "cleanup.optimize.context.overNoBudget", { count: over, tokens: tokensLabel(limit) }), tone: "warn" }
      : { text: t("cleanup.optimize.context.within"), tone: "ok" },
  ];
  return (
    <Tile
      icon={<MessagesSquare />}
      label={t("cleanup.optimize.context.label")}
      value={budget ? tokensLabel(budget) : share === 0 ? t("cleanup.optimize.context.off") : share ? `${share}%` : t("cleanup.optimize.context.full")}
      caption={t("cleanup.optimize.context.caption")}
      lines={lines}
      more={largest.length ? t("cleanup.optimize.context.fullest") : undefined}
      open={open}
      onToggle={onToggle}
    />
  );
}

function ContextList({ report }: { report: OptimizeReport }) {
  const limit = report.context.budget ?? DEFAULT_CONTEXT_BUDGET;
  return (
    <>
      {report.context.largest.map((c) => (
        <li key={c.conversationId}>
          <Link to={`/chat/${c.conversationId}`} className="flex items-center gap-3 px-4 py-2 text-xs transition-colors hover:bg-accent/60">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-foreground">{c.title}</span>
              <span className="block truncate text-muted-foreground">{c.agentName}</span>
            </span>
            <Meter value={c.tokens} max={limit} over={c.tokens > limit} />
            <span className={cn("w-10 shrink-0 text-right tabular-nums", c.tokens > limit ? "text-warning" : "text-muted-foreground")}>{tokensLabel(c.tokens)}</span>
          </Link>
        </li>
      ))}
    </>
  );
}

function MemoryTile({ report, open, onToggle }: { report: OptimizeReport; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation("settings");
  const { agents, target, countingSince, dreaming, nextDreamAt } = report.memory;
  const counted = countingSince ? Date.now() - Date.parse(countingSince) >= UNUSED_DAYS * DAY : false;
  const notes = agents.reduce((n, a) => n + a.notes, 0);
  const notesBytes = agents.reduce((n, a) => n + a.notesBytes, 0);
  const unused = agents.reduce((n, a) => n + a.unused, 0);
  const overLimit = agents.filter((a) => a.chars > target).length;
  const dreamingNow = agents.filter((a) => a.dreaming).length;
  const lines: { text: string; tone?: "warn" | "ok" | "muted" }[] = [];
  if (overLimit) lines.push({ text: t("cleanup.optimize.memory.overLimit", { count: overLimit, chars: target.toLocaleString(intlLocale()) }), tone: "warn" });
  else lines.push({ text: t("cleanup.optimize.memory.withinLimit", { chars: target.toLocaleString(intlLocale()) }), tone: "ok" });
  if (!counted && countingSince) lines.push({ text: t("cleanup.optimize.memory.counting", { date: new Date(countingSince).toLocaleDateString(intlLocale(), { month: "short", day: "numeric" }) }), tone: "muted" });
  else if (counted && !unused) lines.push({ text: t("cleanup.optimize.memory.allUsed"), tone: "ok" });
  if (dreamingNow) lines.push({ text: t("cleanup.optimize.memory.dreamingNow", { count: dreamingNow }), tone: "muted" });
  else if (dreaming && nextDreamAt) lines.push({ text: t("cleanup.optimize.memory.nextDream", { time: formatDistanceToNow(new Date(nextDreamAt), { addSuffix: true, locale: dateLocale() }) }), tone: "muted" });
  else if (!dreaming) lines.push({ text: t("cleanup.optimize.memory.dreamingOff"), tone: "warn" });
  return (
    <Tile
      icon={<Brain />}
      label={t("cleanup.optimize.memory.label")}
      value={counted ? String(unused) : String(notes)}
      caption={counted ? t("cleanup.optimize.memory.unusedCaption", { count: unused }) : t("cleanup.optimize.memory.notesCaption", { count: notes, size: formatBytes(notesBytes) })}
      lines={lines}
      more={agents.length ? t("cleanup.optimize.memory.byAgent") : undefined}
      open={open}
      onToggle={onToggle}
    />
  );
}

function MemoryList({ report }: { report: OptimizeReport }) {
  const { t } = useTranslation("settings");
  const { agents, target } = report.memory;
  return (
    <>
      {agents.map((a) => (
        <li key={a.agentId}>
          <Link to={`/agents/${a.agentId}/memory`} className="flex items-center gap-3 px-4 py-2 text-xs transition-colors hover:bg-accent/60">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 truncate font-medium text-foreground">
                {a.name}
                {a.dreaming && <Spinner className="size-3 text-muted-foreground" />}
              </span>
              <span className="block truncate text-muted-foreground">
                {[t("cleanup.optimize.memory.notes", { count: a.notes }), a.unused > 0 && t("cleanup.optimize.memory.unused", { count: a.unused })].filter(Boolean).join(" · ")}
              </span>
            </span>
            <Meter value={a.chars} max={target} over={a.chars > target} />
            <span className={cn("w-12 shrink-0 text-right tabular-nums", a.chars > target ? "text-warning" : "text-muted-foreground")}>{`${(a.chars / 1000).toFixed(1)}k`}</span>
          </Link>
        </li>
      ))}
    </>
  );
}

function Automatic({ report }: { report: OptimizeReport }) {
  const { t } = useTranslation("settings");
  const { automatic, context, memory } = report;
  const items: { on: boolean; text: string; to: string }[] = [
    { on: automatic.cleanup, text: t(automatic.cleanup ? "cleanup.optimize.auto.cleanup" : "cleanup.optimize.auto.cleanupOff"), to: "/settings/cleanup#maintenance-auto-cleanup" },
    {
      on: automatic.dreaming,
      text: automatic.dreaming && memory.nextDreamAt
        ? t("cleanup.optimize.auto.dreams", { time: new Date(memory.nextDreamAt).toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit" }) })
        : t("cleanup.optimize.auto.dreamsOff"),
      to: "/settings/memory",
    },
    { on: automatic.budget, text: automatic.budget && context.budget ? t("cleanup.optimize.auto.budget", { tokens: tokensLabel(context.budget) }) : t("cleanup.optimize.auto.budgetOff"), to: "/settings/ai#auto-compact" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t bg-paper-2/60 px-5 py-3 text-xs">
      {items.map((i) => (
        <Link key={i.to} to={i.to} className={cn("flex items-center gap-1.5 transition-colors hover:text-foreground", i.on ? "text-foreground" : "text-muted-foreground")}>
          {i.on ? <CircleCheck className="size-3.5 text-success" /> : <CircleDashed className="size-3.5" />}
          {i.text}
        </Link>
      ))}
    </div>
  );
}
