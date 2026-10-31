import { useEffect, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format, formatDistanceToNowStrict } from "date-fns";
import { Trans, useTranslation } from "react-i18next";
import {
  Ban,
  ChevronDown,
  CirclePause,
  CircleStop,
  Eye,
  FilePen,
  FileText,
  FolderInput,
  FolderTree,
  Hourglass,
  Info,
  Moon,
  MoonStar,
  RotateCcw,
  Sparkles,
  Trash2,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { Agent, Dream, DreamOverview, DreamStatus, DreamWorkspaceChange, MemorySize } from "@godmode/shared";
import { formatBytes } from "@godmode/shared";
import { api, errorMessage, isLicenseRequired } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useSettings } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useNow } from "@/components/runs/run-row";
import { formatElapsed } from "@/components/runs/run-status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocale } from "@/i18n/language";
import { DreamReviewDialog } from "./dream-review";
import {
  ACTIVE_DREAM,
  CHANGE_KIND_ORDER,
  ROLLED_BACK,
  ChangeKindChip,
  DreamReasonBadge,
  DreamStatusBadge,
  UndoDreamDialog,
  dreamWhen,
  reviewedLabel,
  shortChars,
  upcomingWhen,
} from "./dream-parts";

const JOURNAL_PREVIEW = 3;
const CHANGES_PREVIEW = 6;
const FILES_PREVIEW = 3;
const MOVES_PREVIEW = 5;

/**
 * Dreaming status of an agent. Realtime ("dreams" entity) keeps it fresh; polling covers a dream in flight, and a
 * timer refetches right after the next scheduled dream time.
 */
function useDreamOverview(agentId: string) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: qk.agentDreams(agentId),
    queryFn: () => api.dreams.overview(agentId),
    refetchInterval: (query) => (query.state.data?.active ? 5_000 : 60_000),
  });
  const next = q.data?.active ? null : (q.data?.nextDreamAt ?? null);
  useEffect(() => {
    if (!next) return;
    const wait = Date.parse(next) - Date.now() + 5_000;
    if (wait <= 0 || wait > 2_147_483_647) return;
    const timer = setTimeout(() => qc.invalidateQueries({ queryKey: qk.agentDreams(agentId) }), wait);
    return () => clearTimeout(timer);
  }, [next, agentId, qc]);
  return q;
}

/** The agent's dream is running right now — the core refuses edits to its memory files meanwhile. */
export function useDreamingNow(agentId: string): boolean {
  const { data } = useQuery({
    queryKey: qk.agentDreams(agentId),
    queryFn: () => api.dreams.overview(agentId),
    select: (o) => o.active?.status === "running",
  });
  return !!data;
}

/** Dreaming status, "Dream now" and the dream journal of one agent (Memory tab). */
export function DreamsPanel({ agent }: { agent: Agent }) {
  const { t } = useTranslation(["agents", "common"]);
  const qc = useQueryClient();
  const q = useDreamOverview(agent.id);
  const memorySettings = useSettings().data?.memory;
  const dreaming = memorySettings?.dreaming;
  const [reviewing, setReviewing] = useState<Dream | null>(null);
  const [undoing, setUndoing] = useState<Dream | null>(null);
  const [showAll, setShowAll] = useState(false);
  /** Run whose cancel was sent: the button stays "Stopping…" until that dream is no longer active. */
  const [stoppingRun, setStoppingRun] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => api.dreams.start(agent.id),
    onSuccess: (dream) => {
      qc.setQueryData<DreamOverview>(qk.agentDreams(agent.id), (old) =>
        old ? { ...old, active: dream, dreams: [dream, ...old.dreams.filter((d) => d.id !== dream.id)] } : old,
      );
      qc.invalidateQueries({ queryKey: qk.agentDreams(agent.id) });
      toast.success(t("dreamsPanel.toast.started", { name: agent.name }), { description: t("dreamsPanel.toast.startedDescription", { reviewed: reviewedLabel(dream) }) });
    },
    onError: (err) => {
      if (!isLicenseRequired(err)) toast.error(t("dreamsPanel.toast.startError"), { description: errorMessage(err) });
      qc.invalidateQueries({ queryKey: qk.agentDreams(agent.id) });
    },
  });

  const cancel = useMutation({
    mutationFn: (runId: string) => api.runs.cancel(runId),
    onMutate: (runId) => setStoppingRun(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.agentDreams(agent.id) });
      qc.invalidateQueries({ queryKey: qk.runs });
      toast.success(t("dreamsPanel.toast.stopping"), { description: t("dreamsPanel.toast.stoppingDescription") });
    },
    onError: (err) => {
      setStoppingRun(null);
      toast.error(t("dreamsPanel.toast.stopError"), { description: errorMessage(err) });
    },
  });

  const o = q.data;
  const active = o?.active ?? null;
  const stopping = !!active?.runId && stoppingRun === active.runId;
  const titleId = `dreams-${agent.id}`;

  return (
    <section aria-labelledby={titleId} className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="relative">
        <NightSky active={!!active} />
        <div className="relative flex flex-wrap items-start gap-x-3.5 gap-y-3 px-4 py-4 @xl:px-5">
          <MoonTile active={!!active} />
          <div className="min-w-0 flex-1 basis-64">
            <div className="flex items-center gap-2">
              <h2 id={titleId} className="text-sm font-medium tracking-[-0.01em]">
                {t("dreamsPanel.title")}
              </h2>
              {o && !o.enabled && (
                <span className="rounded-[5px] border bg-secondary px-1.5 text-[10.5px] font-medium text-muted-foreground">{t("common:status.off")}</span>
              )}
            </div>
            {q.isLoading ? (
              <div className="mt-1.5 space-y-1.5">
                <Skeleton className="h-3.5 w-72 max-w-full" />
                <Skeleton className="h-3.5 w-48 max-w-full" />
              </div>
            ) : q.isError ? (
              <p className="mt-0.5 text-xs text-destructive">{t("dreamsPanel.loadError", { error: errorMessage(q.error) })}</p>
            ) : o ? (
              <StatusLines overview={o} agent={agent} minExchanges={dreaming?.minNewExchanges} refreshDays={dreaming?.refreshDays} />
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {active && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!active.runId || stopping}
                onClick={() => active.runId && cancel.mutate(active.runId)}
                aria-label={stopping ? t("dreamsPanel.stoppingLabel", { name: agent.name }) : t("dreamsPanel.stopLabel", { name: agent.name })}
              >
                {stopping ? (
                  <>
                    <Spinner /> {t("dreamsPanel.stopping")}
                  </>
                ) : (
                  <>
                    <CircleStop /> {t("common:actions.cancel")}
                  </>
                )}
              </Button>
            )}
            <Button size="sm" disabled={!o || !!active || start.isPending || !agent.enabled} onClick={() => start.mutate()}>
              {start.isPending ? <Spinner /> : <Sparkles />} {t("dreamsPanel.dreamNow")}
            </Button>
          </div>
        </div>
        {active && <DreamScan />}
      </div>

      {o && o.memory.chars > 0 && (
        <MemoryMeter memory={o.memory} loaded={memorySettings?.injectMemory !== false} dreamsByItself={o.enabled && agent.enabled} dreaming={!!active} />
      )}

      {o && (
        <Journal
          dreams={o.dreams}
          agentName={agent.name}
          undoBlocked={!!active}
          showAll={showAll}
          onToggleAll={() => setShowAll((v) => !v)}
          onReview={setReviewing}
          onUndo={setUndoing}
        />
      )}

      <DreamReviewDialog
        dream={reviewing}
        agentName={agent.name}
        undoBlocked={!!active}
        onOpenChange={(open) => !open && setReviewing(null)}
        onUndo={setUndoing}
      />
      <UndoDreamDialog dream={undoing} agentName={agent.name} onOpenChange={(open) => !open && setUndoing(null)} />
    </section>
  );
}

const LAST_DREAM = {
  failed: "dreamsPanel.last.failed",
  cancelled: "dreamsPanel.last.cancelled",
  paused: "dreamsPanel.last.paused",
} as const;

function StatusLines({
  overview: o,
  agent,
  minExchanges,
  refreshDays,
}: {
  overview: DreamOverview;
  agent: Agent;
  minExchanges?: number;
  refreshDays?: number;
}) {
  const { t } = useTranslation("agents");
  const { dateLocale } = useLocale();
  const active = o.active;
  const now = useNow(!!active);

  if (active) {
    const queued = active.status === "queued";
    return (
      <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
        <p className="flex flex-wrap items-baseline gap-x-2">
          {/* Only the status is announced; the ticking timer sits outside the live region. */}
          <span aria-live="polite" className="inline-flex flex-wrap items-baseline gap-x-2">
            <span className="text-shimmer text-[13px] font-medium">{queued ? t("dreamsPanel.waitingToDream") : t("dreamsPanel.dreaming")}</span>
            <span>{reviewedLabel(active)}</span>
          </span>
          {!queued && (
            <span role="timer" className="font-mono tabular-nums">
              {formatElapsed(now - Date.parse(active.startedAt ?? active.createdAt))}
            </span>
          )}
        </p>
        {queued && <p>{t("dreamsPanel.startsSoon", { name: agent.name })}</p>}
      </div>
    );
  }

  const last = o.dreams.find((d) => !ACTIVE_DREAM.includes(d.status));
  const lastAt = last ? new Date(last.finishedAt ?? last.createdAt) : null;
  const threshold = Math.max(1, minExchanges ?? 1);
  const { exchanges, conversations } = o.pending;

  return (
    <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
      <p className="flex flex-wrap items-center gap-x-1.5">
        {last && lastAt ? (
          <span>
            <Trans
              t={t}
              i18nKey={last.status in LAST_DREAM ? LAST_DREAM[last.status as keyof typeof LAST_DREAM] : "dreamsPanel.last.default"}
              values={{ ago: formatDistanceToNowStrict(lastAt, { addSuffix: true, locale: dateLocale }) }}
              components={{ time: <time dateTime={lastAt.toISOString()} title={format(lastAt, "PPpp", { locale: dateLocale })} /> }}
            />
            {last.status === "paused" && (last.reason === "size" ? t("dreamsPanel.last.pausedSize") : t("dreamsPanel.last.pausedIdle", { name: agent.name }))}
            {last.status === "reverted" && t("dreamsPanel.last.undone")}
          </span>
        ) : (
          <span>{t("dreamsPanel.neverDreamt")}</span>
        )}
        <span aria-hidden className="text-muted-foreground/50">
          ·
        </span>
        {!o.enabled ? (
          <span>
            <Trans t={t} i18nKey="dreamsPanel.off" components={{ link: <Link to="/settings/memory" className="font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground" /> }} />
          </span>
        ) : o.nextDreamAt ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="cursor-default rounded-sm underline decoration-dotted decoration-muted-foreground/40 underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                {t("dreamsPanel.nextDream", { when: upcomingWhen(o.nextDreamAt) })}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64 text-center">
              {refreshDays
                ? t("dreamsPanel.scheduleHintRefresh", {
                    name: agent.name,
                    exchanges: t("dreamsPanel.newExchanges", { count: threshold }),
                    days: t("dreamsPanel.days", { count: refreshDays }),
                  })
                : t("dreamsPanel.scheduleHint", { name: agent.name, exchanges: t("dreamsPanel.newExchanges", { count: threshold }) })}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span>
            <Trans t={t} i18nKey="dreamsPanel.noUpcoming" components={{ link: <Link to="/settings/memory" className="font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground" /> }} />
          </span>
        )}
      </p>
      {!agent.enabled ? (
        <p>{t("dreamsPanel.switchedOff", { name: agent.name })}</p>
      ) : exchanges > 0 ? (
        <p className="flex items-center gap-1.5">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-dream" />
          <span>
            <Trans
              t={t}
              i18nKey={o.enabled && exchanges < threshold ? "dreamsPanel.pendingBelow" : "dreamsPanel.pending"}
              values={{
                exchanges: t("dreamsPanel.newExchanges", { count: exchanges }),
                chats: t("dreamParts.chats", { count: conversations }),
                threshold,
              }}
              components={{ b: <span className="font-medium text-foreground tabular-nums" /> }}
            />
          </span>
        </p>
      ) : (
        <p>{last ? t("dreamsPanel.nothingNew") : t("dreamsPanel.nothingYet")}</p>
      )}
    </div>
  );
}

/**
 * How much of its size limit MEMORY.md uses. The track ends where a chat stops loading it; the tick marks what dreams
 * keep it under.
 */
function MemoryMeter({
  memory: { chars, target, limit },
  loaded,
  dreamsByItself,
  dreaming,
}: {
  memory: MemorySize;
  /** Chats load MEMORY.md (Settings → Memory). */
  loaded: boolean;
  dreamsByItself: boolean;
  dreaming: boolean;
}) {
  const { t } = useTranslation("agents");
  const { intlLocale } = useLocale();
  const cut = loaded && chars > limit;
  const over = chars > target;
  const next = dreaming ? t("dreamsPanel.meter.shortening") : dreamsByItself ? t("dreamsPanel.meter.nextShortens") : t("dreamsPanel.meter.dreamToShorten");
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-3 @xl:px-5">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11.5px] text-muted-foreground">MEMORY.md</span>
        <span className="text-xs tabular-nums">
          <Trans
            t={t}
            i18nKey="dreamsPanel.meter.size"
            values={{ chars: chars.toLocaleString(intlLocale), target: target.toLocaleString(intlLocale) }}
            components={{
              b: <span className={cn("font-medium", cut ? "text-destructive" : over ? "text-warning" : "text-foreground")} />,
              muted: <span className="text-muted-foreground" />,
            }}
          />
        </span>
      </div>
      <div
        role="meter"
        aria-label={t("memoryEditorParts.sizeLabel")}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(chars, limit)}
        aria-valuetext={t("memoryEditorParts.sizeValue", { chars: chars.toLocaleString(intlLocale), target: target.toLocaleString(intlLocale) })}
        className="relative h-1.5 min-w-32 flex-1 basis-40 rounded-full bg-secondary"
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-500", cut ? "bg-destructive" : over ? "bg-warning" : "bg-dream/70")}
          style={{ width: `${Math.min(100, (chars / limit) * 100)}%` }}
        />
        <span aria-hidden className="absolute -top-1 -bottom-1 w-px bg-foreground/35" style={{ left: `${(target / limit) * 100}%` }} />
      </div>
      <p className="basis-full text-xs text-muted-foreground @3xl:basis-auto @3xl:max-w-[26rem] @3xl:text-right">
        {cut
          ? t("dreamsPanel.meter.cut", { limit: limit.toLocaleString(intlLocale), next })
          : over
            ? t("dreamsPanel.meter.over", { over: (chars - target).toLocaleString(intlLocale), next })
            : loaded
              ? t("memoryEditorParts.budgetOk")
              : t("dreamsPanel.meter.within")}
      </p>
    </div>
  );
}

function Journal({
  dreams,
  agentName,
  undoBlocked,
  showAll,
  onToggleAll,
  onReview,
  onUndo,
}: {
  dreams: Dream[];
  agentName: string;
  /** A dream is in flight: the core refuses to undo until it has ended. */
  undoBlocked: boolean;
  showAll: boolean;
  onToggleAll: () => void;
  onReview: (dream: Dream) => void;
  onUndo: (dream: Dream) => void;
}) {
  const { t } = useTranslation("agents");
  if (!dreams.length) {
    return (
      <p className="border-t px-4 py-4 text-xs leading-relaxed text-muted-foreground @xl:px-5">
        {t("dreamsPanel.journal.empty", { name: agentName })}
      </p>
    );
  }
  const shown = showAll ? dreams : dreams.slice(0, JOURNAL_PREVIEW);
  const older = dreams.length - JOURNAL_PREVIEW;
  return (
    <div className="border-t">
      <h3 className="eyebrow px-4 pt-3.5 @xl:px-5">{t("dreamsPanel.journal.title")}</h3>
      <ol className="px-4 pt-3 pb-1 @xl:px-5">
        <AnimatePresence initial={false}>
          {shown.map((d, i) => (
            <JournalEntry
              key={d.id}
              dream={d}
              isLast={i === shown.length - 1}
              defaultOpen={i === 0 && !ROLLED_BACK.includes(d.status)}
              undoBlocked={undoBlocked}
              onReview={onReview}
              onUndo={onUndo}
            />
          ))}
        </AnimatePresence>
      </ol>
      {older > 0 && (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={onToggleAll}
          className="flex w-full items-center gap-1.5 border-t px-4 py-2.5 text-left text-xs font-medium text-muted-foreground transition hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none @xl:px-5"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", showAll && "rotate-180")} aria-hidden />
          {showAll ? t("dreamsPanel.showFewer") : t("dreamsPanel.journal.showOlder", { count: older })}
        </button>
      )}
    </div>
  );
}

const NODE: Record<DreamStatus, { icon: LucideIcon; className: string }> = {
  queued: { icon: Hourglass, className: "text-muted-foreground" },
  running: { icon: Moon, className: "text-dream" },
  succeeded: { icon: MoonStar, className: "text-dream" },
  failed: { icon: TriangleAlert, className: "text-destructive" },
  cancelled: { icon: Ban, className: "text-muted-foreground" },
  paused: { icon: CirclePause, className: "text-warning" },
  reverted: { icon: Undo2, className: "text-muted-foreground" },
};

function JournalEntry({
  dream: d,
  isLast,
  defaultOpen,
  undoBlocked,
  onReview,
  onUndo,
}: {
  dream: Dream;
  isLast: boolean;
  defaultOpen: boolean;
  undoBlocked: boolean;
  onReview: (dream: Dream) => void;
  onUndo: (dream: Dream) => void;
}) {
  const { t } = useTranslation("agents");
  const { dateLocale, intlLocale } = useLocale();
  const [open, setOpen] = useState(defaultOpen);
  const [allChanges, setAllChanges] = useState(false);
  const active = ACTIVE_DREAM.includes(d.status);
  // Ended early: the core rolled the memory back, so the reported changes only describe what was attempted.
  const rolledBack = ROLLED_BACK.includes(d.status);
  const node = NODE[d.status] ?? NODE.queued;
  const at = new Date(d.finishedAt ?? d.createdAt);
  const counts = CHANGE_KIND_ORDER.map((kind) => ({ kind, n: d.changes.filter((c) => c.kind === kind).length })).filter((c) => c.n > 0);
  const changes = allChanges ? d.changes : d.changes.slice(0, CHANGES_PREVIEW);
  const detailsId = `dream-${d.id}-changes`;

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2 }}
      className={cn("relative pl-9", isLast ? "pb-3" : "pb-5")}
    >
      {!isLast && <span aria-hidden className="absolute top-6 bottom-0 left-[11.5px] w-px bg-border" />}
      <span
        aria-hidden
        className={cn(
          "absolute -top-0.5 left-0 grid size-6 place-items-center rounded-full border bg-card",
          d.status === "running" && "border-dream/30 bg-dream-soft motion-safe:animate-dream-halo",
        )}
      >
        <node.icon className={cn("size-3.5", node.className)} />
      </span>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <time dateTime={d.createdAt} title={format(new Date(d.createdAt), "PPpp", { locale: dateLocale })} className="text-[13px] font-medium">
          {dreamWhen(d.createdAt)}
        </time>
        <DreamReasonBadge reason={d.reason} />
        <DreamStatusBadge status={d.status} />
        {!active && (
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums" title={format(at, "PPpp", { locale: dateLocale })}>
            {formatDistanceToNowStrict(at, { addSuffix: true, locale: dateLocale })}
          </span>
        )}
      </div>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <span>{reviewedLabel(d)}</span>
        {!rolledBack && d.memoryChars && shortChars(d.memoryChars.before) !== shortChars(d.memoryChars.after) && (
          <>
            <span aria-hidden className="text-muted-foreground/50">
              ·
            </span>
            <span
              className="tabular-nums"
              title={t("dreamsPanel.entry.memoryTitle", { before: d.memoryChars.before.toLocaleString(intlLocale), after: d.memoryChars.after.toLocaleString(intlLocale) })}
            >
              MEMORY.md {shortChars(d.memoryChars.before)} <span aria-hidden>→</span>
              <span className="sr-only">{t("dreamsPanel.entry.to")}</span>{" "}
              <span className={cn("font-medium", d.memoryChars.after < d.memoryChars.before && "text-success")}>{shortChars(d.memoryChars.after)}</span>
            </span>
          </>
        )}
      </p>

      {d.summary ? (
        <p className={cn("mt-2 max-w-3xl text-sm leading-relaxed text-pretty", rolledBack && "text-muted-foreground")}>{d.summary}</p>
      ) : active ? (
        <p className="text-shimmer mt-2 text-sm">{t("dreamsPanel.entry.consolidating")}</p>
      ) : null}

      {rolledBack && d.changes.length > 0 && (
        <p className="mt-2.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <RotateCcw className="size-3 shrink-0" aria-hidden />
          {d.files.length ? t("dreamsPanel.entry.attemptedPartly") : t("dreamsPanel.entry.attemptedAll")}
        </p>
      )}
      {d.changes.length > 0 &&
        (open ? (
          <ul id={detailsId} className={cn("max-w-3xl space-y-1.5", rolledBack ? "mt-1.5 opacity-70 grayscale" : "mt-2.5")}>
            {changes.map((c, i) => (
              <motion.li
                key={i}
                initial={{ opacity: 0, x: -3 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(i, 12) * 0.025, duration: 0.18 }}
                className="flex items-start gap-2.5"
              >
                <ChangeKindChip kind={c.kind} />
                <span className={cn("min-w-0 pt-px text-[13px] leading-snug", rolledBack && "line-through decoration-muted-foreground/50")}>
                  {c.text}
                </span>
              </motion.li>
            ))}
            {d.changes.length > CHANGES_PREVIEW && (
              <li>
                <button
                  type="button"
                  onClick={() => setAllChanges((v) => !v)}
                  className="text-xs font-medium text-muted-foreground underline decoration-muted-foreground/30 underline-offset-[3px] transition hover:text-foreground"
                >
                  {allChanges ? t("dreamsPanel.entry.showFewerChanges") : t("dreamsPanel.entry.showMoreChanges", { count: d.changes.length - CHANGES_PREVIEW })}
                </button>
              </li>
            )}
          </ul>
        ) : (
          <div className={cn("flex flex-wrap gap-1.5", rolledBack ? "mt-1.5 opacity-70 grayscale" : "mt-2")}>
            {counts.map((c) => (
              <ChangeKindChip key={c.kind} kind={c.kind} count={c.n} />
            ))}
          </div>
        ))}

      {d.workspace.length > 0 && <WorkspaceMoves moves={d.workspace} stuck={rolledBack} />}

      {d.status !== "succeeded" && d.error && (
        <p
          className={cn(
            "mt-2 flex max-w-3xl gap-1.5 rounded-md border px-2.5 py-1.5 text-xs",
            d.status === "failed" ? "border-destructive/20 bg-destructive/[0.05] text-destructive" : "bg-secondary/60 text-muted-foreground",
          )}
        >
          {d.status === "failed" ? (
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          ) : d.status === "paused" ? (
            <CirclePause className="mt-px size-3.5 shrink-0" aria-hidden />
          ) : (
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 break-words">{d.error}</span>
        </p>
      )}
      {d.status === "succeeded" && !d.files.length && (
        <p className="mt-2 text-xs text-muted-foreground">{t("dreamsPanel.entry.goodShape")}</p>
      )}

      {(d.changes.length > 0 || d.files.length > 0 || d.workspace.length > 0) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
          {d.changes.length > 0 && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={open ? detailsId : undefined}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
              {open ? t("dreamsPanel.entry.hideChanges") : rolledBack ? t("dreamsPanel.entry.attemptedChanges", { count: d.changes.length }) : t("dreamsPanel.entry.changes", { count: d.changes.length })}
            </button>
          )}
          {d.files.length > 0 && (
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {d.files.slice(0, FILES_PREVIEW).map((f) => (
                <span
                  key={f}
                  title={f}
                  className="inline-flex h-5 max-w-[14rem] items-center gap-1 rounded-[5px] border bg-paper-2 px-1.5 font-mono text-[10.5px] text-muted-foreground"
                >
                  <FileText className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{f}</span>
                </span>
              ))}
              {d.files.length > FILES_PREVIEW && (
                <span className="text-[11px] text-muted-foreground" title={d.files.slice(FILES_PREVIEW).join(", ")}>
                  +{d.files.length - FILES_PREVIEW}
                </span>
              )}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {(d.files.length > 0 || d.workspace.some((m) => m.action === "rewrite")) && (
              <Button variant="outline" size="xs" onClick={() => onReview(d)}>
                <Eye /> {t("dreamsPanel.entry.review")}
              </Button>
            )}
            {d.canRevert && undoBlocked ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                    <Button variant="ghost" size="xs" disabled aria-label={t("dreamsPanel.entry.undoLabel", { when: dreamWhen(d.createdAt) })}>
                      <Undo2 /> {t("dreamsPanel.entry.undo")}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t("dreamsPanel.entry.undoBlocked")}</TooltipContent>
              </Tooltip>
            ) : d.canRevert ? (
              <Button variant="ghost" size="xs" onClick={() => onUndo(d)} aria-label={t("dreamsPanel.entry.undoLabel", { when: dreamWhen(d.createdAt) })}>
                <Undo2 /> {t("dreamsPanel.entry.undo")}
              </Button>
            ) : (d.files.length > 0 || d.workspace.length > 0) && !active && d.status !== "reverted" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className="cursor-default rounded-sm px-1 text-[11px] text-muted-foreground/80 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    {t("dreamsPanel.entry.editedSince")}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-60 text-center">
                  {d.files.length > 0
                    ? t("dreamsPanel.entry.editedSinceFiles")
                    : t("dreamsPanel.entry.editedSinceWorkspace")}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </span>
        </div>
      )}
    </motion.li>
  );
}

const MOVE_META = {
  move: { icon: FolderInput, className: "text-sky-700 dark:text-sky-300" },
  rewrite: { icon: FilePen, className: "text-violet-700 dark:text-violet-300" },
  discard: { icon: Trash2, className: "text-rose-700 dark:text-rose-300" },
} as const;

/** How the dream tidied the workspace; after a rollback, what couldn't be moved back. */
function WorkspaceMoves({ moves, stuck }: { moves: DreamWorkspaceChange[]; stuck: boolean }) {
  const { t } = useTranslation("agents");
  const [all, setAll] = useState(false);
  const counts = (["move", "rewrite", "discard"] as const).map((action) => ({ action, n: moves.filter((m) => m.action === action).length })).filter((c) => c.n > 0);
  const out = moves.filter((m) => m.action === "discard").reduce((n, m) => n + m.bytes, 0);
  const shown = all ? moves : moves.slice(0, MOVES_PREVIEW);
  return (
    <div className="mt-2.5 max-w-3xl overflow-hidden rounded-lg border bg-paper-2/60">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2 text-xs">
        <FolderTree className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-medium">{stuck ? t("dreamsPanel.moves.stuck") : t("dreamsPanel.moves.workspace")}</span>
        {counts.map(({ action, n }) => {
          const meta = MOVE_META[action];
          return (
            <span key={action} className={cn("inline-flex items-center gap-1 tabular-nums", meta.className)}>
              <meta.icon className="size-3" aria-hidden />
              {t(`dreamsPanel.moves.count.${action}`, { count: n })}
            </span>
          );
        })}
        {out > 0 && !stuck && <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{t("dreamsPanel.moves.outOfWay", { size: formatBytes(out) })}</span>}
      </div>
      <ul className="divide-y border-t">
        {shown.map((m, i) => {
          const meta = MOVE_META[m.action];
          return (
            <li key={`${m.from}-${i}`} className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-[11.5px]">
              <meta.icon className={cn("size-3 shrink-0", meta.className)} aria-label={t(`dreamsPanel.moves.label.${m.action}`)} />
              <span className="min-w-0 truncate font-mono text-foreground" title={`workspace/${m.from}`}>
                {m.from}
              </span>
              {m.action === "move" ? (
                <>
                  <span aria-hidden className="shrink-0 text-muted-foreground/60">
                    →
                  </span>
                  <span className="min-w-0 truncate font-mono text-muted-foreground" title={`workspace/${m.to}`}>
                    {m.to}
                  </span>
                </>
              ) : m.action === "rewrite" ? (
                <span className="shrink-0 text-muted-foreground">{t("dreamsPanel.moves.sizeNow", { size: formatBytes(m.bytes) })}</span>
              ) : (
                <span className="shrink-0 text-muted-foreground">{t("dreamsPanel.moves.removedAfterWeek")}</span>
              )}
            </li>
          );
        })}
      </ul>
      {moves.length > MOVES_PREVIEW && (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          className="flex w-full items-center gap-1.5 border-t px-3 py-1.5 text-left text-xs font-medium text-muted-foreground transition hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", all && "rotate-180")} aria-hidden />
          {all ? t("dreamsPanel.showFewer") : t("dreamsPanel.moves.showMore", { count: moves.length - MOVES_PREVIEW })}
        </button>
      )}
    </div>
  );
}

const STARS = [
  { top: 22, left: 54, size: 1.5, delay: 2.4 },
  { top: 16, left: 61, size: 2, delay: 0 },
  { top: 46, left: 67, size: 1.5, delay: 1.2 },
  { top: 26, left: 74, size: 2.5, delay: 2.1 },
  { top: 68, left: 79, size: 1.5, delay: 0.6 },
  { top: 12, left: 86, size: 2, delay: 1.7 },
  { top: 44, left: 91, size: 1.5, delay: 2.8 },
  { top: 74, left: 96, size: 2, delay: 3.3 },
];

/** A few quiet stars over a moonlit wash; they twinkle while the agent dreams. */
function NightSky({ active }: { active: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className={cn(
          "absolute inset-0 bg-[radial-gradient(80%_140%_at_100%_0%,var(--dream-soft),transparent_70%)] transition-opacity duration-700",
          active ? "opacity-100" : "opacity-70",
        )}
      />
      {STARS.map((s, i) => (
        <span
          key={i}
          className={cn(
            "absolute rounded-full bg-dream transition-opacity duration-700",
            active ? "opacity-70 motion-safe:animate-twinkle" : "opacity-20",
          )}
          style={{ top: `${s.top}%`, left: `${s.left}%`, width: s.size, height: s.size, animationDelay: `${s.delay}s` }}
        />
      ))}
    </div>
  );
}

function MoonTile({ active }: { active: boolean }) {
  const reduce = useReducedMotion();
  return (
    <div
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-lg border bg-paper-2 text-dream transition-colors duration-500 [&_svg]:size-[18px]",
        active && "border-dream/30 bg-dream-soft motion-safe:animate-dream-halo",
      )}
    >
      {active ? (
        <motion.span
          className="grid place-items-center"
          animate={reduce ? undefined : { rotate: [-10, 6, -10], y: [0, -1.5, 0] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        >
          <Moon className="fill-dream/20" />
        </motion.span>
      ) : (
        <MoonStar />
      )}
    </div>
  );
}

/** Hairline that drifts along the header's bottom edge while a dream is in flight. */
function DreamScan() {
  const reduce = useReducedMotion();
  if (reduce) return <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-dream/30" />;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden">
      <motion.span
        className="absolute inset-y-0 w-1/3 bg-linear-to-r from-transparent via-dream to-transparent"
        initial={{ left: "-33%" }}
        animate={{ left: "100%" }}
        transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}
