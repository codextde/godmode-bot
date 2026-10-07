import { Link } from "react-router";
import { formatDistanceToNowStrict } from "date-fns";
import { History, MessageSquare, Workflow } from "lucide-react";
import type { Agent } from "@godmode/shared";
import { leadOf } from "@godmode/shared";
import { AgentAvatar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AgentStatus, useAgentLiveRun, useAgentMood, useStartAgentChat } from "./agent-actions";
import { AgentMenu } from "./agent-card";
import { useAgentDrag } from "./agent-dnd";

const COLUMNS = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_6.5rem_auto] @5xl:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_minmax(0,11rem)_3.5rem_6.5rem_auto]";

/** Agents as dense rows: many at a glance, one line each. */
export function AgentList({
  agents,
  all,
  routineCounts,
  onRunTask,
  onDelete,
}: {
  agents: Agent[];
  /** Every agent, to name leads. */
  all: Agent[];
  routineCounts: Map<string, number>;
  onRunTask: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
}) {
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-card">
      {agents.map((a) => (
        <AgentRow key={a.id} agent={a} all={all} routineCount={routineCounts.get(a.id) ?? 0} onRunTask={onRunTask} onDelete={onDelete} />
      ))}
    </ul>
  );
}

function AgentRow({
  agent,
  all,
  routineCount,
  onRunTask,
  onDelete,
}: {
  agent: Agent;
  all: Agent[];
  routineCount: number;
  onRunTask: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
}) {
  const mood = useAgentMood(agent);
  const live = useAgentLiveRun(agent.id);
  const chat = useStartAgentChat();
  const chatting = chat.isPending && chat.variables?.agent.id === agent.id;
  const lead = leadOf(agent, all);
  const drag = useAgentDrag(agent);
  return (
    <li
      ref={drag.ref}
      {...drag.props}
      className={cn(
        "group relative px-3 py-2 transition-[background-color,opacity] hover:bg-foreground/[0.025]",
        COLUMNS,
        (!!live || agent.status === "running") && "bg-brand/[0.04]",
        drag.isDragging && "opacity-35",
      )}
    >
      <div className={cn("flex min-w-0 items-center gap-3", !agent.enabled && "opacity-60")}>
        <AgentAvatar agent={agent} size="md" mood={mood} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <Link
              to={`/agents/${agent.id}`}
              className="truncate text-sm font-medium tracking-[-0.01em] after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
            >
              {agent.name}
            </Link>
            {agent.isDefault && <span className="shrink-0 rounded-[5px] border bg-secondary px-1.5 py-px text-[10px] font-medium text-muted-foreground">Built-in</span>}
          </div>
          <p className="truncate text-xs text-muted-foreground" title={agent.role || undefined}>
            {agent.role || agent.description || <span className="italic opacity-70">No role yet</span>}
          </p>
          <AgentStatus agent={agent} interactive className="mt-0.5 max-w-full @2xl:hidden" />
        </div>
      </div>
      <AgentStatus agent={agent} interactive className="hidden max-w-full @2xl:inline-flex" />
      <span className="hidden min-w-0 items-center gap-1.5 text-xs text-muted-foreground @5xl:flex">
        {agent.isDefault ? (
          "Reports to you"
        ) : lead ? (
          <>
            <AgentAvatar agent={lead} size="sm" still className="size-4 shrink-0" />
            <span className="truncate">{lead.name}</span>
          </>
        ) : (
          "—"
        )}
      </span>
      <span className="hidden items-center gap-1 text-xs text-muted-foreground tabular-nums @5xl:flex" title={`${routineCount} automation${routineCount === 1 ? "" : "s"}`}>
        <Workflow className="size-3.5" aria-hidden /> {routineCount}
      </span>
      <span className="hidden items-center gap-1 text-xs whitespace-nowrap text-muted-foreground @2xl:flex" title={agent.lastRunAt ? new Date(agent.lastRunAt).toLocaleString() : "Never ran"}>
        <History className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{agent.lastRunAt ? formatDistanceToNowStrict(new Date(agent.lastRunAt), { addSuffix: true }) : "Never"}</span>
      </span>
      <span className="relative z-10 flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              aria-label={`Chat with ${agent.name}`}
              onClick={() => chat.mutate(agent)}
              disabled={chatting}
            >
              {chatting ? <Spinner /> : <MessageSquare />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>New chat</TooltipContent>
        </Tooltip>
        <AgentMenu agent={agent} chat={chat} onRunTask={onRunTask} onDelete={onDelete} />
      </span>
    </li>
  );
}
