import { Link, useLocation, useMatch, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { differenceInCalendarDays, formatDistanceToNowStrict } from "date-fns";
import type { Agent, Conversation, Workspace } from "@godmode/shared";
import { Fragment, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AlarmClock, Archive, Bot, CheckCheck, ChevronDown, CircleCheck, CircleDot, MessagesSquare, Pin, PinOff, Trash2, Workflow, Zap } from "lucide-react";
import { toast } from "sonner";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
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
import { AgentAvatar, colorGradient } from "@/components/common";
import { useArchiveChat, useDeleteChat } from "@/components/chat/chat-actions";
import { chatStatus } from "@/components/chat/chat-status";
import { AnimatedTitle } from "@/components/chat/animated-title";
import { api, errorMessage } from "@/lib/api";
import { chatProject, useAllAgents, useScopeProject, useScopeWorkspace, useScopedConversations, useWorkspaces } from "@/lib/hooks";
import { useProjectIndex } from "@/components/projects/project-utils";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { isMac, modKey } from "@/lib/desktop";
import { useLive } from "@/stores/live";
import { type RecentSource, type RecentTab, useUi } from "@/stores/ui";
import { dateLocale, intlLocale, t as translate } from "@/i18n";

const PAGE = 25;

/** "Today", "Yesterday", "Previous 7 days", "Previous 30 days", then the month. */
function dayLabel(iso: string): string {
  const date = new Date(iso);
  const days = differenceInCalendarDays(new Date(), date);
  if (days <= 0) return translate("common:words.today");
  if (days === 1) return translate("common:words.yesterday");
  if (days < 7) return translate("layout:recent.previous7");
  if (days < 30) return translate("layout:recent.previous30");
  return date.toLocaleDateString(intlLocale(), { month: "long", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

const ROW_ACTION =
  "top-1/2! size-6 -translate-y-1/2 text-muted-foreground after:inset-x-0 hover:bg-background hover:text-foreground hover:shadow-card [&>svg]:size-3.5";

export function RecentChats() {
  const { t } = useTranslation(["layout", "common"]);
  const scope = useUi((s) => s.workspace);
  const scopeWorkspace = useScopeWorkspace();
  const scopeProject = useScopeProject();
  const projectIndex = useProjectIndex();
  const scopeName = scope === "all" ? null : scope === "global" ? t("scope.global") : (scopeProject?.name ?? scopeWorkspace?.name ?? null);
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
  const markUnread = useMarkUnread();
  const qc = useQueryClient();
  const setPinned = (c: Conversation, pinned: boolean) =>
    void api.conversations
      .update(c.id, { pinned })
      .then(() => qc.invalidateQueries({ queryKey: qk.conversationsAll }))
      .catch((err) => toast.error(t("recent.menu.failed"), { description: errorMessage(err) }));

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
  const dayOf = (c: Conversation) => (c.pinned ? t("recent.pinned") : dayLabel(c.lastMessageAt ?? c.createdAt));
  const runningLabel = t("recent.tabs.running.label");
  const groupOf = (c: Conversation): string | null => {
    if (grouped) {
      const bucket = bucketOf(c);
      if (bucket === "running") return runningLabel;
      if (bucket === "scheduled") return t("recent.tabs.scheduled.label");
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
  const slots = rows.flatMap((r) => (r.folded ? [] : [r.c.id])).slice(0, 9);
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const holding = useModifierHeld();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey || !/^Digit[1-9]$/.test(e.code)) return;
      if ((e.target as HTMLElement | null)?.closest?.("[role=application],[role=dialog],[role=alertdialog]")) return;
      const id = slotsRef.current[Number(e.code.slice(5)) - 1];
      if (!id) return;
      e.preventDefault();
      navigate(`/chat/${id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
  const unreadIds = visible.flatMap((c) => (c.unread ? [c.id] : []));
  const markAllRead = unreadIds.length
    ? () => void api.conversations.read(scope === "all" ? "all" : unreadIds).catch(() => undefined)
    : undefined;

  if (unarchived.length === 0 && !hasArchived && !scopeName) return deleteDialog;

  return (
    <SidebarGroup className="pt-0 group-data-[collapsible=icon]:hidden">
      <div className="sticky top-0 z-10 -mx-2 flex items-center justify-between gap-2 bg-sidebar px-2">
        <NavSectionHeader label={t("recent.title")} open={open} controls="recent-chats-panel" onToggle={() => toggleOpen("recent")} />
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
                  {t("counts.needsYou", { count: needsYou })}
                </span>
              )}
              {counts.running > 0 && (
                <span className="flex items-center gap-1 text-brand-strong">
                  <span className="size-1.5 rounded-full bg-current" aria-hidden />
                  {t("recent.running", { count: counts.running })}
                </span>
              )}
            </span>
          )
        )}
      </div>
      {open && (
        <SidebarGroupContent id="recent-chats-panel">
          <SidebarMenu>
            {matching.length === 0 && <EmptyTab tab={recentTab} source={recentSource} scopeName={scopeName} hasArchived={hasArchived} />}
            {rows.map(({ c, heading, folded }, i) => {
              const headingNode = heading && (
                <GroupHeading
                  label={heading}
                  first={i === 0}
                  live={heading === runningLabel}
                  folded={folded}
                  count={groupSize.get(heading) ?? 0}
                  onToggle={() => toggleOpen(`recent:${heading}`)}
                />
              );
              if (folded) return <Fragment key={`group-${heading}`}>{headingNode}</Fragment>;
              const slot = holding ? slots.indexOf(c.id) : -1;
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
                originLine(c, agents) ?? agent?.name ?? t("common:words.agent"),
                workspace?.name ?? project?.name,
                formatDistanceToNowStrict(new Date(when), { addSuffix: true, locale: dateLocale() }),
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <Fragment key={c.id}>
                  {headingNode}
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          asChild
                          isActive={conversationId === c.id}
                          className="h-auto py-1.5 group-focus-within/menu-item:pr-15! group-hover/menu-item:pr-15! group-has-data-[sidebar=menu-action]/menu-item:pr-2 max-md:pr-15! data-[active=true]:bg-card data-[active=true]:shadow-card data-[active=true]:ring-1 data-[active=true]:ring-border"
                        >
                          <Link to={`/chat/${c.id}`} title={hover} className="flex items-start gap-2">
                            <AgentAvatar agent={agent ?? { id: c.agentId, color: "violet" }} size="sm" still className="-mt-0.5 size-5" />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1">
                                <span className={cn("min-w-0 flex-1 truncate text-[13px]", unread && "font-semibold text-foreground")}>
                                  <AnimatedTitle text={c.title || t("shell.newChat")} />
                                </span>
                                {unread ? (
                                  <span
                                    className={cn("size-1.5 shrink-0 rounded-full", c.unread!.failed ? "bg-destructive" : "bg-brand-strong")}
                                    role="img"
                                    aria-label={c.unread!.failed ? t("recent.failedHere") : t("recent.newReply")}
                                  />
                                ) : null}
                                {c.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
                                {slot >= 0 ? (
                                  <kbd className="ml-0.5 shrink-0 rounded-[4px] bg-foreground/8 px-1 font-mono text-[10px] leading-4 text-foreground/80 tabular-nums">
                                    {modKey}
                                    {slot + 1}
                                  </kbd>
                                ) : (
                                  running &&
                                  !c.paused && <LiveDot className="ml-0.5 shrink-0 bg-brand-strong group-focus-within/menu-item:hidden group-hover/menu-item:hidden" />
                                )}
                              </span>
                              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                                {workspace && <WorkspaceChip workspace={workspace} />}
                                {project && <WorkspaceChip workspace={project} kind="project" />}
                                <span className="block min-w-0 flex-1 truncate">
                                  {detail ?? (
                                    <>
                                      {originLine(c, agents) ?? agent?.name ?? t("common:words.agent")} · {formatDistanceToNowStrict(new Date(when), { addSuffix: false, locale: dateLocale() })}
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
                              aria-label={t("recent.archiveLabel", { title: c.title || t("shell.newChat") })}
                              onClick={() => setArchived(c, true)}
                              className={cn(ROW_ACTION, "right-7.5")}
                            >
                              <Archive />
                            </SidebarMenuAction>
                          </TooltipTrigger>
                          <TooltipContent side="top">{t("recent.archive")}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <SidebarMenuAction
                              showOnHover
                              aria-label={t("recent.deleteLabel", { title: c.title || t("shell.newChat") })}
                              onClick={() => askDelete(c)}
                              className={cn(ROW_ACTION, "hover:text-destructive")}
                            >
                              <Trash2 />
                            </SidebarMenuAction>
                          </TooltipTrigger>
                          <TooltipContent side="top">{t("common:actions.delete")}</TooltipContent>
                        </Tooltip>
                      </SidebarMenuItem>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-48">
                      {unread ? (
                        <ContextMenuItem onSelect={() => markUnread(c, false)}>
                          <CheckCheck />
                          {t("recent.menu.markRead")}
                        </ContextMenuItem>
                      ) : (
                        <ContextMenuItem onSelect={() => markUnread(c, true, conversationId === c.id ? () => navigate("/") : undefined)}>
                          <CircleDot />
                          {t("recent.menu.markUnread")}
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem onSelect={() => setPinned(c, !c.pinned)}>
                        {c.pinned ? <PinOff /> : <Pin />}
                        {c.pinned ? t("recent.menu.unpin") : t("recent.menu.pin")}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => setArchived(c, true)}>
                        <Archive />
                        {t("recent.archive")}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem variant="destructive" onSelect={() => askDelete(c)}>
                        <Trash2 />
                        {t("common:actions.delete")}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
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
                    <Trans t={t} i18nKey="recent.showMore" values={{ count: Math.min(more, PAGE), total: more }} components={{ muted: <span className="ml-1 text-muted-foreground/60" /> }} />
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
                    <span>{t("nav.archivedChats")}</span>
                    {archivedOngoing > 0 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="ml-auto flex h-4 items-center gap-1 rounded-full bg-foreground/6 px-1.5 text-[10px] leading-none tabular-nums">
                            <AlarmClock className="size-2.5 text-brand-strong" aria-hidden />
                            {archivedOngoing}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {t("recent.archivedOngoing", { count: archivedOngoing })}
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

/**
 * Mark a chat read or unread from its menu: the dot changes right away. Marking the open chat unread leaves it
 * (`leave`), so it doesn't count as read again while it is on screen.
 */
function useMarkUnread() {
  const { t } = useTranslation("layout");
  const qc = useQueryClient();
  return (c: Conversation, unread: boolean, leave?: () => void) => {
    leave?.();
    qc.setQueriesData<Conversation[]>({ queryKey: qk.conversationLists }, (list) =>
      list?.map((x) => (x.id === c.id ? { ...x, unread: unread ? (x.unread ?? { runId: "", failed: false }) : null } : x)),
    );
    void (unread ? api.conversations.unread([c.id]) : api.conversations.read([c.id]))
      .catch((err) => toast.error(t("recent.menu.failed"), { description: errorMessage(err) }))
      .finally(() => qc.invalidateQueries({ queryKey: qk.conversationsAll }));
  };
}

function useModifierHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const key = isMac ? "Meta" : "Control";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reset = () => {
      clearTimeout(timer);
      setHeld(false);
    };
    const down = (e: KeyboardEvent) => {
      if (e.key === key) {
        if (e.repeat) return;
        clearTimeout(timer);
        timer = setTimeout(() => setHeld(true), 300);
      } else if (!/^Digit[1-9]$/.test(e.code)) reset();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === key || !(isMac ? e.metaKey : e.ctrlKey)) reset();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", reset);
    return () => {
      reset();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", reset);
    };
  }, []);
  return held;
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

/** Where a chat came from when it wasn't the human's own: "From Lena" (handed over), "Automation". */
function originLine(c: Conversation, agents: Agent[]): string | null {
  if (c.origin === "delegation") {
    const from = c.delegatedFrom ? agents.find((a) => a.id === c.delegatedFrom!.agentId) : undefined;
    return from ? translate("layout:recent.origin.from", { name: from.name }) : translate("layout:recent.origin.handedOver");
  }
  if (c.origin === "routine") return translate("layout:recent.origin.automation");
  if (c.origin === "heartbeat") return translate("layout:recent.origin.heartbeat");
  return null;
}

/** Which workspace a chat belongs to, in the workspace's colour. Global chats go without. */
function WorkspaceChip({ workspace, kind = "workspace" }: { workspace: Pick<Workspace, "name" | "icon" | "color">; kind?: "workspace" | "project" }) {
  const { t } = useTranslation("layout");
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(workspace.color);
  return (
    <span
      title={t(`recent.chip.${kind}`, { name: workspace.name })}
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

const SOURCES = [{ value: "mine" }, { value: "automations" }, { value: "agents" }, { value: "all" }] as const satisfies readonly { value: RecentSource }[];

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

const TABS = [{ value: "all" }, { value: "running" }, { value: "scheduled" }, { value: "done" }] as const satisfies readonly { value: RecentTab }[];

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
  const { t } = useTranslation("layout");
  const sourceLabel = t(`recent.sources.${source}.label`);
  const tabLabel = tab === "all" ? null : t(`recent.tabs.${tab}.label`);
  const elsewhere = SOURCES.some((s) => s.value !== source && s.value !== "all" && (stats[s.value].needsYou > 0 || stats[s.value].unread > 0));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={tabLabel ? t("recent.filterLabelTab", { source: sourceLabel, tab: tabLabel }) : t("recent.filterLabel", { source: sourceLabel })}
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
        <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">{t("recent.startedBy")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={source} onValueChange={(v) => onSource(v as RecentSource)}>
          {SOURCES.map((s) => {
            const { unread, needsYou: waiting } = stats[s.value];
            return (
              <DropdownMenuRadioItem key={s.value} value={s.value} className="flex-col items-start gap-0">
                <span className="flex w-full items-center gap-1.5">
                  {t(`recent.sources.${s.value}.label`)}
                  {s.value !== "all" && (waiting > 0 || unread > 0) && (
                    <span className={cn("size-1.5 rounded-full", waiting > 0 ? "bg-warning" : "bg-brand-strong")} aria-label={waiting > 0 ? t("recent.waitingForYou") : t("recent.newReplies")} />
                  )}
                </span>
                <span className="text-[11px] text-muted-foreground">{t(`recent.sources.${s.value}.hint`)}</span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">{t("recent.status")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={tab} onValueChange={(v) => onTab(v as RecentTab)}>
          {TABS.map((item) => {
            const count = item.value === "running" || item.value === "scheduled" ? counts[item.value] : 0;
            const urgent = item.value === "running" && needsYou > 0;
            return (
              <DropdownMenuRadioItem key={item.value} value={item.value}>
                {t(`recent.tabs.${item.value}.label`)}
                {count > 0 && (
                  <span className={cn("ml-auto text-[11px] tabular-nums", urgent ? "text-warning" : "text-muted-foreground")}>
                    {urgent ? t("counts.needsYou", { count: needsYou }) : count}
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
              {t("recent.markAllRead")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const EMPTY: Record<RecentTab, typeof Zap> = { all: MessagesSquare, running: Zap, scheduled: AlarmClock, done: CircleCheck };

const EMPTY_SOURCE: Record<Exclude<RecentSource, "all">, typeof Zap> = { mine: MessagesSquare, automations: Workflow, agents: Bot };

function EmptyTab({ tab, source, scopeName, hasArchived }: { tab: RecentTab; source: RecentSource; scopeName: string | null; hasArchived: boolean }) {
  const { t } = useTranslation("layout");
  const { icon: Icon, title, text } =
    tab === "all" && source !== "all"
      ? { icon: EMPTY_SOURCE[source], title: t(`recent.emptySource.${source}.title`), text: t(`recent.emptySource.${source}.text`) }
      : tab === "all" && scopeName
        ? { icon: EMPTY.all, title: t("recent.emptyScope.title", { name: scopeName }), text: hasArchived ? t("recent.emptyScope.archived") : t("recent.emptyScope.new") }
        : { icon: EMPTY[tab], title: t(`recent.empty.${tab}.title`), text: t(`recent.empty.${tab}.text`) };
  return (
    <li className="flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-5 text-center">
      <Icon className="mb-0.5 size-4 text-muted-foreground/70" aria-hidden />
      <span className="text-[12.5px] font-medium">{title}</span>
      <span className="text-[11.5px] leading-snug text-muted-foreground">{text}</span>
    </li>
  );
}
