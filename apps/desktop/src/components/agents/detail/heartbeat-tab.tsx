import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { motion } from "motion/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import { format, isThisYear, isToday, isYesterday } from "date-fns";
import { BellRing, ChevronDown, HeartPulse, Hourglass, ListChecks, Repeat2, RotateCcw, ShieldCheck, Timer, Zap, type LucideIcon } from "lucide-react";
import {
  HEARTBEAT_INTERVALS,
  MAX_HEARTBEAT_CHECKLIST_LENGTH,
  normalizeHeartbeat,
  type Agent,
  type AgentHeartbeat,
  type AgentHeartbeatInput,
  type AgentHeartbeatState,
  type HeartbeatBeat,
  type HeartbeatOutcome,
  type HeartbeatWakeReason,
  type WatchdogEvent,
  type WatchdogKind,
} from "@godmode/shared";
import { api, errorMessage, isLicenseRequired } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useSettings } from "@/lib/hooks";
import { useEasyMode } from "@/lib/mode";
import { cn } from "@/lib/utils";
import { dateLocale, intlLocale, t } from "@/i18n";
import { Markdown } from "@/components/chat/markdown";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/components/runs/run-row";
import { Segmented, SettingRow, SettingsGroup } from "@/components/settings/settings-kit";
import { upcomingWhen } from "./dream-parts";

const BEATS_PREVIEW = 10;
const WORKING_HOURS = { from: 8, to: 18 };

/** "every hour", "every 4 hours", "once a day" */
function intervalText(minutes: number) {
  if (minutes >= 1440) return t("agents:heartbeatTab.interval.daily");
  if (minutes === 60) return t("agents:heartbeatTab.interval.hourly");
  if (minutes > 60) return t("agents:heartbeatTab.interval.hours", { count: Math.round(minutes / 60) });
  return t("agents:heartbeatTab.interval.minutes", { count: minutes });
}

/** "15 min", "1 h", "4 h", "Daily" */
function intervalLabel(minutes: number) {
  if (minutes >= 1440) return t("agents:heartbeatTab.interval.dailyShort");
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/** Realtime ("heartbeats" entity) keeps it fresh; polling covers the board, and a timer refetches right after the next beat. */
function useHeartbeatState(agentId: string) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: qk.agentHeartbeat(agentId),
    queryFn: () => api.agents.heartbeat(agentId),
    refetchInterval: 60_000,
  });
  const next = q.data?.nextAt ?? null;
  useEffect(() => {
    if (!next) return;
    const wait = Date.parse(next) - Date.now() + 5_000;
    if (wait <= 0 || wait > 2_147_483_647) return;
    const timer = setTimeout(() => qc.invalidateQueries({ queryKey: qk.agentHeartbeat(agentId) }), wait);
    return () => clearTimeout(timer);
  }, [next, agentId, qc]);
  return q;
}

/** Optimistic: the agent's heartbeat changes right away and rolls back when the core refuses. */
function useSaveHeartbeat(agent: Agent) {
  const { t } = useTranslation("agents");
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (heartbeat: AgentHeartbeatInput) => api.agents.update(agent.id, { heartbeat }),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: qk.agent(agent.id) });
      const prev = qc.getQueryData<Agent>(qk.agent(agent.id));
      if (prev) qc.setQueryData<Agent>(qk.agent(agent.id), { ...prev, heartbeat: { ...normalizeHeartbeat(prev.heartbeat), ...patch } });
      return { prev };
    },
    onError: (err, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.agent(agent.id), ctx.prev);
      toast.error(t("heartbeatTab.toast.saveError"), { description: errorMessage(err) });
    },
    onSuccess: (updated) => {
      qc.setQueryData(qk.agent(agent.id), updated);
      qc.invalidateQueries({ queryKey: qk.agents });
      qc.invalidateQueries({ queryKey: qk.agentHeartbeat(agent.id) });
    },
  });
}

type SaveHeartbeat = ReturnType<typeof useSaveHeartbeat>;

export function HeartbeatTab({ agent }: { agent: Agent }) {
  const q = useHeartbeatState(agent.id);
  const save = useSaveHeartbeat(agent);
  const hb = normalizeHeartbeat(agent.heartbeat);

  return (
    <div className="space-y-6">
      <Hero agent={agent} hb={hb} state={q.data} error={q.isError ? q.error : null} onRetry={() => q.refetch()} save={save} />
      <Rhythm hb={hb} save={save} />
      <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-[minmax(0,1fr)_340px]">
        <RecentBeats agent={agent} hb={hb} state={q.data} loading={q.isLoading} />
        <WatchdogPanel events={q.data?.watchdog} loading={q.isLoading} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hero: on/off, where it stands, "Wake now" and the board             */
/* ------------------------------------------------------------------ */

function Hero({
  agent,
  hb,
  state,
  error,
  onRetry,
  save,
}: {
  agent: Agent;
  hb: AgentHeartbeat;
  state: AgentHeartbeatState | undefined;
  error: unknown;
  onRetry: () => void;
  save: SaveHeartbeat;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const now = useNow(hb.enabled, 30_000);
  const live = hb.enabled && agent.enabled;
  const easy = useEasyMode();

  const beat = useMutation({
    mutationFn: () => api.agents.beat(agent.id),
    onSuccess: (b) => {
      qc.setQueryData<AgentHeartbeatState>(qk.agentHeartbeat(agent.id), (old) => (old ? { ...old, beats: [b, ...old.beats.filter((x) => x.id !== b.id)] } : old));
      qc.invalidateQueries({ queryKey: qk.agentHeartbeat(agent.id) });
      qc.invalidateQueries({ queryKey: qk.runs });
      if (b.outcome === "failed") toast.error(t("heartbeatTab.toast.beatFailed"), { description: b.summary });
      else if (b.outcome === "woke")
        toast.success(t("heartbeatTab.toast.onIt", { name: agent.name }), {
          description: b.summary,
          action: b.conversationId ? { label: t("heartbeatTab.watch"), onClick: () => navigate(`/chat/${b.conversationId}`) } : undefined,
        });
      else toast(b.outcome === "quiet" ? t("heartbeatTab.toast.allQuiet") : t("heartbeatTab.toast.skipped"), { description: b.summary });
    },
    onError: (err) => !isLicenseRequired(err) && toast.error(t("heartbeatTab.toast.wakeError", { name: agent.name }), { description: errorMessage(err) }),
  });

  const titleId = `heartbeat-${agent.id}`;
  const wake = (
    <Button size="sm" variant="outline" disabled={!agent.enabled || beat.isPending} onClick={() => beat.mutate()}>
      {beat.isPending ? <Spinner /> : <Zap />} {t("heartbeatTab.wakeNow")}
    </Button>
  );

  return (
    <section aria-labelledby={titleId} className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex flex-wrap items-start gap-x-3.5 gap-y-3 px-4 py-4 @xl:px-5">
        <div
          aria-hidden
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-lg border bg-paper-2 transition-colors duration-500 calm-motion:duration-250 [&_svg]:size-[18px]",
            live ? "border-brand/25 bg-brand-soft text-brand-strong" : "text-muted-foreground",
          )}
        >
          <HeartPulse />
        </div>
        <div className="min-w-0 flex-1 basis-64">
          <h2 id={titleId} className="text-sm font-medium tracking-[-0.01em]">
            {easy ? t("heartbeatTab.titleEasy") : t("heartbeatTab.title")}
          </h2>
          <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-muted-foreground">
            {easy
              ? t("heartbeatTab.introEasy", { name: agent.name })
              : t("heartbeatTab.introPro", { name: agent.name })}
          </p>
          {error ? (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-destructive">
              {t("heartbeatTab.loadError", { error: errorMessage(error) })}
              <Button size="xs" variant="ghost" onClick={onRetry}>
                {t("common:actions.tryAgain")}
              </Button>
            </p>
          ) : (
            <p className="mt-2 flex items-center gap-1.5 text-xs" aria-live="polite">
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", live ? "bg-brand" : "bg-muted-foreground/40")} />
              <span className={live ? "font-medium text-foreground" : "text-muted-foreground"}>{statusLine(agent, hb, state, now)}</span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Ekg live={live} className="hidden @2xl:block" />
          {agent.enabled ? (
            wake
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                  {wake}
                </span>
              </TooltipTrigger>
              <TooltipContent>{t("heartbeatTab.switchOnFirst", { name: agent.name })}</TooltipContent>
            </Tooltip>
          )}
          <label className="flex cursor-pointer items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-card">
            <Switch
              checked={hb.enabled}
              onCheckedChange={(enabled) => save.mutate({ enabled })}
              aria-label={hb.enabled ? t("heartbeatTab.switchOff", { name: agent.name }) : t("heartbeatTab.switchOn", { name: agent.name })}
            />
            <span className="@max-md:sr-only">{hb.enabled ? t("common:status.on") : t("common:status.off")}</span>
          </label>
        </div>
      </div>
      <BoardStrip agentId={agent.id} board={state?.board} />
    </section>
  );
}

/** "Beats every hour · 8:00 AM–6:00 PM · weekdays · next at 10:30 AM" or "Off". */
function statusLine(agent: Agent, hb: AgentHeartbeat, state: AgentHeartbeatState | undefined, now: number) {
  if (!hb.enabled) return t("common:status.off");
  const parts = [t("agents:heartbeatTab.status.beats", { interval: intervalText(hb.intervalMinutes) })];
  if (hb.hours) parts.push(`${hourLabel(hb.hours.from)}–${hourLabel(hb.hours.to)}`);
  if (hb.weekdays) parts.push(t("agents:heartbeatTab.status.weekdays"));
  if (!agent.enabled) parts.push(t("agents:heartbeatTab.status.agentOff", { name: agent.name }));
  else if (state?.nextAt) parts.push(nextLabel(state.nextAt, now));
  else if (state) parts.push(t("agents:heartbeatTab.status.noHour"));
  return parts.join(" · ");
}

function nextLabel(iso: string, now: number) {
  const d = new Date(iso);
  if (d.getTime() <= now) return t("agents:heartbeatTab.status.dueNow");
  return isToday(d) ? t("agents:heartbeatTab.status.nextAt", { time: format(d, "p", { locale: dateLocale() }) }) : t("agents:heartbeatTab.status.next", { when: upcomingWhen(iso, now) });
}

function hourLabel(hour: number) {
  return format(new Date(2000, 0, 1, hour % 24), "p", { locale: dateLocale() });
}

/** A heart trace: a bright pulse runs along it while the heartbeat is on, a flat line while it is off. */
const EKG_PATH = "M0 16H40l3-3 3 3h5l3 6 5-19 4 17 3-4h4l3-2 3 2H120";

function Ekg({ live, className }: { live: boolean; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 120 28" fill="none" strokeLinecap="round" strokeLinejoin="round" className={cn("h-7 w-30 shrink-0 overflow-visible", className)}>
      {live ? (
        <>
          <path d={EKG_PATH} strokeWidth={1.5} className="stroke-brand/25" />
          <path
            d={EKG_PATH}
            pathLength={100}
            strokeDasharray="28 200"
            strokeDashoffset={28}
            strokeWidth={1.75}
            className="stroke-brand motion-safe:animate-ekg motion-reduce:[stroke-dasharray:none]"
          />
        </>
      ) : (
        <path d="M0 16H120" strokeWidth={1.5} className="stroke-muted-foreground/30" />
      )}
    </svg>
  );
}

const BOARD = [
  { key: "working", labelKey: "heartbeatTab.board.working" },
  { key: "waiting", labelKey: "heartbeatTab.board.waiting" },
  { key: "waitingOnYou", labelKey: "heartbeatTab.board.waitingOnYou", tone: "text-warning" },
  { key: "blocked", labelKey: "heartbeatTab.board.blocked", tone: "text-destructive" },
] as const satisfies readonly { key: keyof AgentHeartbeatState["board"]; labelKey: string; tone?: string }[];

function BoardStrip({ agentId, board }: { agentId: string; board: AgentHeartbeatState["board"] | undefined }) {
  const { t } = useTranslation("agents");
  return (
    <div className="grid grid-cols-2 border-t @xl:grid-cols-4">
      {BOARD.map((b, i) => {
        const n = board?.[b.key];
        return (
          <Link
            key={b.key}
            to={`/tasks?agent=${agentId}`}
            className={cn(
              "px-4 py-3 transition hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset @xl:px-5",
              i % 2 === 1 && "border-l",
              i >= 2 && "border-t @xl:border-t-0",
              i === 2 && "@xl:border-l",
            )}
          >
            <div className="eyebrow text-[10.5px]">{t(b.labelKey)}</div>
            {n == null ? (
              <Skeleton className="mt-1 h-6 w-8" />
            ) : (
              <div className={cn("mt-0.5 text-xl font-medium tracking-[-0.03em] tabular-nums", n > 0 ? ("tone" in b ? b.tone : undefined) : "text-muted-foreground/70")}>{n}</div>
            )}
          </Link>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rhythm: interval, hours, weekdays and the standing checklist        */
/* ------------------------------------------------------------------ */

function Rhythm({ hb, save }: { hb: AgentHeartbeat; save: SaveHeartbeat }) {
  const { t } = useTranslation("agents");
  const hours = hb.hours;
  return (
    <SettingsGroup title={t("heartbeatTab.rhythm.title")} icon={<Timer />} description={t("heartbeatTab.rhythm.description")}>
      <SettingRow label={t("heartbeatTab.rhythm.every")}>
        <Segmented
          aria-label={t("heartbeatTab.rhythm.intervalAria")}
          value={String(hb.intervalMinutes)}
          onChange={(v) => save.mutate({ intervalMinutes: Number(v) })}
          options={HEARTBEAT_INTERVALS.map((m) => ({ value: String(m), label: <span className="normal-case">{intervalLabel(m)}</span> }))}
        />
      </SettingRow>
      <SettingRow label={t("heartbeatTab.rhythm.when")} description={hours ? t("heartbeatTab.rhythm.whenHours") : t("heartbeatTab.rhythm.whenAny")}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {hours && (
            <span className="flex items-center gap-1.5">
              <HourSelect
                aria-label={t("heartbeatTab.rhythm.from")}
                value={hours.from}
                hours={range(0, 23).filter((h) => h !== hours.to % 24)}
                onChange={(from) => save.mutate({ hours: { ...hours, from } })}
              />
              <span className="text-xs text-muted-foreground">{t("heartbeatTab.rhythm.to")}</span>
              <HourSelect
                aria-label={t("heartbeatTab.rhythm.toAria")}
                value={hours.to}
                hours={range(1, 24).filter((h) => h % 24 !== hours.from)}
                onChange={(to) => save.mutate({ hours: { ...hours, to } })}
              />
            </span>
          )}
          <Segmented
            aria-label={t("heartbeatTab.rhythm.whenAria")}
            value={hours ? "hours" : "any"}
            onChange={(v) => save.mutate({ hours: v === "hours" ? WORKING_HOURS : null })}
            options={[
              { value: "any", label: <span className="normal-case">{t("heartbeatTab.rhythm.anyTime")}</span> },
              { value: "hours", label: <span className="normal-case">{t("heartbeatTab.rhythm.workingHours")}</span> },
            ]}
          />
        </div>
      </SettingRow>
      <SettingRow label={t("heartbeatTab.rhythm.weekdaysOnly")} htmlFor="hb-weekdays" description={t("heartbeatTab.rhythm.weekdaysDescription")}>
        <Switch id="hb-weekdays" checked={hb.weekdays} onCheckedChange={(weekdays) => save.mutate({ weekdays })} />
      </SettingRow>
      <SettingRow
        stacked
        label={t("heartbeatTab.rhythm.checklist")}
        htmlFor="hb-checklist"
        description={t("heartbeatTab.rhythm.checklistDescription")}
      >
        <ChecklistField value={hb.checklist} save={save} />
      </SettingRow>
    </SettingsGroup>
  );
}

function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function HourSelect({ value, hours, onChange, "aria-label": ariaLabel }: { value: number; hours: number[]; onChange: (hour: number) => void; "aria-label": string }) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger size="sm" aria-label={ariaLabel} className="w-28 tabular-nums">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {hours.map((h) => (
          <SelectItem key={h} value={String(h)} className="tabular-nums">
            {hourLabel(h)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Saves when it loses focus; "Saved" shows for a moment after. */
function ChecklistField({ value, save }: { value: string; save: SaveHeartbeat }) {
  const { t } = useTranslation(["agents", "common"]);
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  const commit = () => {
    focused.current = false;
    const next = draft.trim();
    if (next === value.trim()) return;
    setDraft(next);
    setSaved(false);
    save.mutate({ checklist: next }, { onSuccess: () => setSaved(true) });
  };

  const pending = save.isPending && save.variables?.checklist !== undefined;
  const nearLimit = draft.length > MAX_HEARTBEAT_CHECKLIST_LENGTH * 0.9;

  return (
    <div>
      <Textarea
        id="hb-checklist"
        value={draft}
        maxLength={MAX_HEARTBEAT_CHECKLIST_LENGTH}
        placeholder={t("heartbeatTab.checklistPlaceholder")}
        className="min-h-20 text-[13px] leading-relaxed"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={commit}
      />
      <div className="mt-1.5 flex h-4 items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span aria-live="polite">
          {pending ? (
            t("common:status.saving")
          ) : saved ? (
            <motion.span initial={{ opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-1.5 rounded-full bg-brand" />
              {t("common:status.saved")}
            </motion.span>
          ) : null}
        </span>
        {draft.length > 0 && (
          <span className={cn("tabular-nums", nearLimit && "text-warning")}>
            {draft.length.toLocaleString(intlLocale())} / {MAX_HEARTBEAT_CHECKLIST_LENGTH.toLocaleString(intlLocale())}
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Recent beats                                                         */
/* ------------------------------------------------------------------ */

const OUTCOME = {
  woke: { labelKey: "heartbeatTab.outcome.woke", dot: "bg-brand" },
  quiet: { labelKey: "heartbeatTab.outcome.quiet", dot: "bg-muted-foreground/40" },
  skipped: { labelKey: "heartbeatTab.outcome.skipped", dot: "bg-warning" },
  failed: { labelKey: "heartbeatTab.outcome.failed", dot: "bg-destructive" },
} as const satisfies Record<HeartbeatOutcome, { labelKey: string; dot: string }>;

const WHY = {
  stalled: "heartbeatTab.why.stalled",
  unstarted: "heartbeatTab.why.unstarted",
  retry: "heartbeatTab.why.retry",
} as const satisfies Record<HeartbeatWakeReason, string>;

type BeatItem = { kind: "beat"; beat: HeartbeatBeat } | { kind: "quiet"; beats: HeartbeatBeat[] };

/** Runs of consecutive quiet beats fold into one row. */
function groupBeats(beats: HeartbeatBeat[]): BeatItem[] {
  const out: BeatItem[] = [];
  for (const b of beats) {
    const last = out[out.length - 1];
    if (b.outcome === "quiet" && last?.kind === "quiet") last.beats.push(b);
    else out.push(b.outcome === "quiet" ? { kind: "quiet", beats: [b] } : { kind: "beat", beat: b });
  }
  return out.map((item) => (item.kind === "quiet" && item.beats.length === 1 ? { kind: "beat", beat: item.beats[0]! } : item));
}

/** "10:30 AM" today, "Yesterday, 10:30 AM", "Mon, Oct 5, 10:30 AM". */
function beatTime(iso: string) {
  const d = new Date(iso);
  const locale = dateLocale();
  if (isToday(d)) return format(d, "p", { locale });
  if (isYesterday(d)) return t("agents:heartbeatTab.time.yesterday", { time: format(d, "p", { locale }) });
  return format(d, isThisYear(d) ? t("agents:heartbeatTab.time.thisYearFormat") : t("agents:heartbeatTab.time.otherYearFormat"), { locale });
}

function RecentBeats({ agent, hb, state, loading }: { agent: Agent; hb: AgentHeartbeat; state: AgentHeartbeatState | undefined; loading: boolean }) {
  const { t } = useTranslation("agents");
  const [showAll, setShowAll] = useState(false);
  const items = groupBeats(state?.beats ?? []);
  const shown = showAll ? items : items.slice(0, BEATS_PREVIEW);
  const older = items.length - BEATS_PREVIEW;

  return (
    <section aria-labelledby={`beats-${agent.id}`} className="min-w-0 rounded-xl border bg-card shadow-card">
      <h2 id={`beats-${agent.id}`} className="px-4 pt-4 pb-3 text-sm font-medium tracking-[-0.01em] @xl:px-5">
        {t("heartbeatTab.recent.title")}
      </h2>
      {loading ? (
        <div className="space-y-2 px-4 pb-4 @xl:px-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="border-t px-4 py-8 text-center text-sm text-muted-foreground">
          {!hb.enabled
            ? t("heartbeatTab.recent.emptyOff")
            : state?.nextAt && agent.enabled
              ? t("heartbeatTab.recent.emptyNext", { when: upcomingWhen(state.nextAt) })
              : t("heartbeatTab.recent.empty")}
        </p>
      ) : (
        <>
          <ol className="px-4 pt-1 pb-3 @xl:px-5">
            {shown.map((item, i) => {
              const isLast = i === shown.length - 1;
              return item.kind === "quiet" ? (
                <QuietRow key={item.beats[0]!.id} beats={item.beats} isLast={isLast} />
              ) : (
                <BeatRow key={item.beat.id} beat={item.beat} isLast={isLast} />
              );
            })}
          </ol>
          {older > 0 && (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((v) => !v)}
              className="flex w-full items-center gap-1.5 rounded-b-xl border-t px-4 py-2.5 text-left text-xs font-medium text-muted-foreground transition hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none @xl:px-5"
            >
              <ChevronDown className={cn("size-3.5 transition-transform", showAll && "rotate-180")} aria-hidden />
              {showAll ? t("heartbeatTab.recent.showFewer") : t("heartbeatTab.recent.showOlder", { count: older })}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function TimelineItem({ dot, isLast, children }: { dot: string; isLast: boolean; children: ReactNode }) {
  return (
    <li className={cn("relative pl-6", isLast ? "pb-1" : "pb-4")}>
      {!isLast && <span aria-hidden className="absolute top-4 -bottom-0.5 left-[4.5px] w-px bg-border" />}
      <span aria-hidden className={cn("absolute top-[5px] left-0 size-2.5 rounded-full ring-4 ring-card", dot)} />
      {children}
    </li>
  );
}

function BeatRow({ beat: b, isLast }: { beat: HeartbeatBeat; isLast: boolean }) {
  const { t } = useTranslation("agents");
  const meta = OUTCOME[b.outcome] ?? OUTCOME.quiet;
  return (
    <TimelineItem dot={meta.dot} isLast={isLast}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <time dateTime={b.createdAt} title={format(new Date(b.createdAt), "PPpp", { locale: dateLocale() })} className="text-[13px] font-medium tabular-nums">
          {beatTime(b.createdAt)}
        </time>
        <span className="text-xs text-muted-foreground">
          {t(meta.labelKey)}
          {b.reason === "now" && ` · ${t("heartbeatTab.wakeNow")}`}
        </span>
        {b.changes > 0 && <span className="ml-auto text-[11px] text-muted-foreground">{t("heartbeatTab.changesSinceBeat", { count: b.changes })}</span>}
      </div>
      {b.summary && <p className={cn("mt-0.5 max-w-3xl text-sm leading-relaxed text-pretty", b.outcome === "quiet" && "text-muted-foreground")}>{b.summary}</p>}
      {b.wakes.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {b.wakes.map((w) => (
            <Tooltip key={w.taskId}>
              <TooltipTrigger asChild>
                <Link
                  to={`/tasks?task=${w.taskId}`}
                  className="inline-flex h-5 max-w-full items-center gap-1 rounded-[5px] border bg-paper-2 px-1.5 text-[11px] text-muted-foreground transition hover:border-foreground/25 hover:text-foreground"
                >
                  <span className="font-mono tabular-nums">#{w.number}</span>
                  <span className="max-w-[14rem] truncate">{w.title}</span>
                </Link>
              </TooltipTrigger>
              <TooltipContent>
                {WHY[w.why] ? t(WHY[w.why]) : t("heartbeatTab.why.default")}
                {w.changes > 0 && ` · ${t("heartbeatTab.changesSinceWork", { count: w.changes })}`}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}
      {b.runId && <ChecklistResult beat={b} />}
    </TimelineItem>
  );
}

function QuietRow({ beats, isLast }: { beats: HeartbeatBeat[]; isLast: boolean }) {
  const { t } = useTranslation("agents");
  const newest = new Date(beats[0]!.createdAt);
  const oldest = beats[beats.length - 1]!.createdAt;
  const sameDay = newest.toDateString() === new Date(oldest).toDateString();
  return (
    <TimelineItem dot={OUTCOME.quiet.dot} isLast={isLast}>
      <p className="text-[13px] text-muted-foreground">
        <span className="font-medium text-foreground/80">{t("heartbeatTab.outcome.quiet")}</span> · {t("heartbeatTab.beatCount", { count: beats.length })} ·{" "}
        <span className="tabular-nums">
          {beatTime(oldest)}–{sameDay ? format(newest, "p", { locale: dateLocale() }) : beatTime(beats[0]!.createdAt)}
        </span>
      </p>
    </TimelineItem>
  );
}

const RUN_STATE: Record<string, { labelKey: "heartbeatTab.runState.queued" | "heartbeatTab.runState.running" | "heartbeatTab.runState.paused" | "heartbeatTab.runState.failed" | "heartbeatTab.runState.cancelled"; className?: string }> = {
  queued: { labelKey: "heartbeatTab.runState.queued", className: "text-shimmer" },
  running: { labelKey: "heartbeatTab.runState.running", className: "text-shimmer" },
  paused: { labelKey: "heartbeatTab.runState.paused" },
  failed: { labelKey: "heartbeatTab.runState.failed", className: "text-destructive" },
  cancelled: { labelKey: "heartbeatTab.runState.cancelled" },
};

function ChecklistResult({ beat: b }: { beat: HeartbeatBeat }) {
  const { t } = useTranslation(["agents", "common"]);
  const [open, setOpen] = useState(false);
  const state = b.runStatus && b.runStatus !== "succeeded" ? RUN_STATE[b.runStatus] : undefined;
  const running = b.runStatus === "running" || b.runStatus === "queued";
  const long = !!b.result && (b.result.length > 180 || b.result.includes("\n"));

  return (
    <div className="mt-2 max-w-3xl rounded-lg border bg-paper-2/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <ListChecks className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium text-foreground/80">{t("heartbeatTab.checklist")}</span>
        {state && <span className={state.className}>{t(state.labelKey)}</span>}
        <span className="ml-auto flex items-center gap-3">
          {b.conversationId && (
            <Link to={`/chat/${b.conversationId}`} className="font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline">
              {running ? t("heartbeatTab.watch") : t("heartbeatTab.openChat")}
            </Link>
          )}
        </span>
      </div>
      {b.result &&
        (open ? (
          <Markdown className="mt-1.5 text-[13px]">{b.result}</Markdown>
        ) : (
          <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{plainText(b.result)}</p>
        ))}
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
        >
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
          {open ? t("common:actions.showLess") : t("heartbeatTab.showAll")}
        </button>
      )}
    </div>
  );
}

/** Markdown flattened to one readable line for the collapsed preview. */
function plainText(md: string) {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~#>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Watchdog                                                             */
/* ------------------------------------------------------------------ */

const KIND = {
  stalled: { labelKey: "heartbeatTab.watchdog.kind.stalled", icon: Hourglass },
  looping: { labelKey: "heartbeatTab.watchdog.kind.looping", icon: Repeat2 },
} as const satisfies Record<WatchdogKind, { labelKey: string; icon: LucideIcon }>;

const ACTION = {
  retry: { labelKey: "heartbeatTab.watchdog.action.retry", icon: RotateCcw },
  escalated: { labelKey: "heartbeatTab.watchdog.action.escalated", icon: BellRing },
} as const satisfies Record<WatchdogEvent["action"], { labelKey: string; icon: LucideIcon }>;

const settingsLink = "font-medium text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground";

function WatchdogPanel({ events, loading }: { events: WatchdogEvent[] | undefined; loading: boolean }) {
  const { t } = useTranslation("agents");
  const on = useSettings().data?.runner.watchdog ?? true;
  const list = events ?? [];
  return (
    <section aria-labelledby="watchdog-heading" className="min-w-0 self-start rounded-xl border bg-card shadow-card">
      <div className="px-4 pt-4 pb-3">
        <h2 id="watchdog-heading" className="flex items-center gap-2 text-sm font-medium tracking-[-0.01em]">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
          {t("heartbeatTab.watchdog.title")}
        </h2>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          <Trans
            t={t}
            i18nKey={on ? "heartbeatTab.watchdog.descriptionOn" : "heartbeatTab.watchdog.descriptionOff"}
            components={{ link: <Link to="/settings/ai" className={settingsLink} /> }}
          />
        </p>
      </div>
      {loading ? (
        <div className="px-4 pb-4">
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      ) : list.length === 0 ? (
        <p className="border-t px-4 py-8 text-center text-sm text-muted-foreground">{on ? t("heartbeatTab.watchdog.emptyOn") : t("heartbeatTab.watchdog.empty")}</p>
      ) : (
        <ul className="divide-y border-t">
          {list.map((e) => (
            <WatchdogRow key={e.id} event={e} />
          ))}
        </ul>
      )}
    </section>
  );
}

function WatchdogRow({ event: e }: { event: WatchdogEvent }) {
  const { t } = useTranslation("agents");
  const kind = KIND[e.kind] ?? KIND.stalled;
  const action = ACTION[e.action] ?? ACTION.escalated;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex h-5 items-center gap-1 rounded-[5px] border border-warning/30 bg-warning/[0.07] px-1.5 text-[11px] font-medium text-warning">
          <kind.icon className="size-3" aria-hidden />
          {t(kind.labelKey)}
        </span>
        <time dateTime={e.createdAt} title={format(new Date(e.createdAt), "PPpp", { locale: dateLocale() })} className="text-xs text-muted-foreground tabular-nums">
          {beatTime(e.createdAt)}
        </time>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-pretty">{e.report}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className={cn("inline-flex items-center gap-1", e.action === "escalated" && "font-medium text-foreground/80")}>
          <action.icon className="size-3" aria-hidden />
          {t(action.labelKey)}
        </span>
        <span className="ml-auto flex items-center gap-3">
          {e.taskId && (
            <Link to={`/tasks?task=${e.taskId}`} className="underline-offset-2 hover:text-foreground hover:underline">
              {t("heartbeatTab.watchdog.ticket")} <span className="font-mono tabular-nums">#{e.taskNumber}</span>
            </Link>
          )}
          <Link to={`/chat/${e.conversationId}`} className="underline-offset-2 hover:text-foreground hover:underline">
            {t("heartbeatTab.openChat")}
          </Link>
        </span>
      </div>
    </li>
  );
}
