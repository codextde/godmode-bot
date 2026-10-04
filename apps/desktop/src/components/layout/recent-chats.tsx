import { Link, useLocation, useMatch, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import type { Agent, Conversation } from "@godmode/shared";
import { AlarmClock, Archive, Hourglass, MessageCircleQuestion, Pause, Pin, Trash2 } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentAvatar } from "@/components/common";
import { useArchiveChat, useDeleteChat } from "@/components/chat/chat-actions";
import { followupWhen } from "@/components/chat/followup";
import { api } from "@/lib/api";
import { useAllAgents, useConversations } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useLive } from "@/stores/live";

const ROW_ACTION =
  "top-1/2! size-6 -translate-y-1/2 text-muted-foreground after:inset-x-0 hover:bg-background hover:text-foreground hover:shadow-card [&>svg]:size-3.5";

export function RecentChats() {
  const { data: conversations = [] } = useConversations();
  const { data: hasArchived = false } = useQuery({
    queryKey: [...qk.conversationsAll, "has-archived"],
    queryFn: async () => (await api.conversations.list({ archived: true, limit: 1 })).length > 0,
  });
  const { data: agents = [] } = useAllAgents();
  const conversationId = useMatch("/chat/:conversationId")?.params.conversationId;
  const { pathname } = useLocation();
  const liveRuns = useLive((s) => s.runs);
  const runningConversations = new Set(Object.values(liveRuns).flatMap((r) => (r.status === "running" ? [r.conversationId] : [])));
  const queuedConversations = new Set(Object.values(liveRuns).flatMap((r) => (r.status === "queued" ? [r.conversationId] : [])));
  const { setArchived } = useArchiveChat();
  const navigate = useNavigate();
  const { askDelete, deleteDialog } = useDeleteChat((id) => id === conversationId && navigate("/", { replace: true }));

  const items = [...conversations]
    .filter((c) => !c.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))
    .slice(0, 30);

  if (items.length === 0 && !hasArchived) return deleteDialog;

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel className="eyebrow text-[10.5px]">Recent</SidebarGroupLabel>
      {items.some((c) => c.unread) && (
        <button
          type="button"
          onClick={() => void api.conversations.read("all").catch(() => undefined)}
          className="absolute top-3.5 right-3 text-[11px] text-muted-foreground transition hover:text-foreground"
        >
          Mark all read
        </button>
      )}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((c) => {
            const agent = agents.find((a) => a.id === c.agentId);
            const running = runningConversations.has(c.id) || (c.running && !queuedConversations.has(c.id));
            const queued = !running && queuedConversations.has(c.id);
            return (
              <SidebarMenuItem key={c.id}>
                <SidebarMenuButton
                  asChild
                  isActive={conversationId === c.id}
                  className="h-auto py-1.5 group-focus-within/menu-item:pr-15! group-hover/menu-item:pr-15! group-has-data-[sidebar=menu-action]/menu-item:pr-2 max-md:pr-15! data-[active=true]:bg-card data-[active=true]:shadow-card data-[active=true]:ring-1 data-[active=true]:ring-border"
                >
                  <Link to={`/chat/${c.id}`} className="flex items-start gap-2">
                    <AgentAvatar agent={agent ?? { id: c.agentId, color: "violet" }} size="sm" still className="-mt-0.5 size-5" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1">
                        <span className={cn("truncate text-[13px]", c.unread && conversationId !== c.id && "font-semibold text-foreground")}>{c.title || "New chat"}</span>
                        {c.unread && conversationId !== c.id && (
                          <span
                            className={cn("size-1.5 shrink-0 rounded-full", c.unread.failed ? "bg-destructive" : "bg-brand-strong")}
                            role="img"
                            aria-label={c.unread.failed ? "Something went wrong here" : "New reply"}
                          />
                        )}
                        {c.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {running && !c.paused ? (
                          <span className="text-shimmer font-medium">Working…</span>
                        ) : queued && !c.paused ? (
                          <span>Queued — waiting for a free slot</span>
                        ) : c.paused?.reason === "question" ? (
                          <span className="flex items-center gap-1 text-foreground" title={c.paused.question?.title}>
                            <MessageCircleQuestion className="size-3 shrink-0 text-warning" aria-hidden />
                            <span className="truncate">
                              {c.paused.question?.kind === "approval" ? "Needs your OK" : "Needs your answer"}
                              {c.paused.question?.title ? ` · ${c.paused.question.title}` : ""}
                            </span>
                          </span>
                        ) : c.paused ? (
                          <span className="flex items-center gap-1">
                            {c.paused.reason === "limit" ? (
                              <Hourglass className="size-3 shrink-0 text-warning" aria-hidden />
                            ) : (
                              <Pause className="size-3 shrink-0 fill-current" aria-hidden />
                            )}
                            <span className="truncate">
                              {c.paused.reason === "user"
                                ? "Paused"
                                : c.paused.reason === "budget"
                                  ? "Held — budget used up"
                                  : c.paused.auto && c.paused.resumeAt
                                    ? `Continues ${followupWhen(c.paused.resumeAt)}`
                                    : "Waiting for the limit"}
                            </span>
                          </span>
                        ) : c.followup ? (
                          <span className="flex items-center gap-1" title={c.followup.note}>
                            <AlarmClock className="size-3 shrink-0 text-brand-strong" aria-hidden />
                            <span className="truncate">Continues {followupWhen(c.followup.dueAt)}</span>
                          </span>
                        ) : (
                          <>
                            {originLine(c, agents) ?? agent?.name ?? "Agent"} · {formatDistanceToNowStrict(new Date(c.lastMessageAt ?? c.createdAt), { addSuffix: false })}
                          </>
                        )}
                      </span>
                    </span>
                  </Link>
                </SidebarMenuButton>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuAction
                      showOnHover
                      aria-label={`Archive “${c.title || "New chat"}”`}
                      onClick={() => setArchived(c, true)}
                      className={cn(ROW_ACTION, "right-7.5")}
                    >
                      <Archive />
                    </SidebarMenuAction>
                  </TooltipTrigger>
                  <TooltipContent side="top">Archive</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuAction
                      showOnHover
                      aria-label={`Delete “${c.title || "New chat"}”`}
                      onClick={() => askDelete(c)}
                      className={cn(ROW_ACTION, "hover:text-destructive")}
                    >
                      <Trash2 />
                    </SidebarMenuAction>
                  </TooltipTrigger>
                  <TooltipContent side="top">Delete</TooltipContent>
                </Tooltip>
              </SidebarMenuItem>
            );
          })}
          {hasArchived && (
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                size="sm"
                isActive={pathname === "/archived"}
                className="mt-1 gap-2 text-[12.5px] text-muted-foreground data-[active=true]:bg-card data-[active=true]:text-foreground data-[active=true]:shadow-card data-[active=true]:ring-1 data-[active=true]:ring-border [&>svg]:size-3.5"
              >
                <Link to="/archived">
                  <Archive />
                  <span>Archived chats</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
      {deleteDialog}
    </SidebarGroup>
  );
}

/** Where a chat came from when it wasn't the human's own: "From Lena" (handed over), "Automation". */
function originLine(c: Conversation, agents: Agent[]): string | null {
  if (c.origin === "delegation") {
    const from = c.delegatedFrom ? agents.find((a) => a.id === c.delegatedFrom!.agentId) : undefined;
    return from ? `From ${from.name}` : "Handed over";
  }
  if (c.origin === "routine") return "Automation";
  return null;
}
