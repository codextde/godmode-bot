import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { formatDistanceToNowStrict, format } from "date-fns";
import {
  CircleAlert,
  Clock,
  Copy,
  Ellipsis,
  FlaskConical,
  History,
  Hourglass,
  MessageSquare,
  Pencil,
  Play,
  RefreshCw,
  ScanSearch,
  Shuffle,
  Trash2,
} from "lucide-react";
import type { Agent, Routine } from "@godmode/shared";
import { api, errorMessage, isLicenseRequired } from "@/lib/api";
import { cloudContext, coreUrl } from "@/lib/core";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { dateLocale } from "@/i18n";
import { AgentAvatar } from "@/components/common";
import { RunStatusBadge } from "@/components/runs/run-status";
import { copyText } from "@/components/chat/copy-button";
import { EventsSheet } from "@/components/automations/events-sheet";
import { TestEventDialog } from "@/components/automations/test-event-dialog";
import { isEventTrigger, TRIGGER_TYPES } from "@/components/automations/trigger-meta";
import { TriggerSummary } from "@/components/automations/trigger-summary";
import { RotateWebhookDialog, useRotateWebhook } from "@/components/automations/webhook-panel";
import { prettySlug } from "@/components/integrations/toolkit-logo";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function patchRoutineCaches(qc: ReturnType<typeof useQueryClient>, id: string, patch: Partial<Routine>) {
  qc.setQueriesData<Routine[]>({ queryKey: qk.routines }, (old) =>
    Array.isArray(old) ? old.map((r) => (r.id === id ? { ...r, ...patch } : r)) : old,
  );
}

export function useToggleRoutine() {
  const { t } = useTranslation("agents");
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.routines.update(id, { enabled }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: qk.routines });
      patchRoutineCaches(qc, id, { enabled });
    },
    onError: (err, { id, enabled }) => {
      patchRoutineCaches(qc, id, { enabled: !enabled });
      toast.error(t("routineItem.toast.updateError"), { description: errorMessage(err) });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.routines }),
  });
}

/** Schedule: run now · condition: check now · app/webhook: run with a test event. */
export function useRunRoutine() {
  const { t } = useTranslation("agents");
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (routine: Routine) => api.routines.run(routine.id),
    onSuccess: (run, routine) => {
      qc.invalidateQueries({ queryKey: qk.runs });
      qc.invalidateQueries({ queryKey: qk.routines });
      qc.invalidateQueries({ queryKey: qk.automationEvents });
      const title =
        routine.trigger.type === "condition"
          ? t("routineItem.toast.checking", { name: routine.name })
          : isEventTrigger(routine.trigger.type)
            ? t("routineItem.toast.testEventSent", { name: routine.name })
            : t("routineItem.toast.started", { name: routine.name });
      toast.success(title, { action: { label: t("routineItem.toast.watch"), onClick: () => navigate(`/chat/${run.conversationId}`) } });
    },
    onError: (err, routine) =>
      !isLicenseRequired(err) &&
      toast.error(routine.trigger.type === "condition" ? t("routineItem.toast.checkError") : t("routineItem.toast.startError"), { description: errorMessage(err) }),
  });
}

export function useDeleteRoutine() {
  const { t } = useTranslation("agents");
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (routine: Routine) => api.routines.delete(routine.id),
    onSuccess: (_, routine) => {
      qc.invalidateQueries({ queryKey: qk.routines });
      toast.success(t("routineItem.toast.deleted", { name: routine.name }));
    },
    onError: (err) => toast.error(t("routineItem.toast.deleteError"), { description: errorMessage(err) }),
  });
}

function relative(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return { text: formatDistanceToNowStrict(d, { addSuffix: true, locale: dateLocale() }), full: format(d, "PPpp", { locale: dateLocale() }) };
}

const RUN_ICONS = { schedule: Play, condition: ScanSearch, app: FlaskConical, webhook: FlaskConical } as const;

/** One automation as a rich row: trigger, trigger health, next run / last event, enable switch and actions. */
export function RoutineItem({ routine, agent, onEdit }: { routine: Routine; agent?: Agent; onEdit: (r: Routine) => void }) {
  const { t } = useTranslation(["agents", "common"]);
  const toggle = useToggleRoutine();
  const run = useRunRoutine();
  const del = useDeleteRoutine();
  const rotate = useRotateWebhook();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  // Mounted on first open only: the sheet loads events and runs.
  const [events, setEvents] = useState<{ open: boolean } | null>(null);
  const openEvents = () => setEvents({ open: true });

  const type = routine.trigger.type;
  const meta = TRIGGER_TYPES[type];
  const TriggerIcon = meta.icon;
  const RunIcon = RUN_ICONS[type];
  const eventTrigger = isEventTrigger(type);
  const status = routine.triggerStatus;
  const running = run.isPending && run.variables?.id === routine.id;
  const last = relative(routine.lastRunAt);

  const copyWebhook = async () => {
    if (!routine.webhookPath) return;
    if (await copyText(coreUrl(routine.webhookPath))) toast.success(t("routineItem.webhookCopied"));
  };

  return (
    <div
      className={cn(
        "group flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-card transition hover:border-foreground/15 hover:shadow-float @4xl:flex-row @4xl:items-center",
        !routine.enabled && "opacity-70",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {agent ? (
          <Link to={`/agents/${agent.id}/routines`} aria-label={t("routineItem.openAgent", { name: agent.name })} className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <AgentAvatar agent={agent} size="md" />
          </Link>
        ) : (
          <div className="grid size-8 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">
            <TriggerIcon className="size-4" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <button
              type="button"
              onClick={() => onEdit(routine)}
              className="truncate text-left font-medium tracking-[-0.01em] hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {routine.name}
            </button>
            {agent && <span className="truncate text-xs text-muted-foreground">· {agent.name}</span>}
            {!routine.enabled && <span className="rounded-[5px] border bg-secondary px-1.5 py-px text-[10px] font-medium text-muted-foreground">{t("routineItem.paused")}</span>}
            {routine.fillOnly && agent?.permissions.secretAccess === "reveal" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="rounded-[5px] border bg-secondary px-1.5 py-px text-[10px] font-medium text-muted-foreground">{t("routineItem.fillOnly")}</span>
                </TooltipTrigger>
                <TooltipContent>{t("routineItem.fillOnlyHint")}</TooltipContent>
              </Tooltip>
            )}
            {routine.pendingEvents > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={openEvents}
                    className="rounded-[5px] border border-warning/25 bg-warning/[0.08] px-1.5 py-px text-[10px] font-medium text-warning tabular-nums transition hover:bg-warning/[0.14] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {t("routineItem.waiting", { count: routine.pendingEvents })}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {t("routineItem.eventsWait", { count: routine.pendingEvents })}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <TriggerSummary routine={routine} className="mt-0.5" />
          {routine.filter && eventTrigger && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{t("routineItem.onlyWhen", { filter: routine.filter.replace(/^only\s+(when\s+|if\s+)?/i, "") })}</p>
          )}
          {status.state === "error" && (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-destructive" role="alert">
              <CircleAlert className="mt-px size-3.5 shrink-0" />
              <span className="line-clamp-2">{status.message ?? t("routineItem.triggerError")}</span>
            </p>
          )}
          {status.state === "pending" && (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground" role="status">
              <Hourglass className="mt-px size-3.5 shrink-0" />
              <span className="line-clamp-2">{status.message ?? t("routineItem.triggerPending")}</span>
            </p>
          )}
          {routine.prompt && <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{routine.prompt}</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 @md:pl-11 @4xl:pl-0">
        <div className="min-w-24 text-xs">
          <UpcomingCell routine={routine} onOpenEvents={openEvents} />
        </div>
        <div className="min-w-28 text-xs">
          <div className="eyebrow">{t("routineItem.lastRun")}</div>
          {routine.lastStatus && last ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1.5">
                  <RunStatusBadge status={routine.lastStatus} className="px-1.5" />
                  <span className="text-muted-foreground">{last.text}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>{last.full}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="font-medium text-muted-foreground">{t("common:words.never")}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Switch
            checked={routine.enabled}
            onCheckedChange={(enabled) => toggle.mutate({ id: routine.id, enabled })}
            aria-label={routine.enabled ? t("routineItem.pauseNamed", { name: routine.name }) : t("routineItem.enableNamed", { name: routine.name })}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => run.mutate(routine)} disabled={running} aria-label={`${meta.runLabel}: ${routine.name}`}>
                {running ? <Spinner /> : <RunIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{meta.runLabel}</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("routineItem.moreActions", { name: routine.name })}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => onEdit(routine)}>
                <Pencil /> {t("common:actions.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={openEvents}>
                <History /> {t("routineItem.recentEvents")}
              </DropdownMenuItem>
              {routine.conversationId && (
                <DropdownMenuItem asChild>
                  <Link to={`/chat/${routine.conversationId}`}>
                    <MessageSquare /> {t("routineItem.openConversation")}
                  </Link>
                </DropdownMenuItem>
              )}
              {eventTrigger && (
                <DropdownMenuItem onClick={() => setTestOpen(true)}>
                  <FlaskConical /> {t("routineItem.sendTestEvent")}
                </DropdownMenuItem>
              )}
              {type === "webhook" && (
                <>
                  <DropdownMenuSeparator />
                  {/* Through Godmode Cloud the page's address isn't one webhooks can reach; the URL is copied on the computer. */}
                  {!cloudContext && (
                    <DropdownMenuItem onClick={copyWebhook} disabled={!routine.webhookPath}>
                      <Copy /> {routine.webhookPath ? t("routineItem.copyWebhook") : t("routineItem.unlockToCopy")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setConfirmRotate(true)} disabled={rotate.isPending}>
                    <RefreshCw /> {t("routineItem.rotateWebhook")}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 /> {t("common:actions.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("routineItem.deleteDialog.title", { name: routine.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {routine.trigger.type === "app"
                ? t("routineItem.deleteDialog.app", { trigger: routine.trigger.triggerName, app: prettySlug(routine.trigger.toolkit) })
                : type === "webhook"
                  ? t("routineItem.deleteDialog.webhook")
                  : t("routineItem.deleteDialog.schedule")}{" "}
              {t("routineItem.deleteDialog.history")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => del.mutate(routine)}>
              {t("routineItem.deleteDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {type === "webhook" && (
        <RotateWebhookDialog routine={routine} open={confirmRotate} onOpenChange={setConfirmRotate} onConfirm={() => rotate.mutate(routine)} />
      )}
      {eventTrigger && <TestEventDialog routine={routine} open={testOpen} onOpenChange={setTestOpen} onViewEvents={openEvents} />}
      {events && (
        <EventsSheet
          routine={routine}
          open={events.open}
          onOpenChange={(open) => setEvents({ open })}
          onSendTest={() => setTestOpen(true)}
        />
      )}
    </div>
  );
}

/** Schedule → next run · condition → next check (last observation in the tooltip) · app/webhook → last event. */
function UpcomingCell({ routine, onOpenEvents }: { routine: Routine; onOpenEvents: () => void }) {
  const { t } = useTranslation("agents");
  const type = routine.trigger.type;
  const status = routine.triggerStatus;

  if (type === "app" || type === "webhook") {
    const lastEvent = relative(status.lastEventAt);
    return (
      <>
        <div className="eyebrow">{t("routineItem.lastEvent")}</div>
        {lastEvent ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onOpenEvents}
                className="flex items-center gap-1 font-medium tabular-nums hover:underline focus-visible:underline focus-visible:outline-none"
              >
                <Clock className="size-3" /> {lastEvent.text}
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("routineItem.lastEventTooltip", { date: lastEvent.full })}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="font-medium text-muted-foreground">{routine.enabled ? t("routineItem.noneYet") : t("routineItem.paused")}</span>
        )}
      </>
    );
  }

  const next = relative(routine.nextRunAt);
  const lastCheck = type === "condition" ? relative(status.lastCheckAt) : null;
  const randomStart = routine.trigger.type === "schedule" && !!routine.trigger.startWindowMinutes;
  const NextIcon = randomStart ? Shuffle : Clock;
  let tooltip: ReactNode = next?.full;
  if (randomStart && next) {
    tooltip = (
      <div className="space-y-0.5">
        <div>{next.full}</div>
        <div className="opacity-80">{t("routineItem.randomPick")}</div>
      </div>
    );
  }
  if (type === "condition" && (lastCheck || status.observation)) {
    tooltip = (
      <div className="max-w-72 space-y-1">
        {next && <div>{t("routineItem.nextCheckAt", { date: next.full })}</div>}
        {lastCheck && <div className="opacity-80">{t("routineItem.lastCheckAgo", { time: lastCheck.text })}</div>}
        {status.observation && <div className="line-clamp-4 opacity-80">“{status.observation}”</div>}
      </div>
    );
  }

  return (
    <>
      <div className="eyebrow">{type === "condition" ? t("routineItem.nextCheck") : t("routineItem.nextRun")}</div>
      {routine.enabled && next ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1 font-medium tabular-nums">
              <NextIcon className="size-3" /> {next.text}
            </span>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="font-medium text-muted-foreground">{routine.enabled ? "—" : t("routineItem.paused")}</span>
      )}
    </>
  );
}
