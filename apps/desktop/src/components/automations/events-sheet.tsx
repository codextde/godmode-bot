import { useMemo, useState } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { ArrowUpRight, Braces, ChevronRight, CircleAlert, FlaskConical, Hourglass, Inbox, Radar } from "lucide-react";
import type { AutomationEvent, AutomationEventStatus, Routine } from "@godmode/shared";
import { errorMessage } from "@/lib/api";
import { useRoutineEvents, useRuns } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/chat/copy-button";
import { ToolkitLogo, prettySlug, toolkitLogoUrl } from "@/components/integrations/toolkit-logo";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EVENT_SOURCES, EVENT_STATUS, isEventTrigger, TRIGGER_TYPES } from "./trigger-meta";
import { TriggerSummary } from "./trigger-summary";

const LIMIT = 50;

function relative(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return { text: formatDistanceToNowStrict(d, { addSuffix: true }), full: format(d, "PPpp") };
}

/** Event data is untrusted: always rendered as text, never as markup. */
function payloadText(payload: unknown): string | null {
  if (payload === undefined || payload === null || payload === "") return null;
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function EventStatusBadge({ status, className }: { status: AutomationEventStatus; className?: string }) {
  const meta = EVENT_STATUS[status] ?? EVENT_STATUS.pending;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium", meta.className, className)}>
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </span>
  );
}

/** Side sheet with what started an automation recently — live, newest first. */
export function EventsSheet({
  routine,
  open,
  onOpenChange,
  onSendTest,
}: {
  routine: Routine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSendTest: () => void;
}) {
  const eventsQ = useRoutineEvents(routine.id, { limit: LIMIT, enabled: open });
  const runsQ = useRuns(routine.agentId);
  const conversationByRun = useMemo(() => new Map((runsQ.data ?? []).map((r) => [r.id, r.conversationId])), [runsQ.data]);
  const t = routine.trigger;
  const Icon = TRIGGER_TYPES[t.type].icon;
  const status = routine.triggerStatus;
  const lastCheck = relative(status.lastCheckAt);
  const events = eventsQ.data ?? [];

  const conversationLink = (e: AutomationEvent): { to: string; label: string } | null => {
    if (!e.runId) return null;
    const conversationId = conversationByRun.get(e.runId);
    if (conversationId) return { to: `/chat/${conversationId}`, label: "Open conversation" };
    if (routine.reuseConversation && routine.conversationId) return { to: `/chat/${routine.conversationId}`, label: "Open conversation" };
    return { to: `/activity?run=${e.runId}`, label: "View run" };
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-hidden p-0 sm:max-w-lg">
        <div className="flex h-full min-h-0 flex-col">
          <SheetHeader className="gap-3 border-b bg-paper-2 p-5 pr-12">
            <div className="flex items-center gap-3">
              {t.type === "app" ? (
                <ToolkitLogo src={toolkitLogoUrl(t.toolkit)} name={t.toolkit} size="md" />
              ) : (
                <div className="grid size-10 shrink-0 place-items-center rounded-lg border bg-card text-foreground shadow-card">
                  <Icon className="size-5" />
                </div>
              )}
              <div className="min-w-0">
                <SheetTitle className="truncate text-lg font-medium tracking-[-0.02em]">{routine.name}</SheetTitle>
                <SheetDescription asChild>
                  <div>
                    <TriggerSummary routine={routine} icon={false} className="text-xs text-muted-foreground" />
                  </div>
                </SheetDescription>
              </div>
            </div>

            {(status.state === "error" || status.state === "pending") && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
                  status.state === "error" ? "border-destructive/25 bg-destructive/[0.06] text-destructive" : "bg-card text-muted-foreground",
                )}
                role={status.state === "error" ? "alert" : "status"}
              >
                {status.state === "error" ? <CircleAlert className="mt-px size-3.5 shrink-0" /> : <Hourglass className="mt-px size-3.5 shrink-0" />}
                <span>{status.message ?? (status.state === "error" ? "The trigger isn't working." : "Setting up the trigger…")}</span>
              </div>
            )}

            {t.type === "condition" && (status.observation || lastCheck) && (
              <div className="rounded-lg border bg-card p-3 shadow-card">
                <div className="eyebrow flex items-center gap-1.5">
                  <Radar className="size-3.5" /> Last check
                  {lastCheck && (
                    <span className="font-normal tracking-normal normal-case" title={lastCheck.full}>
                      · {lastCheck.text}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm whitespace-pre-line text-foreground/85">{status.observation ?? "Nothing noted yet."}</p>
              </div>
            )}

            {isEventTrigger(t.type) && (
              <div>
                <Button size="sm" variant="outline" onClick={onSendTest}>
                  <FlaskConical /> Send test event
                </Button>
              </div>
            )}
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <h3 className="eyebrow mb-2 flex items-center gap-2">
              Recent events
              {events.length > 0 && <span className="rounded-[4px] border bg-card px-1 font-mono text-[10px] tabular-nums">{events.length}</span>}
            </h3>
            {eventsQ.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-xl" />
                ))}
              </div>
            ) : eventsQ.isError ? (
              <div className="rounded-xl border border-destructive/25 bg-destructive/[0.05] p-4 text-sm" role="alert">
                <p className="font-medium">Couldn't load events</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{errorMessage(eventsQ.error)}</p>
                <Button size="sm" variant="outline" className="mt-3" onClick={() => eventsQ.refetch()}>
                  Try again
                </Button>
              </div>
            ) : events.length === 0 ? (
              <EmptyEvents routine={routine} />
            ) : (
              <ol className="space-y-0.5 rounded-xl border bg-card p-1.5 shadow-card">
                <AnimatePresence initial={false}>
                  {events.map((e) => (
                    <motion.li key={e.id} layout="position" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                      <EventRow event={e} link={conversationLink(e)} />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ol>
            )}
            {events.length >= LIMIT && <p className="mt-3 text-center text-xs text-muted-foreground">Showing the latest {LIMIT} events.</p>}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function EventRow({ event, link }: { event: AutomationEvent; link: { to: string; label: string } | null }) {
  const [open, setOpen] = useState(false);
  const source = EVENT_SOURCES[event.source] ?? EVENT_SOURCES.manual;
  const SourceIcon = source.icon;
  const when = relative(event.createdAt);
  const payload = payloadText(event.payload);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("rounded-lg px-3 py-2.5 transition", open && "bg-accent/40")}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border bg-paper-2 text-muted-foreground" title={source.label}>
          <SourceIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug font-medium break-words">{event.title || source.label}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <EventStatusBadge status={event.status} />
            <span>{source.label}</span>
            {when && (
              <time dateTime={event.createdAt} title={when.full} className="tabular-nums">
                {when.text}
              </time>
            )}
          </div>
          {event.note && <p className={cn("mt-1.5 text-xs", event.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{event.note}</p>}
          {(payload || link) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {payload && (
                <CollapsibleTrigger asChild>
                  <Button size="xs" variant="ghost" className="-ml-1.5 text-muted-foreground">
                    <Braces /> Event data
                    <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
                  </Button>
                </CollapsibleTrigger>
              )}
              {link && (
                <Button size="xs" variant="ghost" asChild className="text-muted-foreground">
                  <Link to={link.to}>
                    {link.label} <ArrowUpRight />
                  </Link>
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
      {payload && (
        <CollapsibleContent>
          <div className="relative mt-2 ml-10 rounded-lg border bg-paper-2">
            <CopyButton text={payload} label="Copy event data" className="absolute top-1.5 right-1.5" />
            <pre className="max-h-72 overflow-auto p-3 pr-9 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/85 [overflow-wrap:anywhere]">{payload}</pre>
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

function EmptyEvents({ routine }: { routine: Routine }) {
  const t = routine.trigger;
  const next = relative(routine.nextRunAt);
  const copy =
    t.type === "schedule"
      ? { title: "No runs yet", body: next && routine.enabled ? `The first run is ${next.text}.` : "Runs show up here when the schedule fires." }
      : t.type === "app"
        ? { title: "Waiting for the first event", body: `Godmode is listening for “${t.triggerName}” in ${prettySlug(t.toolkit)}.` }
        : t.type === "condition"
          ? { title: "Not met yet", body: next && routine.enabled ? `The next check is ${next.text}.` : "Once a check finds the condition true, it shows up here." }
          : { title: "No calls yet", body: "Call the webhook URL — or send a test event — and it shows up here." };
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed bg-card/50 px-6 py-10 text-center">
      <div className="mb-3 grid size-10 place-items-center rounded-lg border bg-card text-foreground shadow-card">
        <Inbox className="size-4.5" />
      </div>
      <p className="text-sm font-medium">{copy.title}</p>
      <p className="mt-1 max-w-xs text-xs text-muted-foreground">{copy.body}</p>
    </div>
  );
}
