import { Link, useLocation, useMatch, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { AlarmClock, Archive, Pin, Trash2 } from "lucide-react";
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
  const runningConversations = new Set(Object.values(liveRuns).map((r) => r.conversationId));
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
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((c) => {
            const agent = agents.find((a) => a.id === c.agentId);
            const running = runningConversations.has(c.id) || c.running;
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
                        <span className="truncate text-[13px]">{c.title || "New chat"}</span>
                        {c.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {running ? (
                          <span className="text-shimmer font-medium">Working…</span>
                        ) : c.followup ? (
                          <span className="flex items-center gap-1" title={c.followup.note}>
                            <AlarmClock className="size-3 shrink-0 text-brand-strong" aria-hidden />
                            <span className="truncate">Continues {followupWhen(c.followup.dueAt)}</span>
                          </span>
                        ) : (
                          <>
                            {agent?.name ?? "Agent"} · {formatDistanceToNowStrict(new Date(c.lastMessageAt ?? c.createdAt), { addSuffix: false })}
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
