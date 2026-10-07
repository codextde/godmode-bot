import { Link, useNavigate } from "react-router";
import { formatDistanceToNowStrict } from "date-fns";
import { Check, Copy, Cpu, Ellipsis, FolderInput, History, MessageSquare, Pause, Pencil, Play, Power, PowerOff, StepForward, Trash2, Workflow } from "lucide-react";
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAllAgents, useWorkspaces } from "@/lib/hooks";
import { GroupIcon } from "./agent-groups";
import { planMove, useMoveAgent } from "./agent-dnd";
import { cn } from "@/lib/utils";
import { AgentStatus, useAgentLiveRun, useAgentMood, useAgentPause, useDuplicateAgent, useStartAgentChat, useToggleAgent } from "./agent-actions";

export function AgentCard({
  agent,
  routineCount,
  showScope = true,
  onRunTask,
  onDelete,
}: {
  agent: Agent;
  routineCount: number;
  /** Off where the card sits under its workspace's heading. */
  showScope?: boolean;
  onRunTask: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
}) {
  const modelLabel = useModelLabel();
  const live = useAgentLiveRun(agent.id);
  const running = !!live || agent.status === "running";
  const mood = useAgentMood(agent);
  const chat = useStartAgentChat();
  const { pause, resume } = useAgentPause();
  const paused = (agent.pausedRuns ?? 0) > 0;
  const chatting = chat.isPending && chat.variables?.agent.id === agent.id;

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
        <AgentAvatar agent={agent} size="lg" mood={mood} />
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
          {agent.role && (
            <p className="truncate text-[12.5px] text-muted-foreground" title={agent.role}>
              {agent.role}
            </p>
          )}
          <AgentStatus agent={agent} interactive className="mt-0.5 max-w-full" />
        </div>
        {running && <WorkingTicks count={6} className="mt-1 h-3 shrink-0 text-brand-strong" />}
        <AgentMenu agent={agent} chat={chat} onRunTask={onRunTask} onDelete={onDelete} className="-mt-1 -mr-1" />
      </div>

      <p className="mt-2.5 line-clamp-2 min-h-10 flex-1 text-[13px] leading-5 text-muted-foreground">
        {agent.description || <span className="italic opacity-70">No description</span>}
      </p>

      <div className="mt-3 flex items-center gap-3 border-t pt-3 text-xs text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center gap-x-3 overflow-hidden whitespace-nowrap">
          {showScope && <ScopeBadge workspaceId={agent.workspaceId} className="min-w-0 truncate" />}
          <span className="flex shrink-0 items-center gap-1" title={`${routineCount} automation${routineCount === 1 ? "" : "s"}`}>
            <Workflow className="size-3.5" /> {routineCount}
          </span>
          <span className="flex min-w-0 items-center gap-1" title={agent.lastRunAt ? `Last run ${new Date(agent.lastRunAt).toLocaleString()}` : "Never ran"}>
            <History className="size-3.5 shrink-0" />
            <span className="truncate">{agent.lastRunAt ? formatDistanceToNowStrict(new Date(agent.lastRunAt), { addSuffix: true }) : "Never"}</span>
          </span>
          {agent.model && (
            <span className="flex min-w-0 items-center gap-1" title="Model">
              <Cpu className="size-3.5 shrink-0" /> <span className="truncate">{modelLabel(agent.model)}</span>
            </span>
          )}
        </div>
        <div className="relative z-10 flex shrink-0 gap-1.5">
          <Button size="xs" variant="secondary" className="h-7 px-2.5" onClick={() => chat.mutate(agent)} disabled={chatting}>
            {chatting ? <Spinner /> : <MessageSquare />} Chat
          </Button>
          {paused ? (
            <Button size="xs" variant="outline" className="h-7 px-2.5" onClick={() => resume.mutate(agent)} disabled={resume.isPending || !agent.enabled}>
              {resume.isPending ? <Spinner /> : <StepForward />} Continue
            </Button>
          ) : running ? (
            <Button size="xs" variant="outline" className="h-7 px-2.5" onClick={() => pause.mutate(agent)} disabled={pause.isPending}>
              {pause.isPending ? <Spinner /> : <Pause className="fill-current" />} Pause
            </Button>
          ) : (
            <Button size="xs" variant="outline" className="h-7 px-2.5" onClick={() => onRunTask(agent)} disabled={!agent.enabled}>
              <Play /> Run
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Everything you can do with an agent, behind its "…" button. */
export function AgentMenu({
  agent,
  chat,
  onRunTask,
  onDelete,
  className,
}: {
  agent: Agent;
  /** The chat starter of the card or row, so both show the same pending state. */
  chat: ReturnType<typeof useStartAgentChat>;
  onRunTask: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
  className?: string;
}) {
  const navigate = useNavigate();
  const live = useAgentLiveRun(agent.id);
  const running = !!live || agent.status === "running";
  const chatting = chat.isPending && chat.variables?.agent.id === agent.id;
  const toggle = useToggleAgent();
  const duplicate = useDuplicateAgent();
  const { pause, resume } = useAgentPause();
  const paused = (agent.pausedRuns ?? 0) > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className={cn("relative z-10 text-muted-foreground", className)} aria-label={`Actions for ${agent.name}`}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={() => chat.mutate(agent)} disabled={chatting}>
          <MessageSquare /> New chat
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onRunTask(agent)} disabled={!agent.enabled}>
          <Play /> Run task…
        </DropdownMenuItem>
        {running && (
          <DropdownMenuItem onClick={() => pause.mutate(agent)}>
            <Pause /> Pause
          </DropdownMenuItem>
        )}
        {paused && (
          <DropdownMenuItem onClick={() => resume.mutate(agent)} disabled={!agent.enabled}>
            <StepForward /> Continue
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => navigate(`/agents/${agent.id}/routines`)}>
          <Workflow /> Automations
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate(`/agents/${agent.id}/settings`)}>
          <Pencil /> Edit
        </DropdownMenuItem>
        {!agent.isDefault && (
          <DropdownMenuItem onClick={() => duplicate.mutate(agent)} disabled={duplicate.isPending}>
            <Copy /> Duplicate
          </DropdownMenuItem>
        )}
        {!agent.isDefault && <MoveToMenu agent={agent} />}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => toggle.mutate({ id: agent.id, enabled: !agent.enabled })}>
          {agent.enabled ? <PowerOff /> : <Power />} {agent.enabled ? "Switch off" : "Switch on"}
        </DropdownMenuItem>
        {!agent.isDefault && (
          <DropdownMenuItem variant="destructive" onClick={() => onDelete(agent)}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The menu's way to move an agent to another workspace, with its team (the same as dragging it there). */
function MoveToMenu({ agent }: { agent: Agent }) {
  const { data: workspaces = [] } = useWorkspaces();
  const { data: all = [] } = useAllAgents();
  const move = useMoveAgent();
  const to = (workspaceId: string | null) => {
    const plan = planMove(agent, { kind: "workspace", workspaceId }, all.length ? all : [agent], workspaces);
    if (plan?.ok) move.mutate({ agent, plan });
  };
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <FolderInput /> Move to
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 w-52 overflow-y-auto">
        {[null, ...workspaces].map((w) => {
          const here = agent.workspaceId === (w?.id ?? null);
          return (
            <DropdownMenuItem key={w?.id ?? "global"} disabled={here || move.isPending} onClick={() => to(w?.id ?? null)}>
              <GroupIcon workspace={w} isGlobal={!w} className="size-4.5 rounded-[4px] text-[10px] [&_svg]:size-3" />
              <span className="truncate">{w?.name ?? "Global"}</span>
              {here && <Check className="ml-auto" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
