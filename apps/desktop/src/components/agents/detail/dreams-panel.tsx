import { useEffect, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format, formatDistanceToNowStrict } from "date-fns";
import {
  Ban,
  ChevronDown,
  CirclePause,
  CircleStop,
  Eye,
  FileText,
  Hourglass,
  Info,
  Moon,
  MoonStar,
  RotateCcw,
  Sparkles,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { Agent, Dream, DreamOverview, DreamStatus } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useSettings } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useNow } from "@/components/runs/run-row";
import { formatElapsed } from "@/components/runs/run-status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  plural,
  reviewedLabel,
  upcomingWhen,
} from "./dream-parts";

const JOURNAL_PREVIEW = 3;
const CHANGES_PREVIEW = 6;
const FILES_PREVIEW = 3;

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
  const qc = useQueryClient();
  const q = useDreamOverview(agent.id);
  const dreaming = useSettings().data?.memory.dreaming;
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
      toast.success(`${agent.name} is dreaming…`, { description: `${reviewedLabel(dream)}.` });
    },
    onError: (err) => {
      toast.error("Couldn't start a dream", { description: errorMessage(err) });
      qc.invalidateQueries({ queryKey: qk.agentDreams(agent.id) });
    },
  });

  const cancel = useMutation({
    mutationFn: (runId: string) => api.runs.cancel(runId),
    onMutate: (runId) => setStoppingRun(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.agentDreams(agent.id) });
      qc.invalidateQueries({ queryKey: qk.runs });
      toast.success("Stopping the dream…", { description: "Whatever it changed so far is rolled back." });
    },
    onError: (err) => {
      setStoppingRun(null);
      toast.error("Couldn't stop the dream", { description: errorMessage(err) });
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
                Dreaming
              </h2>
              {o && !o.enabled && (
                <span className="rounded-[5px] border bg-secondary px-1.5 text-[10.5px] font-medium text-muted-foreground">Off</span>
              )}
            </div>
            {q.isLoading ? (
              <div className="mt-1.5 space-y-1.5">
                <Skeleton className="h-3.5 w-72 max-w-full" />
                <Skeleton className="h-3.5 w-48 max-w-full" />
              </div>
            ) : q.isError ? (
              <p className="mt-0.5 text-xs text-destructive">Couldn't load dreams: {errorMessage(q.error)}</p>
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
                aria-label={stopping ? `Stopping ${agent.name}'s dream` : `Stop ${agent.name}'s dream`}
              >
                {stopping ? (
                  <>
                    <Spinner /> Stopping…
                  </>
                ) : (
                  <>
                    <CircleStop /> Cancel
                  </>
                )}
              </Button>
            )}
            <Button size="sm" disabled={!o || !!active || start.isPending || !agent.enabled} onClick={() => start.mutate()}>
              {start.isPending ? <Spinner /> : <Sparkles />} Dream now
            </Button>
          </div>
        </div>
        {active && <DreamScan />}
      </div>

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

const LAST_DREAM: Partial<Record<DreamStatus, string>> = {
  failed: "Last dream failed",
  cancelled: "Last dream was cancelled",
  paused: "Last dream paused",
};

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
  const active = o.active;
  const now = useNow(!!active);

  if (active) {
    const queued = active.status === "queued";
    return (
      <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
        <p className="flex flex-wrap items-baseline gap-x-2">
          {/* Only the status is announced; the ticking timer sits outside the live region. */}
          <span aria-live="polite" className="inline-flex flex-wrap items-baseline gap-x-2">
            <span className="text-shimmer text-[13px] font-medium">{queued ? "Waiting to dream…" : "Dreaming…"}</span>
            <span>{reviewedLabel(active)}</span>
          </span>
          {!queued && (
            <span role="timer" className="font-mono tabular-nums">
              {formatElapsed(now - Date.parse(active.startedAt ?? active.createdAt))}
            </span>
          )}
        </p>
        {queued && <p>Starts as soon as {agent.name} has finished what it's doing.</p>}
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
            {LAST_DREAM[last.status] ?? "Last dream"}{" "}
            <time dateTime={lastAt.toISOString()} title={format(lastAt, "PPpp")}>
              {formatDistanceToNowStrict(lastAt, { addSuffix: true })}
            </time>
            {last.status === "paused" && ` — it continues when ${agent.name} is idle`}
            {last.status === "reverted" && " (undone)"}
          </span>
        ) : (
          <span>Hasn't dreamt yet</span>
        )}
        <span aria-hidden className="text-muted-foreground/50">
          ·
        </span>
        {!o.enabled ? (
          <span>
            Dreaming is off — turn it on in{" "}
            <Link
              to="/settings/memory"
              className="font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground"
            >
              Settings → Memory
            </Link>
          </span>
        ) : o.nextDreamAt ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="cursor-default rounded-sm underline decoration-dotted decoration-muted-foreground/40 underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                Next dream {upcomingWhen(o.nextDreamAt)}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64 text-center">
              On schedule, {agent.name} dreams once it has had {plural(threshold, "new exchange")} since its last dream
              {refreshDays ? ` — or after ${plural(refreshDays, "day")} to bring dates in its memory up to date` : ""}.
            </TooltipContent>
          </Tooltip>
        ) : (
          <span>
            No upcoming dream — check the schedule in{" "}
            <Link
              to="/settings/memory"
              className="font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground"
            >
              Settings → Memory
            </Link>
          </span>
        )}
      </p>
      {!agent.enabled ? (
        <p>{agent.name} is switched off — switch it on to let it dream.</p>
      ) : exchanges > 0 ? (
        <p className="flex items-center gap-1.5">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-dream" />
          <span>
            <span className="font-medium text-foreground tabular-nums">{plural(exchanges, "new exchange")}</span> in {plural(conversations, "chat")} waiting
            {o.enabled && exchanges < threshold ? ` — the next scheduled dream needs ${threshold}` : ""}
          </span>
        </p>
      ) : (
        <p>{last ? "Nothing new since the last dream." : "Nothing to dream about yet — chat with the agent first."}</p>
      )}
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
  if (!dreams.length) {
    return (
      <p className="border-t px-4 py-4 text-xs leading-relaxed text-muted-foreground @xl:px-5">
        Every dream lands here: what {agentName} reviewed, what it changed in its memory and why — with a line-by-line diff and a way to undo it.
      </p>
    );
  }
  const shown = showAll ? dreams : dreams.slice(0, JOURNAL_PREVIEW);
  const older = dreams.length - JOURNAL_PREVIEW;
  return (
    <div className="border-t">
      <h3 className="eyebrow px-4 pt-3.5 @xl:px-5">Dream journal</h3>
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
          {showAll ? "Show fewer" : `Show ${plural(older, "older dream")}`}
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
        <time dateTime={d.createdAt} title={format(new Date(d.createdAt), "PPpp")} className="text-[13px] font-medium">
          {dreamWhen(d.createdAt)}
        </time>
        <DreamReasonBadge reason={d.reason} />
        <DreamStatusBadge status={d.status} />
        {!active && (
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums" title={format(at, "PPpp")}>
            {formatDistanceToNowStrict(at, { addSuffix: true })}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{reviewedLabel(d)}</p>

      {d.summary ? (
        <p className={cn("mt-2 max-w-3xl text-sm leading-relaxed text-pretty", rolledBack && "text-muted-foreground")}>{d.summary}</p>
      ) : active ? (
        <p className="text-shimmer mt-2 text-sm">Consolidating memory…</p>
      ) : null}

      {rolledBack && d.changes.length > 0 && (
        <p className="mt-2.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <RotateCcw className="size-3 shrink-0" aria-hidden />
          {d.files.length ? "Attempted — rolled back where possible" : "Attempted — rolled back, nothing was kept"}
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
                  {allChanges ? "Show fewer changes" : `Show ${plural(d.changes.length - CHANGES_PREVIEW, "more change")}`}
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
        <p className="mt-2 text-xs text-muted-foreground">Memory was already in good shape — nothing to rewrite.</p>
      )}

      {(d.changes.length > 0 || d.files.length > 0) && (
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
              {open ? "Hide changes" : plural(d.changes.length, rolledBack ? "attempted change" : "change")}
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
            {d.files.length > 0 && (
              <Button variant="outline" size="xs" onClick={() => onReview(d)}>
                <Eye /> Review changes
              </Button>
            )}
            {d.canRevert && undoBlocked ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                    <Button variant="ghost" size="xs" disabled aria-label={`Undo the dream of ${dreamWhen(d.createdAt)}`}>
                      <Undo2 /> Undo
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Available once the current dream has ended</TooltipContent>
              </Tooltip>
            ) : d.canRevert ? (
              <Button variant="ghost" size="xs" onClick={() => onUndo(d)} aria-label={`Undo the dream of ${dreamWhen(d.createdAt)}`}>
                <Undo2 /> Undo
              </Button>
            ) : d.files.length > 0 && !active && d.status !== "reverted" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className="cursor-default rounded-sm px-1 text-[11px] text-muted-foreground/80 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    Edited since — can't undo
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-60 text-center">
                  These files changed after the dream, so it can't be undone automatically. Edit them below instead.
                </TooltipContent>
              </Tooltip>
            ) : null}
          </span>
        </div>
      )}
    </motion.li>
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
