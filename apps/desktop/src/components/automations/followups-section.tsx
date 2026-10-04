import { Link } from "react-router";
import { motion } from "motion/react";
import type { Agent, Followup } from "@godmode/shared";
import { AlarmClock, CalendarClock, Play, X } from "lucide-react";
import { AgentAvatar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FollowupTimePicker, followupIn, followupWhen, useFollowupActions } from "@/components/chat/followup";
import { useNow } from "@/components/vault/use-now";
import { useLive } from "@/stores/live";

/** Chats agents will pick up again on their own (followup_schedule), soonest first. */
export function FollowupsSection({ followups, agentById }: { followups: Followup[]; agentById: Map<string, Agent> }) {
  const now = useNow(30_000);
  const actions = useFollowupActions();
  const liveRuns = useLive((s) => s.runs);
  const busy = new Set(Object.values(liveRuns).flatMap((r) => (r.status === "running" ? [r.conversationId] : [])));
  if (!followups.length) return null;

  return (
    <section aria-labelledby="followups-heading" className="space-y-2.5">
      <div className="flex items-baseline gap-2">
        <h2 id="followups-heading" className="eyebrow flex items-center gap-2 [&_svg]:size-3.5">
          <AlarmClock /> Follow-ups
        </h2>
        <span className="text-xs text-muted-foreground">Chats your agents will pick up again on their own</span>
      </div>
      <ul className="overflow-hidden rounded-xl border bg-card shadow-card">
        {followups.map((f, i) => {
          const agent = agentById.get(f.agentId);
          const working = busy.has(f.conversationId);
          const cancelling = actions.cancel.isPending && actions.cancel.variables === f.conversationId;
          return (
            <motion.li
              key={f.conversationId}
              layout
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i, 8) * 0.03 }}
              className="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
            >
              {agent ? <AgentAvatar agent={agent} size="sm" /> : <span className="size-6" />}
              <div className="min-w-0 flex-1 leading-snug">
                <div className="flex min-w-0 items-baseline gap-2 text-[13px]">
                  <Link to={`/chat/${f.conversationId}`} className="truncate font-medium hover:underline focus-visible:underline focus-visible:outline-none">
                    {f.title}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">{agent?.name}</span>
                </div>
                <p className="truncate text-xs text-muted-foreground" title={f.note}>
                  {f.note}
                </p>
              </div>
              <div className="hidden shrink-0 text-right leading-snug @2xl:block">
                <div className="text-[13px] tabular-nums">{followupWhen(f.dueAt)}</div>
                <div className="text-[11px] text-muted-foreground tabular-nums">{followupIn(f.dueAt, now)}</div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={working ? 0 : -1}>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Continue “${f.title}” now`}
                        disabled={working || (actions.runNow.isPending && actions.runNow.variables === f.conversationId)}
                        onClick={() => actions.runNow.mutate(f.conversationId)}
                      >
                        {actions.runNow.isPending && actions.runNow.variables === f.conversationId ? <Spinner /> : <Play />}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{working ? "Working in this chat right now" : "Continue now"}</TooltipContent>
                </Tooltip>
                <FollowupTimePicker dueAt={f.dueAt} onPick={(dueAt) => actions.move.mutateAsync({ conversationId: f.conversationId, dueAt })}>
                  <Button size="icon-sm" variant="ghost" aria-label={`Change when “${f.title}” continues`}>
                    <CalendarClock />
                  </Button>
                </FollowupTimePicker>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Cancel the follow-up of “${f.title}”`}
                      disabled={cancelling}
                      onClick={() => actions.cancel.mutate(f.conversationId)}
                    >
                      {cancelling ? <Spinner /> : <X />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Cancel</TooltipContent>
                </Tooltip>
              </div>
            </motion.li>
          );
        })}
      </ul>
    </section>
  );
}
