import { useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import {
  ArrowLeft,
  Bot,
  Brain,
  CalendarClock,
  Cpu,
  Ellipsis,
  GitCommitHorizontal,
  Globe,
  LayoutGrid,
  MessageSquare,
  MessagesSquare,
  Play,
  Settings2,
  Trash2,
} from "lucide-react";
import type { Agent } from "@godmode/shared";
import { api, ApiRequestError, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/core";
import { isMac } from "@/lib/desktop";
import { AgentAvatar, EmptyState, PageBody, ScopeBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useModelLabel } from "@/components/runs/run-status";
import {
  AgentStatus,
  DeleteAgentDialog,
  RunTaskDialog,
  useAgentLiveRun,
  useStartAgentChat,
  useToggleAgent,
} from "@/components/agents/agent-actions";
import { OverviewTab } from "@/components/agents/detail/overview-tab";
import { ChatsTab } from "@/components/agents/detail/chats-tab";
import { RoutinesTab } from "@/components/agents/detail/routines-tab";
import { MemoryTab } from "@/components/agents/detail/memory-tab";
import { HistoryTab } from "@/components/agents/detail/history-tab";
import { SettingsTab } from "@/components/agents/detail/settings-tab";

const TABS = [
  { id: "", label: "Overview", icon: LayoutGrid },
  { id: "chats", label: "Chats", icon: MessagesSquare },
  { id: "routines", label: "Routines", icon: CalendarClock },
  { id: "memory", label: "Memory", icon: Brain },
  { id: "history", label: "History", icon: GitCommitHorizontal },
  { id: "settings", label: "Settings", icon: Settings2 },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function AgentDetailPage() {
  const params = useParams();
  const agentId = params.agentId!;
  const rest = (params["*"] ?? "").split("/")[0];
  const tab: TabId = (TABS.find((t) => t.id === rest)?.id ?? "") as TabId;
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: qk.agent(agentId),
    queryFn: () => api.agents.get(agentId),
    // Render instantly from any cached agent list
    placeholderData: () => {
      for (const [, data] of qc.getQueriesData<Agent[]>({ queryKey: [...qk.agents, "list"] })) {
        const hit = Array.isArray(data) ? data.find((a) => a.id === agentId) : undefined;
        if (hit) return hit;
      }
      return undefined;
    },
  });

  if (q.isLoading) return <HeaderSkeleton />;
  if (!q.data) {
    const notFound = q.error instanceof ApiRequestError && q.error.status === 404;
    return (
      <PageBody className="pt-10">
        <EmptyState
          icon={<Bot />}
          title={notFound ? "Agent not found" : "Couldn't load this agent"}
          description={notFound ? "It may have been deleted." : errorMessage(q.error)}
          action={
            <Button variant="outline" asChild>
              <Link to="/agents">
                <ArrowLeft /> All agents
              </Link>
            </Button>
          }
        />
      </PageBody>
    );
  }

  const agent = q.data;
  return (
    <div className="min-h-full">
      <AgentHeader agent={agent} />
      <TabNav agentId={agent.id} active={tab} />
      <PageBody className="pt-6">
        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
          {tab === "" && <OverviewTab agent={agent} />}
          {tab === "chats" && <ChatsTab agent={agent} />}
          {tab === "routines" && <RoutinesTab agent={agent} />}
          {tab === "memory" && <MemoryTab agent={agent} />}
          {tab === "history" && <HistoryTab agent={agent} />}
          {tab === "settings" && <SettingsTab agent={agent} />}
        </motion.div>
      </PageBody>
    </div>
  );
}

function AgentHeader({ agent }: { agent: Agent }) {
  const modelLabel = useModelLabel();
  const navigate = useNavigate();
  const chat = useStartAgentChat();
  const toggle = useToggleAgent();
  const live = useAgentLiveRun(agent.id);
  const [runTask, setRunTask] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="relative border-b">
      <div className="relative px-8 pt-6 pb-6">
        <Link to="/agents" className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Agents
        </Link>
        <div className="flex flex-wrap items-start gap-5">
          <div className={cn("rounded-2xl", live && "glow-border")}>
            <AgentAvatar agent={agent} size="xl" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[26px] leading-tight font-medium tracking-[-0.03em]">{agent.name}</h1>
              {agent.isDefault && (
                <span className="rounded-[5px] border bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">Built-in</span>
              )}
            </div>
            {agent.description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{agent.description}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
              <AgentStatus agent={agent} />
              <ScopeBadge workspaceId={agent.workspaceId} />
              <span className="flex items-center gap-1">
                <Cpu className="size-3.5" /> {agent.model ? modelLabel(agent.model) : "Default model"}
                {agent.effort && <span className="text-muted-foreground/70">· {agent.effort} effort</span>}
              </span>
              {agent.browser.enabled && (
                <span className="flex items-center gap-1">
                  <Globe className="size-3.5" /> Browser
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <label className="mr-1 flex cursor-pointer items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-card">
                  <Switch
                    checked={agent.enabled}
                    onCheckedChange={(enabled) => toggle.mutate({ id: agent.id, enabled })}
                    disabled={toggle.isPending}
                    aria-label={agent.enabled ? "Disable agent" : "Enable agent"}
                  />
                  {agent.enabled ? "Enabled" : "Disabled"}
                </label>
              </TooltipTrigger>
              <TooltipContent>{agent.enabled ? "Disable: routines and delegations stop" : "Enable this agent"}</TooltipContent>
            </Tooltip>
            <Button variant="outline" onClick={() => setRunTask(true)} disabled={!agent.enabled}>
              <Play /> Run task
            </Button>
            <Button onClick={() => chat.mutate(agent.id)} disabled={chat.isPending}>
              {chat.isPending ? <Spinner /> : <MessageSquare />} Chat
            </Button>
            {!agent.isDefault && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="More actions">
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => navigate(`/agents/${agent.id}/settings`)}>
                    <Settings2 /> Settings
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                    <Trash2 /> Delete agent
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>
      <RunTaskDialog agent={agent} open={runTask} onOpenChange={setRunTask} />
      <DeleteAgentDialog agent={agent} open={confirmDelete} onOpenChange={setConfirmDelete} onDeleted={() => navigate("/agents")} />
    </div>
  );
}

function TabNav({ agentId, active }: { agentId: string; active: TabId }) {
  return (
    <nav
      aria-label="Agent sections"
      // Clear the macOS title-bar drag region in the desktop shell
      className={cn("sticky z-20 border-b bg-background px-6", isTauri && isMac ? "top-7" : "top-0")}
    >
      <div className="flex gap-1 overflow-x-auto py-2 [scrollbar-width:none]">
        {TABS.map((t) => {
          const isActive = t.id === active;
          const Icon = t.icon;
          return (
            <NavLink
              key={t.id}
              to={t.id ? `/agents/${agentId}/${t.id}` : `/agents/${agentId}`}
              end
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "relative flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm transition focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {isActive && (
                <motion.span
                  layoutId="agent-tab"
                  className="absolute inset-0 rounded-md border bg-card shadow-card"
                  transition={{ type: "spring", bounce: 0.18, duration: 0.4 }}
                />
              )}
              <Icon className="relative size-4" />
              <span className="relative">{t.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

function HeaderSkeleton() {
  return (
    <div>
      <div className="border-b px-8 pt-12 pb-6">
        <div className="flex items-start gap-5">
          <Skeleton className="size-16 rounded-xl" />
          <div className="flex-1 space-y-2.5">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-4 w-96 max-w-full" />
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
      </div>
      <div className="flex gap-2 border-b px-6 py-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-24 rounded-md" />
        ))}
      </div>
      <PageBody className="pt-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      </PageBody>
    </div>
  );
}
