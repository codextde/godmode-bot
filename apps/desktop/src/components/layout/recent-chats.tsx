import { Link, useParams } from "react-router";
import { formatDistanceToNowStrict } from "date-fns";
import { Pin } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useAllAgents, useConversations } from "@/lib/hooks";
import { useLive } from "@/stores/live";

export function RecentChats() {
  const { data: conversations = [] } = useConversations();
  const { data: agents = [] } = useAllAgents();
  const { conversationId } = useParams();
  const liveRuns = useLive((s) => s.runs);
  const runningConversations = new Set(Object.values(liveRuns).map((r) => r.conversationId));

  const items = [...conversations]
    .filter((c) => !c.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt))
    .slice(0, 30);

  if (items.length === 0) return null;

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
                  className="h-auto py-1.5 data-[active=true]:bg-card data-[active=true]:shadow-card data-[active=true]:ring-1 data-[active=true]:ring-border"
                >
                  <Link to={`/chat/${c.id}`} className="flex items-start gap-2">
                    <span className="mt-0.5 text-sm leading-none">{agent?.avatar ?? "💬"}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1">
                        <span className="truncate text-[13px]">{c.title || "New chat"}</span>
                        {c.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {running ? (
                          <span className="text-shimmer font-medium">Working…</span>
                        ) : (
                          <>
                            {agent?.name ?? "Agent"} · {formatDistanceToNowStrict(new Date(c.lastMessageAt ?? c.createdAt), { addSuffix: false })}
                          </>
                        )}
                      </span>
                    </span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
