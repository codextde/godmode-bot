import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  Bot,
  Box,
  ChevronRight,
  Globe,
  MonitorUp,
  Inbox,
  KeyRound,
  ListTodo,
  Lock,
  MessageCircle,
  MessageSquarePlus,
  MessagesSquare,
  MonitorSmartphone,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Puzzle,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SquareKanban,
  Workflow,
  X,
} from "lucide-react";
import { modState } from "@godmode/shared";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Logo, Wordmark } from "@/components/brand";
import { LiveDot } from "@/components/aicss/Motion";
import { WorkspaceSwitcher, useWorkspaceShortcuts } from "@/components/layout/workspace-switcher";
import { RecentChats } from "@/components/layout/recent-chats";
import { CommandPalette } from "@/components/layout/command-palette";
import { UpdateButton } from "@/components/layout/update-button";
import { ClaudeUpdateButton } from "@/components/layout/claude-update-button";
import { PageScrollContext } from "@/components/layout/page-scroll";
import { Callout } from "@/components/settings/settings-kit";
import { LicenseBanner } from "@/components/license/license-banner";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useBootstrap, useMods } from "@/lib/hooks";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { isMac, modKey } from "@/lib/desktop";
import { cloudContext, isTauri, storageKey } from "@/lib/core";
import { useLive, useRunningCount } from "@/stores/live";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { startPresence } from "@/lib/presence";
import { GO_TO, ShortcutsDialog } from "@/components/layout/shortcuts-dialog";

/**
 * Typing in a field, a dialog, an open list or menu (typeahead), or a remote screen the human controls
 * (`role=application`): plain keys belong to it.
 */
function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || !!el.closest("[role=dialog],[role=alertdialog],[role=application],[role=listbox],[role=menu]"))
  );
}

/** The letter a key stands for, also on layouts without Latin letters (G is the G key wherever it is labelled). */
function letterOf(e: KeyboardEvent): string {
  const key = e.key.toLowerCase();
  if (/^[a-z]$/.test(key) || key.length !== 1) return key;
  return /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : key;
}

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: number;
  end?: boolean;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { data: boot } = useBootstrap();
  const navigate = useNavigate();
  const setCommandOpen = useUi((s) => s.setCommandOpen);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const setCollapsed = useUi((s) => s.setSidebarCollapsed);
  const runningCount = useRunningCount();
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const location = useLocation();
  // 768–1023px: icon rail by default; expanding it is a temporary peek that folds back on navigation.
  const compact = useMediaQuery("(width >= 768px) and (width < 1024px)");
  const [peek, setPeek] = useState(false);
  useEffect(() => setPeek(false), [compact, location.key]);
  // What waits for the human; only when nothing does, the updates they haven't read.
  const attention = boot?.counts.attention;
  const waiting = attention?.total ?? (boot?.counts.openQuestions ?? 0) + (boot?.counts.openMissingLogins ?? 0);
  const inboxCount = waiting || (boot?.counts.unreadNotifications ?? 0);
  const { data: mods = [] } = useMods();
  // Mods that wait for the human: an agent's draft to review, or code the check refuses.
  const modsWaiting = mods.filter((m) => ["review", "broken"].includes(modState(m))).length;

  // Notices when the human comes back after a while (Home then sums up what happened).
  useEffect(() => startPresence(), []);
  useWorkspaceShortcuts();

  // Global shortcuts
  useEffect(() => {
    // "G then T": the G, while the next key may still come.
    let goAt = 0;
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      // Plain keys only outside text fields and dialogs (there they are typing), and only keys nothing else took.
      if (!mod && !e.altKey && !e.defaultPrevented && !typingIn(e.target)) {
        const key = letterOf(e);
        if (e.key === "?") {
          e.preventDefault();
          useUi.getState().setShortcutsOpen(true);
          return;
        }
        if (goAt && Date.now() - goAt < 1500) {
          goAt = 0;
          const target = GO_TO.find((g) => g.key === key);
          if (target) {
            e.preventDefault();
            navigate(target.to);
          }
          return;
        }
        if (key === "g" && !e.shiftKey) {
          goAt = Date.now();
          return;
        }
      }
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandOpen(true);
      } else if (mod && e.key.toLowerCase() === "n" && !e.shiftKey) {
        e.preventDefault();
        navigate("/");
      } else if (mod && e.key === ",") {
        e.preventDefault();
        navigate("/settings/general");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, setCommandOpen]);

  const workNav: NavItem[] = [
    { to: "/inbox", label: "Inbox", icon: <Inbox />, badge: inboxCount || undefined },
    { to: "/my-tasks", label: "My tasks", icon: <ListTodo />, badge: attention?.todo || undefined },
    { to: "/tasks", label: "Tasks", icon: <SquareKanban />, badge: (attention?.review ?? 0) + (attention?.blocked ?? 0) || undefined },
    { to: "/agents", label: "Agents", icon: <Bot />, badge: runningCount || undefined },
    { to: "/automations", label: "Automations", icon: <Workflow />, badge: attention?.automation || undefined },
    { to: "/activity", label: "Activity", icon: <Activity /> },
    { to: "/mods", label: "Mods", icon: <Puzzle />, badge: modsWaiting || undefined },
  ];
  const accessNav: NavItem[] = [
    { to: "/vault/logins", label: "Logins", icon: <KeyRound /> },
    { to: "/vault/2fa", label: "2FA Codes", icon: <ShieldCheck /> },
    { to: "/integrations", label: "Integrations", icon: <Plug /> },
    { to: "/messaging", label: "Messaging", icon: <MessageCircle />, badge: boot?.counts.messagingRequests || undefined },
  ];
  const machineNav: NavItem[] = [
    { to: "/browser", label: "Browser", icon: <Globe /> },
    { to: "/computer", label: "Computer", icon: <MonitorUp /> },
    { to: "/vms", label: "Virtual machines", icon: <Box /> },
    { to: "/ssh", label: "SSH servers", icon: <Server /> },
    { to: "/runners", label: "Runners", icon: <MonitorSmartphone /> },
  ];

  return (
    // Fixed viewport height: pages get a definite `h-full`, so the chat thread scrolls inside itself and the
    // composer stays put (with `min-h-svh` the whole page grew and scrolled the composer away).
    <SidebarProvider
      open={compact ? peek : !collapsed}
      onOpenChange={(open) => (compact ? setPeek(open) : setCollapsed(!open))}
      className="h-svh min-h-0 overflow-hidden"
      // The macOS traffic lights reach 72px in; widen the icon rail so they never sit on top of a page.
      style={isTauri && isMac ? ({ "--sidebar-width-icon": "5rem" } as CSSProperties) : undefined}
    >
      <Sidebar collapsible="icon" variant="sidebar">
        <SidebarHeader className={cn("gap-3 px-3 pt-3 group-data-[collapsible=icon]:items-center", isTauri && isMac && "pt-10")} data-tauri-drag-region>
          <div className="relative flex items-center justify-between px-1 group-data-[collapsible=icon]:justify-center" data-tauri-drag-region>
            <Link to="/" className="no-drag">
              <Wordmark className="group-data-[collapsible=icon]:[&>div:last-child]:hidden" />
            </Link>
            <SidebarToggle />
          </div>
          <WorkspaceSwitcher />
          <div className="flex gap-2 group-data-[collapsible=icon]:flex-col">
            <Button
              asChild
              className="h-9 flex-1 justify-start gap-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
            >
              <Link to="/">
                <MessageSquarePlus className="size-4" />
                <span className="group-data-[collapsible=icon]:hidden">New chat</span>
                <kbd className="ml-auto font-mono text-[10px] tracking-wide opacity-55 group-data-[collapsible=icon]:hidden">{modKey}N</kbd>
              </Link>
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" className="size-9 shrink-0 group-data-[collapsible=icon]:size-8" onClick={() => setCommandOpen(true)}>
                  <Search className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Search & commands ({modKey}K)</TooltipContent>
            </Tooltip>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu className="group-data-[collapsible=icon]:items-center">
                <NavMenuItem item={{ to: "/", label: "Chat", icon: <MessagesSquare />, end: true }} />
                {workNav.map((item) => (
                  <NavMenuItem key={item.to} item={item} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <NavSection id="access" label="Access" items={accessNav} />
          <NavSection id="machines" label="Machines" items={machineNav} />
          <RecentChats />
        </SidebarContent>

        <SidebarFooter className="px-3 pb-3">
          <ClaudeUpdateButton />
          <UpdateButton />
          {cloudContext && <CloudComputerLink />}
          <FooterBar />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="relative h-svh min-h-0 min-w-0 overflow-hidden bg-background">
        <MobileBar attention={inboxCount > 0} />
        <DesktopDragStrip />
        {cloudContext && boot && <CloudVersionNote coreVersion={boot.version} uiVersion={cloudContext.uiVersion} />}
        <LicenseBanner />
        <div ref={setScrollEl} className="@container min-h-0 flex-1 overflow-y-auto">
          <PageScrollContext value={scrollEl}>{children}</PageScrollContext>
        </div>
      </SidebarInset>
      <CommandPalette />
      <ShortcutsDialog />
    </SidebarProvider>
  );
}

function SidebarToggle() {
  const { open, isMobile, toggleSidebar } = useSidebar();
  const expanded = isMobile || open;
  const label = isMobile ? "Close navigation" : expanded ? "Collapse sidebar" : "Expand sidebar";
  const Icon = expanded ? PanelLeftClose : PanelLeftOpen;
  const button = (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn(
        "size-7 text-muted-foreground hover:text-foreground",
        // The rail has no room for another row: the button takes the logo's place while the rail is hovered or it has focus.
        !expanded &&
          "absolute top-1/2 left-1/2 -translate-1/2 bg-sidebar opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
      )}
      aria-label={label}
      aria-keyshortcuts={isMac ? "Meta+B" : "Control+B"}
      onClick={toggleSidebar}
    >
      <Icon />
    </Button>
  );
  // The sheet focuses this button as it opens, which would pop the tooltip over the navigation.
  if (isMobile) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={expanded ? "bottom" : "right"}>
        {label} ({modKey}B)
      </TooltipContent>
    </Tooltip>
  );
}

function MobileBar({ attention }: { attention: boolean }) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  const setCommandOpen = useUi((s) => s.setCommandOpen);
  const location = useLocation();
  useEffect(() => setOpenMobile(false), [location.key, isMobile, setOpenMobile]);
  if (!isMobile) return null;
  const mac = isTauri && isMac;
  return (
    <header
      data-tauri-drag-region
      className={cn(
        "z-30 flex h-12 shrink-0 items-center gap-1 border-b bg-background/85 px-2 backdrop-blur-md",
        mac && "h-14 pl-[84px]",
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        aria-label={attention ? "Open navigation — inbox needs attention" : "Open navigation"}
        aria-haspopup="dialog"
        aria-expanded={openMobile}
        onClick={() => setOpenMobile(true)}
      >
        <PanelLeft className="size-[18px]" />
        {attention && <span className="absolute top-2 right-2 size-1.5 rounded-full bg-brand ring-2 ring-background" />}
      </Button>
      <Link to="/" className="no-drag flex min-w-0 items-center gap-2 rounded-md px-1 py-1" aria-label="Godmode home">
        <Logo className="size-6" />
        <span className="truncate text-[15px] font-medium tracking-[-0.02em]">{cloudContext?.deviceName ?? "Godmode"}</span>
      </Link>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="icon" aria-label="Search and commands" aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"} onClick={() => setCommandOpen(true)}>
          <Search className="size-[18px]" />
        </Button>
        <Button size="icon" className="size-8" aria-label="New chat" asChild>
          <Link to="/">
            <MessageSquarePlus className="size-4" />
          </Link>
        </Button>
      </div>
    </header>
  );
}

function DesktopDragStrip() {
  const { isMobile } = useSidebar();
  if (!isTauri || !isMac || isMobile) return null;
  return <div className="absolute inset-x-0 top-0 z-50 h-7" data-tauri-drag-region />;
}

/** A sidebar section that folds to its label and a row of icons, so chats keep the room. The rail always lists every item. */
function NavSection({ id, label, items }: { id: string; label: string; items: NavItem[] }) {
  const expanded = useUi((s) => s.expandedNav.includes(id));
  const toggle = useUi((s) => s.toggleNavSection);
  const { state, isMobile } = useSidebar();
  const railed = state === "collapsed" && !isMobile;
  const { pathname } = useLocation();
  const listId = `nav-section-${id}`;
  const open = expanded || railed;
  const header = (
    <button
      type="button"
      onClick={() => toggle(id)}
      aria-expanded={open}
      aria-controls={listId}
      className="eyebrow group/label flex h-7 min-w-0 shrink items-center gap-1 rounded-md px-2 text-[10.5px] text-sidebar-foreground/70 outline-none transition hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:hidden"
    >
      {label}
      <ChevronRight className={cn("size-3 opacity-0 transition group-hover/label:opacity-100 group-focus-visible/label:opacity-100", open && "rotate-90")} />
    </button>
  );
  if (open)
    return (
      <SidebarGroup className="py-1">
        {header}
        <SidebarGroupContent id={listId}>
          <SidebarMenu className="group-data-[collapsible=icon]:items-center">
            {items.map((item) => (
              <NavMenuItem key={item.to} item={item} />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  return (
    <SidebarGroup className="flex-row items-center justify-between gap-1 py-0.5">
      {header}
      <div id={listId} className="flex items-center">
        {items.map((item) => {
          const active = pathname.startsWith(item.to);
          return (
            <Tooltip key={item.to}>
              <TooltipTrigger asChild>
                <NavLink
                  to={item.to}
                  aria-label={item.badge ? `${item.label} (${item.badge})` : item.label}
                  className={cn(
                    "relative grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring [&>svg]:size-4",
                    active && "bg-card text-foreground shadow-card ring-1 ring-border",
                  )}
                >
                  {item.icon}
                  {item.badge ? <span className="absolute top-1 right-1 size-1.5 rounded-full bg-brand ring-2 ring-sidebar" aria-hidden /> : null}
                </NavLink>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {item.label}
                {item.badge ? ` · ${item.badge}` : ""}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </SidebarGroup>
  );
}

function NavMenuItem({ item }: { item: NavItem }) {
  const location = useLocation();
  const active = item.end ? location.pathname === item.to || location.pathname.startsWith("/chat/") : location.pathname.startsWith(item.to);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={item.label}
        className="h-8 gap-2.5 text-[13.5px] text-sidebar-foreground/85 [&>svg]:size-4 [&>svg]:text-muted-foreground data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:text-foreground data-[active=true]:shadow-card data-[active=true]:ring-1 data-[active=true]:ring-border data-[active=true]:[&>svg]:text-foreground"
      >
        <NavLink to={item.to} end={item.end}>
          {item.icon}
          <span>{item.label}</span>
        </NavLink>
      </SidebarMenuButton>
      {item.badge ? <SidebarMenuBadge className="rounded-[5px] bg-foreground/[0.07] font-mono text-[10.5px] text-foreground/70 tabular-nums">{item.badge}</SidebarMenuBadge> : null}
    </SidebarMenuItem>
  );
}

/** Cloud mode: which computer this is, and the way back to the cloud's list of computers (a page outside this app). */
function CloudComputerLink() {
  const cloud = cloudContext!;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={cloud.home}
          className="flex items-center gap-2.5 rounded-lg border bg-card p-1 pr-2 shadow-card outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:pr-1"
        >
          <span className="grid size-8 shrink-0 place-items-center text-muted-foreground">
            <ArrowLeft className="size-4" />
          </span>
          <span className="min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
            <span className="block text-[11px] text-muted-foreground">All computers</span>
            <span className="block truncate text-[13px] font-medium text-foreground">{cloud.deviceName}</span>
          </span>
        </a>
      </TooltipTrigger>
      <TooltipContent side="right">All computers in Godmode Cloud</TooltipContent>
    </Tooltip>
  );
}

/** Cloud mode: the cloud serves its own build of this dashboard, which can be older or newer than Godmode on the computer. */
function CloudVersionNote({ coreVersion, uiVersion }: { coreVersion: string; uiVersion: string }) {
  const key = storageKey("gm:version-note");
  const pair = `${coreVersion}|${uiVersion}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(key) === pair;
    } catch {
      return false;
    }
  });
  if (dismissed || coreVersion === uiVersion || uiVersion === "unknown") return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(key, pair);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="relative shrink-0 px-3 pt-3">
      <Callout className="pr-10">
        This computer runs Godmode {coreVersion}; this cloud shows the dashboard of {uiVersion}. If something looks wrong, update Godmode or ask the
        cloud's administrator to update.
      </Callout>
      <Button variant="ghost" size="icon-xs" className="absolute top-5 right-5 text-muted-foreground" aria-label="Dismiss" onClick={dismiss}>
        <X />
      </Button>
    </div>
  );
}

function FooterBar() {
  const connected = useLive((s) => s.connected);
  const qc = useQueryClient();
  const lock = useMutation({
    mutationFn: api.vault.lock,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.bootstrap }),
  });
  const location = useLocation();
  return (
    <div className="flex items-center gap-1 rounded-lg border bg-card p-1 shadow-card group-data-[collapsible=icon]:flex-col">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex h-8 flex-1 items-center gap-2 px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            <LiveDot live={connected} className={cn(!connected && "bg-warning")} />
            {connected ? "Online" : "Reconnecting…"}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {cloudContext
            ? connected
              ? `Connected to ${cloudContext.deviceName} through Godmode Cloud`
              : `Connection to ${cloudContext.deviceName} lost — retrying`
            : connected
              ? "Connected to Godmode core"
              : "Connection to core lost — retrying"}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => lock.mutate()}>
            <Lock className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Lock vault</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant={location.pathname.startsWith("/settings") ? "secondary" : "ghost"} size="icon" className="size-8" asChild>
            <Link to="/settings/general">
              <Settings className="size-4" />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Settings ({modKey},)</TooltipContent>
      </Tooltip>
    </div>
  );
}
