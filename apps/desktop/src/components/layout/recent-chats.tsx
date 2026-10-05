import { Link, useLocation, useMatch, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import type { Agent, Conversation, Workspace } from "@godmode/shared";
import { type KeyboardEvent, useRef } from "react";
import { motion } from "motion/react";
import { AlarmClock, Archive, CircleCheck, Hourglass, MessageCircleQuestion, MessagesSquare, Pause, Pin, Trash2, Zap } from "lucide-react";
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
import { AgentAvatar, colorGradient } from "@/components/common";
import { useArchiveChat, useDeleteChat } from "@/components/chat/chat-actions";
import { followupWhen } from "@/components/chat/followup";
import { api } from "@/lib/api";
import { useAllAgents, useConversations, useWorkspaces } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useLive } from "@/stores/live";
import { type RecentTab, useUi } from "@/stores/ui";

const ROW_ACTION =
  "top-1/2! size-6 -translate-y-1/2 text-muted-foreground after:inset-x-0 hover:bg-background hover:text-foreground hover:shadow-card [&>svg]:size-3.5";

export function RecentChats() {
  const { data: conversations = [] } = useConversations();
  const { data: hasArchived = false } = useQuery({
    queryKey: [...qk.conversationsAll, "has-archived"],
    queryFn: async () => (await api.conversations.list({ archived: true, limit: 1 })).length > 0,
  });
  const { data: agents = [] } = useAllAgents();
  const { data: workspaces = [] } = useWorkspaces();
  const conversationId = useMatch("/chat/:conversationId")?.params.conversationId;
  const { pathname } = useLocation();
  const liveRuns = useLive((s) => s.runs);
  const runningConversations = new Set(Object.values(liveRuns).flatMap((r) => (r.status === "running" ? [r.conversationId] : [])));
  const queuedConversations = new Set(Object.values(liveRuns).flatMap((r) => (r.status === "queued" ? [r.conversationId] : [])));
  const { setArchived } = useArchiveChat();
  const navigate = useNavigate();
  const { askDelete, deleteDialog } = useDeleteChat((id) => id === conversationId && navigate("/", { replace: true }));

  const recentTab = useUi((s) => s.recentTab);
  const setRecentTab = useUi((s) => s.setRecentTab);

  const visible = conversations.filter((c) => !c.archived);
  const bucketOf = (c: Conversation) => chatBucket(c, runningConversations.has(c.id) || queuedConversations.has(c.id));
  const counts = { all: visible.length, running: 0, scheduled: 0, done: 0 };
  let needsYou = 0;
  for (const c of visible) {
    counts[bucketOf(c)]++;
    if (c.paused?.reason === "question") needsYou++;
  }
  const items = visible
    .filter((c) => recentTab === "all" || bucketOf(c) === recentTab)
    .sort((a, b) =>
      recentTab === "scheduled"
        ? continuesAt(a).localeCompare(continuesAt(b))
        : Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt),
    )
    .slice(0, 30);

  if (visible.length === 0 && !hasArchived) return deleteDialog;

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel className="eyebrow text-[10.5px]">Recent</SidebarGroupLabel>
      {visible.some((c) => c.unread) && (
        <button
          type="button"
          onClick={() => void api.conversations.read("all").catch(() => undefined)}
          className="absolute top-3.5 right-3 text-[11px] text-muted-foreground transition hover:text-foreground"
        >
          Mark all read
        </button>
      )}
      <RecentTabs value={recentTab} onChange={setRecentTab} counts={counts} needsYou={needsYou} />
      <SidebarGroupContent id="recent-chats-panel" role="tabpanel" aria-labelledby={`recent-tab-${recentTab}`}>
        <SidebarMenu>
          {items.length === 0 && <EmptyTab tab={recentTab} />}
          {items.map((c) => {
            const agent = agents.find((a) => a.id === c.agentId);
            const workspaceId = c.workspaceId ?? agent?.workspaceId;
            const workspace = workspaceId ? workspaces.find((w) => w.id === workspaceId) : undefined;
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
                      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                        {workspace && <WorkspaceChip workspace={workspace} />}
                        <span className="block min-w-0 flex-1 truncate">
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

/** Which workspace a chat belongs to, in the workspace's colour. Global chats go without. */
function WorkspaceChip({ workspace }: { workspace: Workspace }) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(workspace.color);
  return (
    <span
      title={`Workspace: ${workspace.name}`}
      className={cn(
        "inline-flex h-4 max-w-22 shrink-0 items-center gap-1 rounded-[5px] px-1 text-[10px] font-medium text-foreground/75 ring-1 ring-inset",
        hex ? "ring-foreground/10" : colorGradient(workspace.color),
      )}
      style={hex ? { backgroundColor: `color-mix(in oklab, ${workspace.color} 14%, transparent)` } : undefined}
    >
      {workspace.icon && <span className="text-[9px] leading-none" aria-hidden>{workspace.icon}</span>}
      <span className="truncate">{workspace.name}</span>
    </span>
  );
}

type ChatBucket = Exclude<RecentTab, "all">;

/** Running: working, queued or standing still until someone acts. Scheduled: continues by itself later. Done: the rest. */
function chatBucket(c: Conversation, live: boolean): ChatBucket {
  if (c.paused) return c.paused.auto && c.paused.resumeAt ? "scheduled" : "running";
  if (live || c.running) return "running";
  return c.followup ? "scheduled" : "done";
}

function continuesAt(c: Conversation): string {
  return c.followup?.dueAt ?? c.paused?.resumeAt ?? "9999";
}

const TABS: { value: RecentTab; label: string; hint: string }[] = [
  { value: "all", label: "All", hint: "Every recent chat" },
  { value: "running", label: "Running", hint: "Working, queued or waiting for you" },
  { value: "scheduled", label: "Scheduled", hint: "Continue on their own later" },
  { value: "done", label: "Done", hint: "Finished chats" },
];

function RecentTabs({
  value,
  onChange,
  counts,
  needsYou,
}: {
  value: RecentTab;
  onChange: (tab: RecentTab) => void;
  counts: Record<RecentTab, number>;
  needsYou: number;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (TABS.findIndex((t) => t.value === value) + delta + TABS.length) % TABS.length;
    onChange(TABS[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div className="sticky top-0 z-10 -mx-2 bg-sidebar px-2 pt-1 pb-1.5">
      <div role="tablist" aria-label="Filter recent chats" onKeyDown={onKeyDown} className="flex gap-px rounded-lg border bg-secondary/70 p-0.5">
        {TABS.map((t, i) => {
          const active = t.value === value;
          const count = t.value === "running" || t.value === "scheduled" ? counts[t.value] : 0;
          const urgent = t.value === "running" && needsYou > 0;
          return (
            <Tooltip key={t.value}>
              <TooltipTrigger asChild>
                <button
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  id={`recent-tab-${t.value}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls="recent-chats-panel"
                  tabIndex={active ? 0 : -1}
                  onClick={() => onChange(t.value)}
                  className={cn(
                    "relative flex h-6.5 min-w-0 flex-auto items-center justify-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="recent-tab-pill"
                      className="absolute inset-0 rounded-md bg-card shadow-card ring-1 ring-border dark:bg-accent"
                      transition={{ type: "spring", stiffness: 460, damping: 36 }}
                    />
                  )}
                  <span className="relative truncate">{t.label}</span>
                  {count > 0 && (
                    <span
                      className={cn(
                        "relative flex h-3.5 min-w-3.5 items-center justify-center gap-0.5 rounded-full px-1 text-[10px] leading-none tabular-nums",
                        urgent
                          ? "bg-warning/15 text-warning"
                          : t.value === "running"
                            ? "bg-brand-strong/12 text-brand-strong"
                            : active
                              ? "bg-foreground/8 text-foreground"
                              : "bg-foreground/6 text-muted-foreground",
                      )}
                    >
                      {t.value === "running" && !urgent && <span className="size-1 animate-pulse rounded-full bg-current" aria-hidden />}
                      {count}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t.hint}
                {urgent && ` · ${needsYou} need${needsYou === 1 ? "s" : ""} you`}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

const EMPTY: Record<RecentTab, { icon: typeof Zap; title: string; text: string }> = {
  all: { icon: MessagesSquare, title: "No chats yet", text: "Your archived chats are below." },
  running: { icon: Zap, title: "Nothing running", text: "Chats that work or wait for you show up here." },
  scheduled: { icon: AlarmClock, title: "Nothing scheduled", text: "When an agent plans to check back later, the chat waits here." },
  done: { icon: CircleCheck, title: "Nothing finished yet", text: "Finished chats land here." },
};

function EmptyTab({ tab }: { tab: RecentTab }) {
  const { icon: Icon, title, text } = EMPTY[tab];
  return (
    <li className="flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-5 text-center">
      <Icon className="mb-0.5 size-4 text-muted-foreground/70" aria-hidden />
      <span className="text-[12.5px] font-medium">{title}</span>
      <span className="text-[11.5px] leading-snug text-muted-foreground">{text}</span>
    </li>
  );
}
