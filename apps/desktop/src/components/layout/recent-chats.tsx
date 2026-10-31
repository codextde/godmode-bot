import { Link, useLocation, useMatch, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { differenceInCalendarDays, formatDistanceToNowStrict } from "date-fns";
import type { Agent, Conversation, Workspace } from "@godmode/shared";
import { Fragment, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Trans, useTranslation } from "react-i18next";
import { AlarmClock, Archive, Bot, ChevronDown, CircleCheck, MessagesSquare, Pin, Trash2, Workflow, Zap } from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NavSectionHeader } from "@/components/layout/nav-section-header";
import { AgentAvatar, colorGradient } from "@/components/common";
import { useArchiveChat, useDeleteChat } from "@/components/chat/chat-actions";
import { chatStatus } from "@/components/chat/chat-status";
import { api } from "@/lib/api";
import { chatProject, useAllAgents, useScopeProject, useScopeWorkspace, useScopedConversations, useWorkspaces } from "@/lib/hooks";
import { useProjectIndex } from "@/components/projects/project-utils";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
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

  const recentTab = useUi((s) => s.recentTab);
  const setRecentTab = useUi((s) => s.setRecentTab);
  const recentSource = useUi((s) => s.recentSource);
  const setRecentSource = useUi((s) => s.setRecentSource);
  const open = useUi((s) => !s.collapsedNav.includes("recent"));
  const toggleOpen = useUi((s) => s.toggleNavCollapsed);

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
  const matching = visible
    .filter((c) => recentTab === "all" || bucketOf(c) === recentTab)
    .sort((a, b) =>
      recentTab === "scheduled"
        ? continuesAt(a).localeCompare(continuesAt(b))
        : Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt),
    );
  const items = matching.slice(0, limit);
  const more = matching.length - items.length;
  // Long lists read by day; the running and scheduled tabs are short and ordered by what comes next.
  const dated = recentTab === "all" || recentTab === "done";
  const dayOf = (c: Conversation) => (c.pinned ? t("recent.pinned") : dayLabel(c.lastMessageAt ?? c.createdAt));

  if (unarchived.length === 0 && !hasArchived && !scopeName) return deleteDialog;

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <div className="flex items-center justify-between gap-2">
        <NavSectionHeader label={t("recent.title")} open={open} controls="recent-chats-panel" onToggle={() => toggleOpen("recent")} quiet />
        {!open && (counts.running > 0 || needsYou > 0) && (
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
        )}
      </div>
      {open && visible.some((c) => c.unread) && (
        <button
          type="button"
          onClick={() =>
            void api.conversations.read(scope === "all" ? "all" : visible.flatMap((c) => (c.unread ? [c.id] : []))).catch(() => undefined)
          }
          className="absolute top-3.5 right-3 text-[11px] text-muted-foreground transition hover:text-foreground"
        >
          {t("recent.markAllRead")}
        </button>
      )}
      {open && (
        <>
          <RecentTabs value={recentTab} onChange={setRecentTab} counts={counts} needsYou={needsYou}>
            <SourceTabs value={recentSource} onChange={setRecentSource} stats={sources} />
          </RecentTabs>
          <SidebarGroupContent id="recent-chats-panel" role="tabpanel" aria-labelledby={`recent-tab-${recentTab}`}>
            <SidebarMenu>
              {items.length === 0 && <EmptyTab tab={recentTab} source={recentSource} scopeName={scopeName} hasArchived={hasArchived} />}
              {items.map((c, i) => {
                const day = dated && (i === 0 || dayOf(items[i - 1]!) !== dayOf(c)) ? dayOf(c) : null;
                const agent = agents.find((a) => a.id === c.agentId);
                const workspaceId = c.workspaceId ?? agent?.workspaceId;
                const workspace = scope === "all" && workspaceId ? workspaces.find((w) => w.id === workspaceId) : undefined;
                const projectId = !workspace && !scopeProject ? chatProject(c, agents) : null;
                const project = projectId ? projectIndex.get(projectId)?.project : undefined;
                const running = runningConversations.has(c.id) || (c.running && !queuedConversations.has(c.id));
                const queued = !running && queuedConversations.has(c.id);
                return (
                  <Fragment key={c.id}>
                  {day && (
                    <li role="presentation" className={cn("px-2 pb-0.5 text-[10.5px] font-medium text-muted-foreground/80", i > 0 ? "pt-3" : "pt-1")}>
                      {day}
                    </li>
                  )}
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={conversationId === c.id}
                      className="h-auto py-1.5 group-focus-within/menu-item:pr-15! group-hover/menu-item:pr-15! group-has-data-[sidebar=menu-action]/menu-item:pr-2 max-md:pr-15! data-[active=true]:bg-card data-[active=true]:shadow-card data-[active=true]:ring-1 data-[active=true]:ring-border"
                    >
                      <Link to={`/chat/${c.id}`} className="flex items-start gap-2">
                        <AgentAvatar agent={agent ?? { id: c.agentId, color: "violet" }} size="sm" still className="-mt-0.5 size-5" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1">
                            <span className={cn("truncate text-[13px]", c.unread && conversationId !== c.id && "font-semibold text-foreground")}>{c.title || t("shell.newChat")}</span>
                            {c.unread && conversationId !== c.id && (
                              <span
                                className={cn("size-1.5 shrink-0 rounded-full", c.unread.failed ? "bg-destructive" : "bg-brand-strong")}
                                role="img"
                                aria-label={c.unread.failed ? t("recent.failedHere") : t("recent.newReply")}
                              />
                            )}
                            {c.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
                          </span>
                          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                            {workspace && <WorkspaceChip workspace={workspace} />}
                            {project && <WorkspaceChip workspace={project} kind="project" />}
                            <span className="block min-w-0 flex-1 truncate">
                              {chatStatus(c, { running, queued }) ?? (
                                <>
                                  {originLine(c, agents) ?? agent?.name ?? t("common:words.agent")} · {formatDistanceToNowStrict(new Date(c.lastMessageAt ?? c.createdAt), { addSuffix: false, locale: dateLocale() })}
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
        </>
      )}
      {deleteDialog}
    </SidebarGroup>
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

const TAB_LIST = "flex gap-px rounded-lg border bg-secondary/70 p-0.5";
const TAB =
  "relative flex h-6.5 min-w-0 flex-auto items-center justify-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50";
const TAB_PILL = "absolute inset-0 rounded-md bg-card shadow-card ring-1 ring-border dark:bg-accent";
const TAB_SPRING = { type: "spring", stiffness: 460, damping: 36 } as const;

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

function SourceTabs({
  value,
  onChange,
  stats,
}: {
  value: RecentSource;
  onChange: (source: RecentSource) => void;
  stats: Record<RecentSource, SourceStat>;
}) {
  const { t } = useTranslation("layout");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (SOURCES.findIndex((s) => s.value === value) + delta + SOURCES.length) % SOURCES.length;
    onChange(SOURCES[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label={t("recent.sourcesLabel")} onKeyDown={onKeyDown} className={cn(TAB_LIST, "mb-1")}>
      {SOURCES.map((s, i) => {
        const active = s.value === value;
        const { unread, needsYou } = stats[s.value];
        const signal = !active && s.value !== "all" && (needsYou > 0 ? "needs" : unread > 0 ? "unread" : null);
        const hint = t(`recent.sources.${s.value}.hint`);
        return (
          <Tooltip key={s.value}>
            <TooltipTrigger asChild>
              <button
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onChange(s.value)}
                className={cn(TAB, active ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {active && <motion.span layoutId="recent-source-pill" className={TAB_PILL} transition={TAB_SPRING} />}
                <span className="relative truncate">{t(`recent.sources.${s.value}.label`)}</span>
                {signal && (
                  <span
                    className={cn("relative size-1.5 shrink-0 rounded-full", signal === "needs" ? "bg-warning" : "bg-brand-strong")}
                    role="img"
                    aria-label={signal === "needs" ? t("recent.waitingForYou") : t("recent.newReplies")}
                  />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {needsYou > 0 ? t("recent.hintNeedsYou", { hint, count: needsYou }) : unread > 0 ? t("recent.hintUnread", { hint, count: unread }) : hint}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
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

const TABS = [{ value: "all" }, { value: "running" }, { value: "scheduled" }, { value: "done" }] as const satisfies readonly { value: RecentTab }[];

function RecentTabs({
  value,
  onChange,
  counts,
  needsYou,
  children,
}: {
  value: RecentTab;
  onChange: (tab: RecentTab) => void;
  counts: Record<RecentTab, number>;
  needsYou: number;
  children?: ReactNode;
}) {
  const { t } = useTranslation("layout");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (TABS.findIndex((tab) => tab.value === value) + delta + TABS.length) % TABS.length;
    onChange(TABS[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div className="sticky top-0 z-10 -mx-2 bg-sidebar px-2 pt-1 pb-1.5">
      {children}
      <div role="tablist" aria-label={t("recent.tabsLabel")} onKeyDown={onKeyDown} className={TAB_LIST}>
        {TABS.map((tab, i) => {
          const active = tab.value === value;
          const count = tab.value === "running" || tab.value === "scheduled" ? counts[tab.value] : 0;
          const urgent = tab.value === "running" && needsYou > 0;
          const hint = t(`recent.tabs.${tab.value}.hint`);
          return (
            <Tooltip key={tab.value}>
              <TooltipTrigger asChild>
                <button
                  ref={(el) => {
                    refs.current[i] = el;
                  }}
                  id={`recent-tab-${tab.value}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls="recent-chats-panel"
                  tabIndex={active ? 0 : -1}
                  onClick={() => onChange(tab.value)}
                  className={cn(TAB, active ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                >
                  {active && <motion.span layoutId="recent-tab-pill" className={TAB_PILL} transition={TAB_SPRING} />}
                  <span className="relative truncate">{t(`recent.tabs.${tab.value}.label`)}</span>
                  {count > 0 && (
                    <span
                      className={cn(
                        "relative flex h-3.5 min-w-3.5 items-center justify-center gap-0.5 rounded-full px-1 text-[10px] leading-none tabular-nums",
                        urgent
                          ? "bg-warning/15 text-warning"
                          : tab.value === "running"
                            ? "bg-brand-strong/12 text-brand-strong"
                            : active
                              ? "bg-foreground/8 text-foreground"
                              : "bg-foreground/6 text-muted-foreground",
                      )}
                    >
                      {tab.value === "running" && !urgent && <span className="size-1 animate-pulse rounded-full bg-current" aria-hidden />}
                      {count}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{urgent ? t("recent.hintNeedsYou", { hint, count: needsYou }) : hint}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
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
