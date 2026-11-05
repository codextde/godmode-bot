import { useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, ClipboardCheck, History, Play, Square, Undo2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNowStrict } from "date-fns";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { Review, ReviewFinding, ReviewSettings, Settings } from "@godmode/shared";
import { cronToHuman } from "@/components/agents/cron";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useLocale } from "@/i18n/language";
import { cn } from "@/lib/utils";
import { SectionHeading, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

const SCHEDULES = [
  { cron: "0 5 * * *", labelKey: "review.schedules.morning" },
  { cron: "0 2 * * *", labelKey: "review.schedules.night" },
  { cron: "0 7 * * 1-5", labelKey: "review.schedules.weekdays" },
  { cron: "0 5 * * 0", labelKey: "review.schedules.sunday" },
] as const;

const ACTIVE = new Set(["queued", "running"]);

export function ReviewSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const { patch } = useSettingsPatch();
  const r = settings.review;
  const onChange = (next: Partial<ReviewSettings>) => patch({ review: next });
  const overview = useQuery({
    queryKey: qk.reviews,
    queryFn: () => api.reviews.overview(),
    refetchInterval: (q) => (q.state.data?.active ? 5_000 : 60_000),
  });
  const active = overview.data?.active ?? null;

  return (
    <div className="space-y-5">
      <SectionHeading title={t("review.title")} description={t("review.description")} />

      <SettingsGroup title={t("review.schedule")} icon={<ClipboardCheck />} actions={<ReviewNow active={active} />}>
        <SettingRow label={t("review.enabled")} htmlFor="review-enabled">
          <Switch id="review-enabled" checked={r.enabled} onCheckedChange={(enabled) => onChange({ enabled })} />
        </SettingRow>
        <SettingRow
          label={t("review.when")}
          htmlFor="review-when"
          disabled={!r.enabled}
          description={r.enabled && overview.data?.nextReviewAt ? <NextAt iso={overview.data.nextReviewAt} /> : undefined}
        >
          <ScheduleSelect cron={r.cron} disabled={!r.enabled} onChange={(cron) => onChange({ cron })} />
        </SettingRow>
        <SettingRow label={t("review.autoFix")} htmlFor="review-fix" description={r.autoFix ? undefined : t("review.reportOnly")}>
          <Switch id="review-fix" checked={r.autoFix} onCheckedChange={(autoFix) => onChange({ autoFix })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("review.history")} icon={<History />} bodyClassName="px-0">
        {overview.isLoading ? (
          <div className="grid place-items-center py-10">
            <Spinner />
          </div>
        ) : overview.data?.reviews.length ? (
          <ul className="divide-y">
            {overview.data.reviews.map((review, i) => (
              <ReviewRow key={review.id} review={review} defaultOpen={i === 0 && !ACTIVE.has(review.status)} />
            ))}
          </ul>
        ) : (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">{t("review.empty")}</p>
        )}
      </SettingsGroup>
    </div>
  );
}

function NextAt({ iso }: { iso: string }) {
  const { t } = useTranslation("settings");
  const { dateLocale } = useLocale();
  return <span>{t("review.next", { when: format(new Date(iso), "EEE p", { locale: dateLocale }) })}</span>;
}

function ReviewNow({ active }: { active: Review | null }) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const start = useMutation({
    mutationFn: () => api.reviews.start(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.reviews });
      toast.success(t("review.started"));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const stop = useMutation({
    mutationFn: (runId: string) => api.runs.cancel(runId),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.reviews }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (active) {
    return (
      <Button variant="outline" size="sm" disabled={!active.runId || stop.isPending} onClick={() => active.runId && stop.mutate(active.runId)}>
        {stop.isPending ? <Spinner /> : <Square />} {t("review.stop")}
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" disabled={start.isPending} onClick={() => start.mutate()}>
      {start.isPending ? <Spinner /> : <Play />} {t("review.now")}
    </Button>
  );
}

function ScheduleSelect({ cron, disabled, onChange }: { cron: string; disabled: boolean; onChange: (cron: string) => void }) {
  const { t } = useTranslation("settings");
  const normalized = cron.trim().replace(/\s+/g, " ");
  const custom = !SCHEDULES.some((s) => s.cron === normalized);
  return (
    <Select value={normalized} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger id="review-when" className="w-full @xl:w-60">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SCHEDULES.map((s) => (
          <SelectItem key={s.cron} value={s.cron}>
            {t(s.labelKey)}
          </SelectItem>
        ))}
        {custom && <SelectItem value={normalized}>{cronToHuman(normalized)}</SelectItem>}
      </SelectContent>
    </Select>
  );
}

const SEVERITY_DOT: Record<ReviewFinding["severity"], string> = {
  critical: "bg-destructive",
  warning: "bg-warning",
  info: "bg-muted-foreground/40",
};

function ReviewRow({ review: r, defaultOpen }: { review: Review; defaultOpen: boolean }) {
  const { t } = useTranslation("settings");
  const { dateLocale } = useLocale();
  const [open, setOpen] = useState(defaultOpen);
  const running = ACTIVE.has(r.status);
  const forYou = r.findings.filter((f) => f.forHuman);
  const at = new Date(r.startedAt ?? r.createdAt);
  const summary = running ? t("review.running") : r.summary || r.error || t(`review.status.${r.status}`);
  const expandable = !running && (r.findings.length > 0 || r.actions.length > 0 || r.scores.length > 0);

  return (
    <li>
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 px-5 py-3.5 text-left transition-colors enabled:hover:bg-accent/40"
      >
        <span className="mt-1.5 grid size-2 shrink-0 place-items-center">
          {running ? (
            <Spinner className="size-3" />
          ) : (
            <span className={cn("size-2 rounded-full", r.status === "succeeded" ? "bg-success" : r.status === "cancelled" ? "bg-muted-foreground/40" : "bg-destructive")} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <time dateTime={at.toISOString()} title={format(at, "PPpp", { locale: dateLocale })} className="text-[13px] font-medium">
              {format(at, "EEE d MMM, p", { locale: dateLocale })}
            </time>
            <span className="text-[11px] text-muted-foreground">{formatDistanceToNowStrict(at, { addSuffix: true, locale: dateLocale })}</span>
          </span>
          <span className={cn("mt-0.5 block text-sm leading-relaxed text-pretty", !open && "line-clamp-2", !r.summary && "text-muted-foreground")}>{summary}</span>
          {!running && (r.actions.length > 0 || forYou.length > 0) && (
            <span className="mt-1.5 flex flex-wrap gap-1.5 text-[11px]">
              {r.actions.length > 0 && <span className="rounded-md border px-1.5 py-0.5 text-muted-foreground">{t("review.changes", { count: r.actions.length })}</span>}
              {forYou.length > 0 && <span className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-medium text-warning">{t("review.forYou", { count: forYou.length })}</span>}
            </span>
          )}
        </span>
        {expandable && <ChevronRight className={cn("mt-1 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
      </button>
      <AnimatePresence initial={false}>
        {open && expandable && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
            <ReviewDetail review={r} />
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function ReviewDetail({ review: r }: { review: Review }) {
  const { t } = useTranslation("settings");
  const forYou = r.findings.filter((f) => f.forHuman);
  const found = r.findings.filter((f) => !f.forHuman);
  return (
    <div className="space-y-4 px-5 pb-4 pl-10">
      {forYou.length > 0 && (
        <Block title={t("review.blocks.forYou")}>
          {forYou.map((f, i) => (
            <Finding key={i} finding={f} />
          ))}
        </Block>
      )}
      {r.actions.length > 0 && (
        <Block title={t("review.blocks.changes")}>
          {r.actions.map((a) => (
            <ActionLine key={a.index} reviewId={r.id} action={a} />
          ))}
        </Block>
      )}
      {found.length > 0 && (
        <Block title={t("review.blocks.found")}>
          {found.map((f, i) => (
            <Finding key={i} finding={f} />
          ))}
        </Block>
      )}
      {r.scores.length > 0 && (
        <Block title={t("review.blocks.agents")}>
          {[...r.scores]
            .sort((a, b) => a.score - b.score)
            .map((s) => (
              <li key={s.agentId} className="flex items-baseline gap-3 py-1 text-sm">
                <Link to={`/agents/${s.agentId}`} className="w-40 shrink-0 truncate font-medium hover:underline">
                  {s.name}
                </Link>
                <Score value={s.score} />
                <span className="min-w-0 flex-1 text-muted-foreground">{s.note}</span>
              </li>
            ))}
        </Block>
      )}
      {r.conversationId && (
        <Link to={`/chat/${r.conversationId}`} className="inline-block text-xs text-muted-foreground hover:text-foreground hover:underline">
          {t("review.openRun")}
        </Link>
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h4>
      <ul>{children}</ul>
    </section>
  );
}

function Finding({ finding: f }: { finding: ReviewFinding }) {
  return (
    <li className="flex gap-2.5 py-1 text-sm leading-relaxed">
      <span className={cn("mt-2 size-1.5 shrink-0 rounded-full", SEVERITY_DOT[f.severity])} />
      <span className="min-w-0">
        {f.forHuman ? <span className="font-medium">{f.forHuman}</span> : f.text}
        {f.forHuman && <span className="block text-muted-foreground">{f.text}</span>}
      </span>
    </li>
  );
}

function ActionLine({ reviewId, action: a }: { reviewId: string; action: Review["actions"][number] }) {
  const { t } = useTranslation("settings");
  const qc = useQueryClient();
  const undo = useMutation({
    mutationFn: () => api.reviews.undo(reviewId, a.index),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.reviews });
      toast.success(t("review.undone"));
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <li className="flex items-center gap-3 py-1 text-sm">
      <span className={cn("min-w-0 flex-1 leading-relaxed", a.undoneAt && "text-muted-foreground line-through")}>
        {a.conversationId ? (
          <Link to={`/chat/${a.conversationId}`} className="hover:underline">
            {a.text}
          </Link>
        ) : (
          a.text
        )}
      </span>
      {a.undoneAt ? (
        <span className="shrink-0 px-2 text-xs text-muted-foreground">{t("review.undoneLabel")}</span>
      ) : (
        a.canUndo && (
          <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" disabled={undo.isPending} onClick={() => undo.mutate()}>
            {undo.isPending ? <Spinner /> : <Undo2 />} {t("review.undo")}
          </Button>
        )
      )}
    </li>
  );
}

function Score({ value }: { value: number }) {
  return (
    <span className="flex shrink-0 gap-0.5" aria-label={`${value}/5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={cn("h-1.5 w-3 rounded-full", n <= value ? (value <= 2 ? "bg-destructive" : value === 3 ? "bg-warning" : "bg-success") : "bg-muted")} />
      ))}
    </span>
  );
}
