import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
  Trash2,
} from "lucide-react";
import type { Agent, Routine } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { coreUrl } from "@/lib/core";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
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
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.routines.update(id, { enabled }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: qk.routines });
      patchRoutineCaches(qc, id, { enabled });
    },
    onError: (err, { id, enabled }) => {
      patchRoutineCaches(qc, id, { enabled: !enabled });
      toast.error("Couldn't update automation", { description: errorMessage(err) });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.routines }),
  });
}

/** Schedule: run now · condition: check now · app/webhook: run with a test event. */
export function useRunRoutine() {
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
          ? `Checking “${routine.name}”…`
          : isEventTrigger(routine.trigger.type)
            ? `Test event sent to “${routine.name}”`
            : `“${routine.name}” started`;
      toast.success(title, { action: { label: "Watch", onClick: () => navigate(`/chat/${run.conversationId}`) } });
    },
    onError: (err, routine) =>
      toast.error(routine.trigger.type === "condition" ? "Couldn't start the check" : "Couldn't start the automation", { description: errorMessage(err) }),
  });
}

export function useDeleteRoutine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (routine: Routine) => api.routines.delete(routine.id),
    onSuccess: (_, routine) => {
      qc.invalidateQueries({ queryKey: qk.routines });
      toast.success(`“${routine.name}” deleted`);
    },
    onError: (err) => toast.error("Couldn't delete automation", { description: errorMessage(err) }),
  });
}

function relative(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return { text: formatDistanceToNowStrict(d, { addSuffix: true }), full: format(d, "PPpp") };
}

const RUN_ICONS = { schedule: Play, condition: ScanSearch, app: FlaskConical, webhook: FlaskConical } as const;

/** One automation as a rich row: trigger, trigger health, next run / last event, enable switch and actions. */
export function RoutineItem({ routine, agent, onEdit }: { routine: Routine; agent?: Agent; onEdit: (r: Routine) => void }) {
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
    if (await copyText(coreUrl(routine.webhookPath))) toast.success("Webhook URL copied");
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
          <Link to={`/agents/${agent.id}/routines`} aria-label={`Open ${agent.name}`} className="rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
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
            {!routine.enabled && <span className="rounded-[5px] border bg-secondary px-1.5 py-px text-[10px] font-medium text-muted-foreground">Paused</span>}
            {routine.pendingEvents > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={openEvents}
                    className="rounded-[5px] border border-warning/25 bg-warning/[0.08] px-1.5 py-px text-[10px] font-medium text-warning tabular-nums transition hover:bg-warning/[0.14] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {routine.pendingEvents} waiting
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {routine.pendingEvents === 1 ? "1 event waits" : `${routine.pendingEvents} events wait`} for the current run to finish
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <TriggerSummary routine={routine} className="mt-0.5" />
          {routine.filter && eventTrigger && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">Only when {routine.filter.replace(/^only\s+(when\s+|if\s+)?/i, "")}</p>
          )}
          {status.state === "error" && (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-destructive" role="alert">
              <CircleAlert className="mt-px size-3.5 shrink-0" />
              <span className="line-clamp-2">{status.message ?? "The trigger isn't working."}</span>
            </p>
          )}
          {status.state === "pending" && (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground" role="status">
              <Hourglass className="mt-px size-3.5 shrink-0" />
              <span className="line-clamp-2">{status.message ?? "Setting up the trigger…"}</span>
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
          <div className="eyebrow">Last run</div>
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
            <span className="font-medium text-muted-foreground">Never</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Switch
            checked={routine.enabled}
            onCheckedChange={(enabled) => toggle.mutate({ id: routine.id, enabled })}
            aria-label={routine.enabled ? `Pause ${routine.name}` : `Enable ${routine.name}`}
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
              <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${routine.name}`}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => onEdit(routine)}>
                <Pencil /> Edit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={openEvents}>
                <History /> Recent events
              </DropdownMenuItem>
              {routine.conversationId && (
                <DropdownMenuItem asChild>
                  <Link to={`/chat/${routine.conversationId}`}>
                    <MessageSquare /> Open conversation
                  </Link>
                </DropdownMenuItem>
              )}
              {eventTrigger && (
                <DropdownMenuItem onClick={() => setTestOpen(true)}>
                  <FlaskConical /> Send test event…
                </DropdownMenuItem>
              )}
              {type === "webhook" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={copyWebhook} disabled={!routine.webhookPath}>
                    <Copy /> {routine.webhookPath ? "Copy webhook URL" : "Unlock the vault to copy the URL"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setConfirmRotate(true)} disabled={rotate.isPending}>
                    <RefreshCw /> Rotate webhook URL
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{routine.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {routine.trigger.type === "app"
                ? `Godmode stops listening for “${routine.trigger.triggerName}” in ${prettySlug(routine.trigger.toolkit)}.`
                : type === "webhook"
                  ? "Its webhook URL stops working."
                  : "It won't run again."}{" "}
              Past runs and conversations stay in your history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => del.mutate(routine)}>
              Delete automation
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
  const type = routine.trigger.type;
  const status = routine.triggerStatus;

  if (type === "app" || type === "webhook") {
    const lastEvent = relative(status.lastEventAt);
    return (
      <>
        <div className="eyebrow">Last event</div>
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
            <TooltipContent>{lastEvent.full} · show recent events</TooltipContent>
          </Tooltip>
        ) : (
          <span className="font-medium text-muted-foreground">{routine.enabled ? "None yet" : "Paused"}</span>
        )}
      </>
    );
  }

  const next = relative(routine.nextRunAt);
  const lastCheck = type === "condition" ? relative(status.lastCheckAt) : null;
  let tooltip: ReactNode = next?.full;
  if (type === "condition" && (lastCheck || status.observation)) {
    tooltip = (
      <div className="max-w-72 space-y-1">
        {next && <div>Next check: {next.full}</div>}
        {lastCheck && <div className="opacity-80">Last check {lastCheck.text}</div>}
        {status.observation && <div className="line-clamp-4 opacity-80">“{status.observation}”</div>}
      </div>
    );
  }

  return (
    <>
      <div className="eyebrow">{type === "condition" ? "Next check" : "Next run"}</div>
      {routine.enabled && next ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1 font-medium tabular-nums">
              <Clock className="size-3" /> {next.text}
            </span>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="font-medium text-muted-foreground">{routine.enabled ? "—" : "Paused"}</span>
      )}
    </>
  );
}
