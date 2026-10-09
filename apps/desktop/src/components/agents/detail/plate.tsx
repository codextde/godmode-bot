import type { ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { AlarmClock, CircleStop, Hourglass, KanbanSquare, MessageCircleQuestion, Pause, Plus, Power, RefreshCw, Workflow } from "lucide-react";
import type { Agent, Run, Task } from "@godmode/shared";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { useConversations, useFollowups, useQuestions, useRoutines, useTasks } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { LiveDot } from "@/components/aicss/Motion";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useNow } from "@/components/runs/run-row";
import { useCancelRun } from "@/components/runs/run-detail-sheet";
import { formatElapsed } from "@/components/runs/run-status";
import { followupWhen } from "@/components/chat/followup";
import { STATUS_META } from "@/components/tasks/task-meta";
import type { LiveRun } from "@/stores/live";
import { useAgentLiveRuns, useToggleAgent } from "../agent-actions";
import { cronToHuman, scheduleToHuman } from "../cron";
import { lowerFirst, TRIGGER_TYPES } from "@/components/automations/trigger-meta";

const TICKET_ORDER: Task["status"][] = ["in_progress", "blocked", "in_review", "todo"];
const SHOWN_TICKETS = 6;

/**
 * Everything the agent has going on, in one place: what it works on right now, what stands still (and why), its
 * tickets on the board, the follow-ups it promised and its next automations. Built from data the app already keeps live.
 */
export function Plate({ agent, onRunTask }: { agent: Agent; onRunTask: () => void }) {
  const live = useAgentLiveRuns(agent.id);
  // Standing-still runs come from the runs themselves: board and automation chats are archived and not in the chat list.
  const paused = useQuery({
    queryKey: [...qk.runs, "paused", agent.id],
    queryFn: () => api.runs.list({ agentId: agent.id, status: "paused", limit: 50 }),
  });
  const questions = useQuestions("open");
  const chats = useConversations(agent.id);
  const tasks = useTasks("all");
  const followups = useFollowups();
  const routines = useRoutines(agent.id);
  const toggle = useToggleAgent();

  const tickets = (tasks.data ?? [])
    .filter((t) => t.agentId === agent.id && TICKET_ORDER.includes(t.status))
    .sort((a, b) => TICKET_ORDER.indexOf(a.status) - TICKET_ORDER.indexOf(b.status) || a.position - b.position);
  const promised = (followups.data ?? []).filter((f) => f.agentId === agent.id).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const next = (routines.data ?? []).filter((r) => r.enabled && r.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!));
  const liveIds = new Set(live.map((r) => r.runId));
  const standing = (paused.data ?? []).filter((r) => !liveIds.has(r.id));

  const titleOf = (conversationId: string, prompt?: string) =>
    (tasks.data ?? []).find((t) => t.conversationId === conversationId)?.title ??
    (chats.data ?? []).find((c) => c.id === conversationId)?.title ??
    (prompt ? prompt.replace(/^\[[^\]]*\]\s*/, "").slice(0, 80) : "A chat");

  const loading = paused.isLoading || tasks.isLoading || followups.isLoading || routines.isLoading;
  const empty = !live.length && !standing.length && !tickets.length && !promised.length && !next.length;

  return (
    <section aria-labelledby="plate-heading" className={cn("rounded-xl border bg-card p-4 shadow-card", live.some((r) => r.status === "running") && "glow-border")}>
      <h2 id="plate-heading" className="mb-3 text-sm font-medium tracking-[-0.01em]">
        On its plate
      </h2>
      {loading && empty ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-9 w-full rounded-lg" />
          ))}
        </div>
      ) : empty ? (
        !agent.enabled ? (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            {agent.name} is switched off.
            <Button size="sm" variant="outline" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: agent.id, enabled: true })}>
              {toggle.isPending ? <Spinner /> : <Power />} Switch on
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="mr-1">Nothing on {agent.name}'s plate right now.</span>
            <Button size="sm" variant="outline" onClick={onRunTask}>
              Run task
            </Button>
            <Button size="sm" variant="ghost" asChild>
              <Link to={`/agents/${agent.id}/routines`}>
                <Plus /> Add automation
              </Link>
            </Button>
          </div>
        )
      ) : (
        <div className="space-y-4">
          {(live.length > 0 || standing.length > 0) && (
            <Group label="Now">
              {live.map((r) => (
                <LiveRow key={r.runId} run={r} title={titleOf(r.conversationId)} />
              ))}
              {standing.map((r) => (
                <StandingRow key={r.id} run={r} title={titleOf(r.conversationId, r.prompt)} waiting={(questions.data ?? []).some((q) => q.runId === r.id)} />
              ))}
            </Group>
          )}
          {tickets.length > 0 && (
            <Group label="Board tickets">
              {tickets.slice(0, SHOWN_TICKETS).map((t) => (
                <Row key={t.id} to={`/tasks?task=${t.id}`} icon={<KanbanSquare className="size-3.5" />}>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">#{t.number}</span> {t.title}
                    {t.status === "blocked" && t.blockedReason && <span className="text-rose-600 dark:text-rose-400"> — {t.blockedReason}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{STATUS_META[t.status].label}</span>
                </Row>
              ))}
              {tickets.length > SHOWN_TICKETS && (
                <Link to={`/tasks?agent=${agent.id}`} className="block px-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                  {tickets.length - SHOWN_TICKETS} more on the board
                </Link>
              )}
            </Group>
          )}
          {tasks.isError && <RetryRow text="Couldn't load its board tickets." onRetry={() => tasks.refetch()} error={tasks.error} />}
          {promised.length > 0 && (
            <Group label="Follow-ups">
              {promised.map((f) => (
                <Row key={f.conversationId} to={`/chat/${f.conversationId}`} icon={<AlarmClock className="size-3.5 text-brand-strong" />}>
                  <span className="min-w-0 flex-1 truncate" title={f.note}>
                    {f.note || f.title}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{followupWhen(f.dueAt)}</span>
                </Row>
              ))}
            </Group>
          )}
          {next.length > 0 && (
            <Group label={next.length > 1 ? "Next automations" : "Next automation"}>
              {next.slice(0, 3).map((r) => {
                const Icon = TRIGGER_TYPES[r.trigger.type]?.icon ?? Workflow;
                return (
                  <Row key={r.id} to={`/agents/${agent.id}/routines`} icon={<Icon className="size-3.5" />}>
                    <span className="min-w-0 flex-1 truncate">
                      {r.name}{" "}
                      <span className="text-xs text-muted-foreground">
                        ·{" "}
                        {r.trigger.type === "condition"
                          ? `checks ${lowerFirst(cronToHuman(r.cron))}`
                          : lowerFirst(
                              r.trigger.type === "schedule" ? scheduleToHuman(r.cron, r.trigger.startWindowMinutes, r.trigger.runsPerWindow) : scheduleToHuman(r.cron),
                            )}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatDistanceToNowStrict(new Date(r.nextRunAt!), { addSuffix: true })}</span>
                  </Row>
                );
              })}
              {next.length > 3 && (
                <Link to={`/agents/${agent.id}/routines`} className="block px-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                  and {next.length - 3} more
                </Link>
              )}
            </Group>
          )}
        </div>
      )}
    </section>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="eyebrow mb-1 text-[10.5px]">{label}</p>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function Row({ to, icon, children }: { to: string; icon: ReactNode; children: ReactNode }) {
  return (
    <li>
      <Link to={to} className="flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
        <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">{icon}</span>
        {children}
      </Link>
    </li>
  );
}

function LiveRow({ run, title }: { run: LiveRun; title: string }) {
  const working = run.status === "running";
  const now = useNow(working);
  const cancel = useCancelRun();
  return (
    <li className="flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px]">
      <span className="grid size-4 shrink-0 place-items-center">{working ? <LiveDot /> : <span className="size-1.5 rounded-full bg-muted-foreground/50" />}</span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", working ? "text-shimmer font-medium" : "text-muted-foreground")}>
          {working ? (run.activity && run.activity !== "Starting…" ? run.activity : "Working…") : "Queued — waiting for a free slot"}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{title}</span>
      </span>
      {working && <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{formatElapsed(now - run.startedAt)}</span>}
      <Button size="xs" variant="ghost" asChild>
        <Link to={`/chat/${run.conversationId}`}>Watch</Link>
      </Button>
      <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={cancel.isPending} onClick={() => cancel.mutate(run.runId)} aria-label={`Stop: ${title}`}>
        {cancel.isPending ? <Spinner /> : <CircleStop />}
      </Button>
    </li>
  );
}

function StandingRow({ run, title, waiting }: { run: Run; title: string; waiting: boolean }) {
  const limit = run.pause?.reason === "limit";
  return (
    <Row
      to={`/chat/${run.conversationId}`}
      icon={waiting ? <MessageCircleQuestion className="size-3.5 text-warning" /> : limit ? <Hourglass className="size-3.5 text-warning" /> : <Pause className="size-3 fill-current" />}
    >
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", waiting && "font-medium")}>
          {waiting
            ? "Waiting for your answer"
            : limit
              ? `Waiting for Claude's ${run.pause?.limit ?? "usage limit"}${run.pause?.auto && run.pause.resumeAt ? ` · continues ${followupWhen(run.pause.resumeAt)}` : ""}`
              : "Paused"}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{title}</span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">Open chat</span>
    </Row>
  );
}

function RetryRow({ text, onRetry, error }: { text: string; onRetry: () => void; error: unknown }) {
  return (
    <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground" title={errorMessage(error)}>
      {text}
      <Button size="xs" variant="ghost" onClick={onRetry}>
        <RefreshCw /> Try again
      </Button>
    </div>
  );
}
