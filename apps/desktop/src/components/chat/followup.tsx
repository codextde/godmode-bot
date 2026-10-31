import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { addDays, addHours, format, formatDistanceStrict, isToday, isTomorrow, isYesterday, nextMonday, parse, setHours, startOfHour } from "date-fns";
import type { ConversationFollowup, FollowupReason, Message, MessageBlock } from "@godmode/shared";
import { AlarmClock, CalendarClock, Play, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/components/vault/use-now";
import { Trans, useTranslation } from "react-i18next";
import { api, errorMessage, isLicenseRequired } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { dateLocale, t } from "@/i18n";

/** "today at 16:00", "tomorrow at 09:00", "Thu, Oct 1 at 09:00" */
export function followupWhen(iso: string): string {
  const d = new Date(iso);
  const time = format(d, "HH:mm");
  if (isToday(d)) return t("chat:followup.when.today", { time });
  if (isTomorrow(d)) return t("chat:followup.when.tomorrow", { time });
  if (isYesterday(d)) return t("chat:followup.when.yesterday", { time });
  const pattern = d.getFullYear() === new Date().getFullYear() ? t("chat:followup.when.dateFormat") : t("chat:followup.when.dateFormatYear");
  return t("chat:followup.when.date", { date: format(d, pattern, { locale: dateLocale() }), time });
}

/** "in 3 hours", "in 12 minutes", "any moment" */
export function followupIn(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (ms < 60_000) return t("chat:followup.anyMoment");
  return formatDistanceStrict(new Date(iso), now, { roundingMethod: "floor", addSuffix: true, locale: dateLocale() });
}

export function useFollowupActions() {
  const qc = useQueryClient();
  const refresh = (conversationId: string) => {
    qc.invalidateQueries({ queryKey: qk.followups });
    qc.invalidateQueries({ queryKey: qk.conversation(conversationId) });
    qc.invalidateQueries({ queryKey: qk.conversationLists });
  };
  const move = useMutation({
    mutationFn: ({ conversationId, dueAt }: { conversationId: string; dueAt: Date }) => api.followups.move(conversationId, { dueAt: dueAt.toISOString() }),
    onSuccess: (f) => {
      refresh(f.conversationId);
      toast.success(t("chat:followup.continuesWhen", { when: followupWhen(f.dueAt) }));
    },
    onError: (err) => toast.error(t("chat:followup.moveError"), { description: errorMessage(err) }),
  });
  const cancel = useMutation({
    mutationFn: (conversationId: string) => api.followups.cancel(conversationId),
    onSuccess: (_res, conversationId) => {
      refresh(conversationId);
      toast(t("chat:followup.cancelled"), { description: t("chat:followup.cancelledDescription") });
    },
    onError: (err) => toast.error(t("chat:followup.cancelError"), { description: errorMessage(err) }),
  });
  const runNow = useMutation({
    mutationFn: (conversationId: string) => api.followups.runNow(conversationId),
    onSuccess: (run) => refresh(run.conversationId),
    onError: (err) => !isLicenseRequired(err) && toast.error(t("chat:followup.runNowError"), { description: errorMessage(err) }),
  });
  return { move, cancel, runNow };
}

const PRESET_KEY = {
  hour: "followup.presets.inHour",
  threeHours: "followup.presets.inThreeHours",
  evening: "followup.presets.thisEvening",
  twelveHours: "followup.presets.inTwelveHours",
  tomorrow: "followup.presets.tomorrowMorning",
  monday: "followup.presets.nextMonday",
  week: "followup.presets.inWeek",
} as const;

function presets(now: Date): { label: (typeof PRESET_KEY)[keyof typeof PRESET_KEY]; at: Date }[] {
  const morning = (d: Date) => setHours(startOfHour(d), 9);
  return [
    { label: PRESET_KEY.hour, at: addHours(now, 1) },
    { label: PRESET_KEY.threeHours, at: addHours(now, 3) },
    now.getHours() < 17 ? { label: PRESET_KEY.evening, at: setHours(startOfHour(now), 18) } : { label: PRESET_KEY.twelveHours, at: addHours(now, 12) },
    { label: PRESET_KEY.tomorrow, at: morning(addDays(now, 1)) },
    { label: PRESET_KEY.monday, at: morning(nextMonday(now)) },
    { label: PRESET_KEY.week, at: morning(addDays(now, 7)) },
  ];
}

const LOCAL_INPUT = "yyyy-MM-dd'T'HH:mm";

/** Presets and a date/time field to move a follow-up. */
export function FollowupTimePicker({
  dueAt,
  onPick,
  children,
  align = "end",
}: {
  dueAt: string;
  onPick: (at: Date) => Promise<unknown>;
  children: ReactNode;
  align?: "start" | "center" | "end";
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const now = new Date();
  const customAt = custom ? parse(custom, LOCAL_INPUT, now) : null;
  const customOk = !!customAt && !Number.isNaN(customAt.getTime()) && customAt.getTime() - Date.now() >= 60_000;

  const pick = async (at: Date) => {
    setBusy(true);
    try {
      await onPick(at);
      setOpen(false);
    } catch {
      /* the caller shows why */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setCustom(format(new Date(dueAt), LOCAL_INPUT));
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-80 rounded-xl p-2">
        <div className="eyebrow px-1.5 pt-1 pb-2 text-[10.5px]">{t("followup.continueAt")}</div>
        <div className="grid grid-cols-2 gap-1">
          {presets(now).map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={busy}
              onClick={() => void pick(p.at)}
              className="rounded-lg border border-transparent px-2.5 py-2 text-left transition hover:border-border hover:bg-accent/60 focus-visible:border-border focus-visible:bg-accent/60 focus-visible:outline-none disabled:opacity-50"
            >
              <span className="block text-[13px] font-medium">{t(p.label)}</span>
              <span className="block text-[11px] text-muted-foreground tabular-nums">{format(p.at, isToday(p.at) ? t("followup.todayTimeFormat") : "EEE HH:mm", { locale: dateLocale() })}</span>
            </button>
          ))}
        </div>
        <form
          className="mt-2 flex items-center gap-1.5 border-t px-1 pt-2.5 pb-0.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (customOk) void pick(customAt!);
          }}
        >
          <Input
            type="datetime-local"
            aria-label={t("followup.dateAndTime")}
            value={custom}
            min={format(now, LOCAL_INPUT)}
            onChange={(e) => setCustom(e.target.value)}
            className="h-8 flex-1 text-[13px] tabular-nums"
          />
          <Button type="submit" size="sm" disabled={!customOk || busy}>
            {busy ? <Spinner /> : null} {t("followup.set")}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** Above the composer while the agent plans to come back to this chat. */
export function FollowupBar({
  conversationId,
  followup,
  agentName,
  running,
}: {
  conversationId: string;
  followup: ConversationFollowup;
  agentName: string;
  running: boolean;
}) {
  const { t } = useTranslation("chat");
  const now = useNow(30_000);
  const { move, cancel, runNow } = useFollowupActions();
  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border bg-card py-2 pr-2 pl-2.5 shadow-card">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-brand/25 bg-brand-soft text-brand-strong">
        <AlarmClock className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 leading-snug">
        <div className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
          <span className="truncate">
            <Trans t={t} i18nKey="followup.barContinues" values={{ name: agentName, when: followupWhen(followup.dueAt) }} components={{ b: <span className="font-medium" /> }} />
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{followupIn(followup.dueAt, now)}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground" title={followup.note}>
          {followup.note}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={running ? 0 : -1}>
              <Button size="xs" variant="ghost" disabled={running || runNow.isPending} onClick={() => runNow.mutate(conversationId)}>
                {runNow.isPending ? <Spinner /> : <Play />}
                <span className="hidden @lg:inline">{t("followup.continueNow")}</span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{running ? t("followup.workingHere", { name: agentName }) : t("followup.continueNowHint")}</TooltipContent>
        </Tooltip>
        <FollowupTimePicker dueAt={followup.dueAt} onPick={(dueAt) => move.mutateAsync({ conversationId, dueAt })}>
          <Button size="xs" variant="ghost" aria-label={t("followup.changeTime")}>
            <CalendarClock />
            <span className="hidden @lg:inline">{t("followup.change")}</span>
          </Button>
        </FollowupTimePicker>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon-xs" variant="ghost" aria-label={t("followup.cancel")} disabled={cancel.isPending} onClick={() => cancel.mutate(conversationId)}>
              {cancel.isPending ? <Spinner /> : <X />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t("followup.cancel")}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

type FollowupBlock = Extract<MessageBlock, { type: "followup" }>;

export function followupBlock(message: Message): FollowupBlock | null {
  return (message.blocks.find((b) => b.type === "followup") as FollowupBlock | undefined) ?? null;
}

const REASON: Record<FollowupReason, (dueAt: string) => string> = {
  due: (dueAt) => t("chat:followup.reason.due", { time: format(new Date(dueAt), "HH:mm") }),
  late: (dueAt) => t("chat:followup.reason.late", { when: followupWhen(dueAt) }),
  now: () => t("chat:followup.reason.now"),
};

/** Where the agent picked a chat up again on its own. */
export function FollowupMarker({ block }: { block: FollowupBlock }) {
  const { t } = useTranslation("chat");
  return (
    <div role="note" className="flex flex-col items-center gap-1.5 text-center">
      <div className="flex w-full items-center gap-3 text-[11px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span className="inline-flex items-center gap-1.5">
          <AlarmClock className="size-3.5 text-brand-strong" aria-hidden />
          <span className="font-medium text-foreground">{t("followup.label")}</span>
          <span className="tabular-nums">{REASON[block.reason](block.dueAt)}</span>
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <p className="max-w-[85%] text-[13px] text-balance text-muted-foreground">{block.note}</p>
    </div>
  );
}
