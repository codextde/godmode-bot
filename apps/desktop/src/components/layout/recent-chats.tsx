import { Link, useLocation, useMatch, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { differenceInCalendarDays, formatDistanceToNowStrict } from "date-fns";
import type { Agent, Conversation } from "@godmode/shared";
import { Fragment, useEffect, useState } from "react";
import { AlarmClock, Archive, Bot, CheckCheck, ChevronDown, CircleCheck, MessagesSquare, Pin, Trash2, Workflow, Zap } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LiveDot } from "@/components/aicss/Motion";
import { NavSectionHeader } from "@/components/layout/nav-section-header";
import { AgentAvatar } from "@/components/common";
import { useArchiveChat, useDeleteChat } from "@/components/chat/chat-actions";
import { chatStatus } from "@/components/chat/chat-status";
import { AnimatedTitle } from "@/components/chat/animated-title";
import { api } from "@/lib/api";
import { chatProject, useAllAgents, useScopeProject, useScopeWorkspace, useScopedConversations, useWorkspaces } from "@/lib/hooks";
import { useProjectIndex } from "@/components/projects/project-utils";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useLive } from "@/stores/live";
import { type RecentSource, type RecentTab, useUi } from "@/stores/ui";

const PAGE = 25;

/** "Today", "Yesterday", "Previous 7 days", "Previous 30 days", then the month. */
function dayLabel(iso: string): string {
  const date = new Date(iso);
  const days = differenceInCalendarDays(new Date(), date);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return date.toLocaleDateString(undefined, { month: "long", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

const ROW_ACTION =
  "top-1/2! size-6 -translate-y-1/2 text-muted-foreground after:inset-x-0 hover:bg-background hover:text-foreground hover:shadow-card [&>svg]:size-3.5";

export function RecentChats() {
  const scope = useUi((s) => s.workspace);
  const scopeWorkspace = useScopeWorkspace();
  const scopeProject = useScopeProject();
  const projectIndex = useProjectIndex();
  const scopeName = scope === "all" ? null : scope === "global" ? "Global" : (scopeProject?.name ?? scopeWorkspace?.name ?? null);
  const { data: conversations = [] } = useScopedConversations();
  const { data: hasArchived = false } = useQuery({
    queryKey: [...qk.conversationsAll, "has-archived", scope],
    queryFn: async () => (await api.conversations.list({ archived: true, limit: 1, workspaceId: scope })).length > 0,
  });
  // Archived chats that still work, wait or come back on their own.
  const { data: archivedOngoing = 0 } = useQuery({
    queryKey: [...qk.conversationsAll, "archived-ongoing", scope],
    queryFn: async () => (await api.conversations.list({ archived: true, ongoing: true, limit: 100, workspaceId: scope })).length,
    enabled: hasArchived,
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
  const recentSource = useUi((s) => s.recentSource);
  const setRecentSource = useUi((s) => s.setRecentSource);
  const open = useUi((s) => !s.collapsedNav.includes("recent"));
  const toggleOpen = useUi((s) => s.toggleNavCollapsed);
  const foldedGroups = useUi((s) => s.collapsedNav);

  const unarchived = conversations.filter((c) => !c.archived);
  const sources = sourceStats(unarchived);
  const visible = unarchived.filter((c) => recentSource === "all" || chatSource(c) === recentSource);
  const bucketOf = (c: Conversation) => chatBucket(c, runningConversations.has(c.id) || queuedConversations.has(c.id));
  const counts = { all: visible.length, running: 0, scheduled: 0, done: 0 };
  let needsYou = 0;
  for (const c of visible) {
    counts[bucketOf(c)]++;
    if (c.paused?.reason === "question") needsYou++;
  }
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [recentTab, recentSource, scope]);
  const grouped = recentTab === "all";
  const rank = (c: Conversation) => (grouped ? BUCKET_RANK[bucketOf(c)] : 0);
  const matching = visible
    .filter((c) => recentTab === "all" || bucketOf(c) === recentTab)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (recentTab === "scheduled" || (grouped && bucketOf(a) === "scheduled")
          ? continuesAt(a).localeCompare(continuesAt(b))
          : Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt)),
    );
  const dayOf = (c: Conversation) => (c.pinned ? "Pinned" : dayLabel(c.lastMessageAt ?? c.createdAt));
  const groupOf = (c: Conversation): string | null => {
    if (grouped) {
      const bucket = bucketOf(c);
      if (bucket === "running") return "Running";
      if (bucket === "scheduled") return "Scheduled";
      return dayOf(c);
    }
    return recentTab === "done" ? dayOf(c) : null;
  };
  const groupSize = new Map<string, number>();
  for (const c of matching) {
    const g = groupOf(c);
    if (g) groupSize.set(g, (groupSize.get(g) ?? 0) + 1);
  }
  type Row = { c: Conversation; heading: string | null; folded: boolean };
  const rows: Row[] = [];
  let more = 0;
  let shown = 0;
  let previous: string | null | undefined;
  for (const c of matching) {
    const group = groupOf(c);
    const starts = group !== previous;
    previous = group;
    const folded = !!group && foldedGroups.includes(`recent:${group}`);
    if (folded) {
      if (starts) rows.push({ c, heading: group, folded });
      continue;
    }
    if (shown >= limit) {
      more++;
      continue;
    }
    shown++;
    rows.push({ c, heading: starts ? group : null, folded });
  }
  const unreadIds = visible.flatMap((c) => (c.unread ? [c.id] : []));
  const markAllRead = unreadIds.length
    ? () => void api.conversations.read(scope === "all" ? "all" : unreadIds).catch(() => undefined)
    : undefined;

  if (unarchived.length === 0 && !hasArchived && !scopeName) return deleteDialog;

  return (
    <SidebarGroup className="pt-0 group-data-[collapsible=icon]:hidden">
      <div className="sticky top-0 z-10 -mx-2 flex items-center justify-between gap-2 bg-sidebar px-2">
        <NavSectionHeader label="Recent" open={open} controls="recent-chats-panel" onToggle={() => toggleOpen("recent")} />
        {open ? (
          <RecentFilter
            tab={recentTab}
            onTab={setRecentTab}
            source={recentSource}
            onSource={setRecentSource}
            counts={counts}
            needsYou={needsYou}
            stats={sources}
            onMarkAllRead={markAllRead}
          />
        ) : (
          (counts.running > 0 || needsYou > 0) && (
            <span className="mr-2 flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
              {needsYou > 0 && (
                <span className="flex items-center gap-1 text-warning">
                  <span className="size-1.5 rounded-full bg-current" aria-hidden />
                  {needsYou} needs you
                </span>
              )}
              {counts.running > 0 && (
                <span className="flex items-center gap-1 text-brand-strong">
                  <span className="size-1.5 rounded-full bg-current" aria-hidden />
                  {counts.running} running
                </span>
              )}
            </span>
          )
        )}
      </div>
      {open && (
        <SidebarGroupContent id="recent-chats-panel">
          <SidebarMenu className="gap-0.5">
            {matching.length === 0 && <EmptyTab tab={recentTab} source={recentSource} scopeName={scopeName} hasArchived={hasArchived} />}
            {rows.map(({ c, heading, folded }, i) => {
              const headingNode = heading && (
                <GroupHeading
                  label={heading}
                  first={i === 0}
                  live={heading === "Running"}
                  folded={folded}
                  count={groupSize.get(heading) ?? 0}
                  onToggle={() => toggleOpen(`recent:${heading}`)}
                />
              );
              if (folded) return <Fragment key={`group-${heading}`}>{headingNode}</Fragment>;
              const agent = agents.find((a) => a.id === c.agentId);
              const workspaceId = c.workspaceId ?? agent?.workspaceId;
              const workspace = scope === "all" && workspaceId ? workspaces.find((w) => w.id === workspaceId) : undefined;
              const projectId = !workspace && !scopeProject ? chatProject(c, agents) : null;
              const project = projectId ? projectIndex.get(projectId)?.project : undefined;
              const running = runningConversations.has(c.id) || (c.running && !queuedConversations.has(c.id));
              const queued = !running && queuedConversations.has(c.id);
              const detail = running && !c.paused ? null : chatStatus(c, { running, queued });
              const unread = c.unread && conversationId !== c.id;
              const when = c.lastMessageAt ?? c.createdAt;
              const hover = [
                originLine(c, agents) ?? agent?.name ?? "Agent",
                workspace?.name ?? project?.name,
                formatDistanceToNowStrict(new Date(when), { addSuffix: true }),
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <Fragment key={c.id}>
                  {headingNode}
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={conversationId === c.id}
                      className="h-auto min-h-9 py-2 group-focus-within/menu-item:pr-15! group-hover/menu-item:pr-15! group-has-data-[sidebar=menu-action]/menu-item:pr-2 max-md:pr-15! data-[active=true]:bg-card data-[active=true]:shadow-card data-[active=true]:ring-1 data-[active=true]:ring-border"
                    >
                      <Link to={`/chat/${c.id}`} title={hover} className="flex items-start gap-2">
                        <AgentAvatar agent={agent ?? { id: c.agentId, color: "violet" }} size="sm" still className="-my-0.5 size-5" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className={cn("min-w-0 flex-1 truncate text-[13px]", unread && "font-semibold text-foreground")}>
                              <AnimatedTitle text={c.title || "New chat"} />
                            </span>
                            {c.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
                            <span className="flex shrink-0 items-center gap-1.5 group-focus-within/menu-item:hidden group-hover/menu-item:hidden max-md:hidden">
                              {unread ? (
                                <span
                                  className={cn("size-1.5 rounded-full", c.unread!.failed ? "bg-destructive" : "bg-brand-strong")}
                                  role="img"
                                  aria-label={c.unread!.failed ? "Something went wrong here" : "New reply"}
                                />
                              ) : null}
                              {running && !c.paused ? (
                                <LiveDot className="bg-brand-strong" />
                              ) : (
                                <span className="text-[11px] text-muted-foreground/80 tabular-nums">{shortAgo(when)}</span>
                              )}
                            </span>
                          </span>
                          {detail && <span className="mt-0.5 flex min-w-0 items-center text-[11px] text-muted-foreground [&>span]:truncate">{detail}</span>}
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
                </Fragment>
              );
            })}
            {more > 0 && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  onClick={() => setLimit((n) => n + PAGE)}
                  className="mt-1 gap-2 text-[12.5px] text-muted-foreground [&>svg]:size-3.5"
                >
                  <ChevronDown />
                  <span>
                    Show {Math.min(more, PAGE)} more
                    <span className="ml-1 text-muted-foreground/60">of {more}</span>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
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
                    {archivedOngoing > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="ml-auto flex h-4 items-center gap-1 rounded-full bg-foreground/6 px-1.5 text-[10px] leading-none tabular-nums">
                            <AlarmClock className="size-2.5 text-brand-strong" aria-hidden />
                            {archivedOngoing}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {archivedOngoing === 1 ? "1 archived chat still has" : `${archivedOngoing} archived chats still have`} work ahead
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroupContent>
      )}
      {deleteDialog}
    </SidebarGroup>
  );
}

function GroupHeading({
  label,
  first,
  live,
  folded,
  count,
  onToggle,
}: {
  label: string;
  first: boolean;
  live: boolean;
  folded: boolean;
  count: number;
  onToggle: () => void;
}) {
  return (
    <li role="presentation" className={cn("px-0.5", first ? "pt-0.5" : "pt-2")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!folded}
        className="group/heading flex h-5 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[10.5px] font-medium text-muted-foreground/80 outline-none transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        {live && <LiveDot className="size-1.5 bg-brand-strong" />}
        {label}
        {folded && <span className="font-normal text-muted-foreground/60 tabular-nums">{count}</span>}
        <ChevronDown
          className={cn(
            "size-3 transition",
            folded ? "-rotate-90" : "opacity-0 group-hover/heading:opacity-100 group-focus-visible/heading:opacity-100",
          )}
        />
      </button>
    </li>
  );
}

function shortAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`;
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: date.getFullYear() === new Date().getFullYear() ? undefined : "2-digit" });
}

/** Where a chat came from when it wasn't the human's own: "From Lena" (handed over), "Automation". */
function originLine(c: Conversation, agents: Agent[]): string | null {
  if (c.origin === "delegation") {
    const from = c.delegatedFrom ? agents.find((a) => a.id === c.delegatedFrom!.agentId) : undefined;
    return from ? `From ${from.name}` : "Handed over";
  }
  if (c.origin === "routine") return "Automation";
  if (c.origin === "heartbeat") return "Heartbeat";
  return null;
}

type ChatSource = Exclude<RecentSource, "all">;

/** Mine: chats the human started, here or from Slack, Telegram or Teams. Automations: started by a trigger. Agents: an agent started it itself. */
function chatSource(c: Conversation): ChatSource {
  switch (c.origin) {
    case "routine":
    case "api":
      return "automations";
    case "delegation":
    case "task":
    case "heartbeat":
    case "dream":
      return "agents";
    default:
      return "mine";
  }
}

type SourceStat = { unread: number; needsYou: number };

function sourceStats(chats: Conversation[]): Record<RecentSource, SourceStat> {
  const stats = Object.fromEntries(SOURCES.map((s) => [s.value, { unread: 0, needsYou: 0 }])) as Record<RecentSource, SourceStat>;
  for (const c of chats) {
    for (const key of [chatSource(c), "all"] as const) {
      if (c.unread) stats[key].unread++;
      if (c.paused?.reason === "question") stats[key].needsYou++;
    }
  }
  return stats;
}

const SOURCES: { value: RecentSource; label: string; hint: string }[] = [
  { value: "mine", label: "Mine", hint: "Chats you started" },
  { value: "automations", label: "Automations", hint: "Started by an automation or the API" },
  { value: "agents", label: "Agents", hint: "Started by an agent: handovers, board tasks, heartbeats" },
  { value: "all", label: "All", hint: "Every chat" },
];

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

const BUCKET_RANK: Record<ChatBucket, number> = { running: 0, scheduled: 1, done: 2 };

function RecentFilter({
  tab,
  onTab,
  source,
  onSource,
  counts,
  needsYou,
  stats,
  onMarkAllRead,
}: {
  tab: RecentTab;
  onTab: (tab: RecentTab) => void;
  source: RecentSource;
  onSource: (source: RecentSource) => void;
  counts: Record<RecentTab, number>;
  needsYou: number;
  stats: Record<RecentSource, SourceStat>;
  onMarkAllRead?: () => void;
}) {
  const sourceLabel = SOURCES.find((s) => s.value === source)?.label ?? "All";
  const tabLabel = tab === "all" ? null : TABS.find((t) => t.value === tab)?.label;
  const elsewhere = SOURCES.some((s) => s.value !== source && s.value !== "all" && (stats[s.value].needsYou > 0 || stats[s.value].unread > 0));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Filter chats: ${sourceLabel}${tabLabel ? `, ${tabLabel}` : ""}`}
          className="mr-1 flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-muted-foreground outline-none transition hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground"
        >
          {elsewhere && <span className="size-1.5 shrink-0 rounded-full bg-brand-strong" aria-hidden />}
          <span className="truncate">
            {sourceLabel}
            {tabLabel && <span className="text-foreground"> · {tabLabel}</span>}
          </span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">Started by</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={source} onValueChange={(v) => onSource(v as RecentSource)}>
          {SOURCES.map((s) => {
            const { unread, needsYou: waiting } = stats[s.value];
            return (
              <DropdownMenuRadioItem key={s.value} value={s.value} className="flex-col items-start gap-0">
                <span className="flex w-full items-center gap-1.5">
                  {s.label}
                  {s.value !== "all" && (waiting > 0 || unread > 0) && (
                    <span className={cn("size-1.5 rounded-full", waiting > 0 ? "bg-warning" : "bg-brand-strong")} aria-label={waiting > 0 ? "Waiting for you" : "New replies"} />
                  )}
                </span>
                <span className="text-[11px] text-muted-foreground">{s.hint}</span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">Status</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={tab} onValueChange={(v) => onTab(v as RecentTab)}>
          {TABS.map((t) => {
            const count = t.value === "running" || t.value === "scheduled" ? counts[t.value] : 0;
            const urgent = t.value === "running" && needsYou > 0;
            return (
              <DropdownMenuRadioItem key={t.value} value={t.value}>
                {t.label}
                {count > 0 && (
                  <span className={cn("ml-auto text-[11px] tabular-nums", urgent ? "text-warning" : "text-muted-foreground")}>
                    {urgent ? `${needsYou} need${needsYou === 1 ? "s" : ""} you` : count}
                  </span>
                )}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        {onMarkAllRead && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onMarkAllRead}>
              <CheckCheck />
              Mark all read
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const EMPTY: Record<RecentTab, { icon: typeof Zap; title: string; text: string }> = {
  all: { icon: MessagesSquare, title: "No chats yet", text: "Your archived chats are below." },
  running: { icon: Zap, title: "Nothing running", text: "Chats that work or wait for you show up here." },
  scheduled: { icon: AlarmClock, title: "Nothing scheduled", text: "When an agent plans to check back later, the chat waits here." },
  done: { icon: CircleCheck, title: "Nothing finished yet", text: "Finished chats land here." },
};

const EMPTY_SOURCE: Record<Exclude<RecentSource, "all">, { icon: typeof Zap; title: string; text: string }> = {
  mine: { icon: MessagesSquare, title: "No chats from you yet", text: "Chats you start show up here. Automations and agents have their own tabs." },
  automations: { icon: Workflow, title: "No automation chats", text: "When an automation runs, its chat lands here." },
  agents: { icon: Bot, title: "No agent chats", text: "Handovers, board tasks and heartbeats agents start themselves land here." },
};

function EmptyTab({ tab, source, scopeName, hasArchived }: { tab: RecentTab; source: RecentSource; scopeName: string | null; hasArchived: boolean }) {
  const { icon: Icon, title, text } =
    tab === "all" && source !== "all"
      ? EMPTY_SOURCE[source]
      : tab === "all" && scopeName
        ? { ...EMPTY.all, title: `No chats in ${scopeName} yet`, text: hasArchived ? "Its archived chats are below." : "New chats you start here land in this list." }
        : EMPTY[tab];
  return (
    <li className="flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-5 text-center">
      <Icon className="mb-0.5 size-4 text-muted-foreground/70" aria-hidden />
      <span className="text-[12.5px] font-medium">{title}</span>
      <span className="text-[11.5px] leading-snug text-muted-foreground">{text}</span>
    </li>
  );
}
