import { Link, useNavigate } from "react-router";
import { formatDistanceToNowStrict } from "date-fns";
import { CalendarClock, Cpu, Ellipsis, History, MessageSquare, Pencil, Play, Power, PowerOff, Trash2 } from "lucide-react";
import type { Agent } from "@godmode/shared";
import { AgentAvatar, ScopeBadge } from "@/components/common";
import { WorkingTicks } from "@/components/aicss/Motion";
import { useModelLabel } from "@/components/runs/run-status";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { AgentStatus, useAgentLiveRun, useStartAgentChat, useToggleAgent } from "./agent-actions";

export function AgentCard({
  agent,
  routineCount,
  onRunTask,
  onDelete,
}: {
  agent: Agent;
  routineCount: number;
  onRunTask: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
}) {
  const navigate = useNavigate();
  const modelLabel = useModelLabel();
  const live = useAgentLiveRun(agent.id);
  const running = !!live;
  const chat = useStartAgentChat();
  const toggle = useToggleAgent();
  const chatting = chat.isPending && chat.variables === agent.id;

  return (
    <div
      className={cn(
        "group relative flex h-full flex-col rounded-xl border bg-card p-4 shadow-card transition-[box-shadow,border-color] duration-200",
        "hover:border-foreground/15 hover:shadow-float",
        running && "glow-border",
        !agent.enabled && "opacity-65",
      )}
    >
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agent} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Link
              to={`/agents/${agent.id}`}
              className="truncate text-[15px] font-medium tracking-[-0.01em] after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
            >
              {agent.name}
            </Link>
            {agent.isDefault && (
              <span className="shrink-0 rounded-[5px] border bg-secondary px-1.5 py-px text-[10px] font-medium text-muted-foreground">Built-in</span>
            )}
          </div>
          <AgentStatus agent={agent} className="mt-0.5 max-w-full" />
        </div>
        {running && <WorkingTicks count={6} className="mt-1 h-3 shrink-0 text-brand-strong" />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="relative z-10 -mt-1 -mr-1 text-muted-foreground" aria-label={`Actions for ${agent.name}`}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => chat.mutate(agent.id)}>
              <MessageSquare /> New chat
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onRunTask(agent)} disabled={!agent.enabled}>
              <Play /> Run task…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate(`/agents/${agent.id}/routines`)}>
              <CalendarClock /> Routines
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate(`/agents/${agent.id}/settings`)}>
              <Pencil /> Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => toggle.mutate({ id: agent.id, enabled: !agent.enabled })}>
              {agent.enabled ? <PowerOff /> : <Power />} {agent.enabled ? "Disable" : "Enable"}
            </DropdownMenuItem>
            {!agent.isDefault && (
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(agent)}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <p className="mt-3 line-clamp-2 min-h-10 text-sm text-muted-foreground">
        {agent.description || <span className="italic opacity-70">No description</span>}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <ScopeBadge workspaceId={agent.workspaceId} />
        <span className="flex items-center gap-1" title="Model">
          <Cpu className="size-3.5" /> {agent.model ? modelLabel(agent.model) : "Default model"}
        </span>
        <span className="flex items-center gap-1" title="Routines">
          <CalendarClock className="size-3.5" /> {routineCount}
        </span>
        <span className="flex items-center gap-1" title={agent.lastRunAt ? new Date(agent.lastRunAt).toLocaleString() : "Never ran"}>
          <History className="size-3.5" />
          {agent.lastRunAt ? formatDistanceToNowStrict(new Date(agent.lastRunAt), { addSuffix: true }) : "Never"}
        </span>
      </div>

      <div className="relative z-10 mt-4 flex gap-2 border-t pt-3">
        <Button size="sm" variant="secondary" className="flex-1" onClick={() => chat.mutate(agent.id)} disabled={chatting}>
          {chatting ? <Spinner /> : <MessageSquare />} Chat
        </Button>
        <Button size="sm" variant="outline" className="flex-1" onClick={() => onRunTask(agent)} disabled={!agent.enabled}>
          <Play /> Run task
        </Button>
      </div>
    </div>
  );
}
