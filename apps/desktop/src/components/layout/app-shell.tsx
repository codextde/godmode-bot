import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  Bot,
  Box,
  CreditCard,
  Globe,
  MonitorUp,
  Inbox,
  KeyRound,
  Lock,
  MessageSquarePlus,
  MessagesSquare,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Phone,
  Puzzle,
  Search,
  Server,
  Settings,
  SquareKanban,
  Workflow,
  X,
} from "lucide-react";
import { modState, modUpdateAvailable } from "@godmode/shared";
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
import { NavSectionHeader } from "@/components/layout/nav-section-header";
import { EditSidebarButton } from "@/components/layout/edit-sidebar";
import { CommandPalette } from "@/components/layout/command-palette";
import { UpdateButton } from "@/components/layout/update-button";
import { ClaudeUpdateButton } from "@/components/layout/claude-update-button";
import { MacPermissionsButton } from "@/components/permissions/mac-permissions";
import { ClaudeSignedOutBanner } from "@/components/layout/claude-signed-out";
import { DeviceIndicator, PrimaryOfflineBanner } from "@/components/layout/device-status";
import { LidModeButton } from "@/components/layout/lid-mode";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { useTheme } from "@/components/theme-provider";
import { PageScrollContext } from "@/components/layout/page-scroll";
import { Callout } from "@/components/settings/settings-kit";
import { LicenseBanner } from "@/components/license/license-banner";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useBootstrap, useMods } from "@/lib/hooks";
import { useEasyMode } from "@/lib/mode";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { isMac, modKey } from "@/lib/desktop";
import { cloudContext, isTauri, storageKey } from "@/lib/core";
import { useLive, useRunningCount } from "@/stores/live";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { startPresence } from "@/lib/presence";
import { GO_TO, ShortcutsDialog } from "@/components/layout/shortcuts-dialog";
import { pageOn } from "@/components/settings/feature-section";

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
  /** Other paths the item stands for (the tabs of one screen). */
  also?: readonly string[];
}

const isActive = (item: NavItem, pathname: string) =>
  item.end ? pathname === item.to || (item.to === "/" && pathname.startsWith("/chat/")) : [item.to, ...(item.also ?? [])].some((to) => pathname.startsWith(to));

export function AppShell({ children }: { children: ReactNode }) {
  const { data: boot } = useBootstrap();
  const navigate = useNavigate();
  const setCommandOpen = useUi((s) => s.setCommandOpen);
  const { toggle: toggleTheme } = useTheme();
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
  const hiddenNav = useUi((s) => s.hiddenNav);
  const { data: mods = [] } = useMods();
  // Plugins that wait for the human: an agent's draft or install to review, code the check refuses, an update.
  const modsWaiting = mods.filter((m) => ["review", "broken"].includes(modState(m)) || modUpdateAvailable(m)).length;
  const easy = useEasyMode();

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
      } else if (mod && e.shiftKey && !e.altKey && letterOf(e) === "n") {
        e.preventDefault();
        navigate("/?private=1");
      } else if (mod && e.key === ",") {
        e.preventDefault();
        navigate("/settings/general");
      } else if (mod && e.shiftKey && !e.altKey && letterOf(e) === "l") {
        e.preventDefault();
        if (!e.repeat) toggleTheme();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, setCommandOpen, toggleTheme]);

  // Pages of features the human turned off leave the sidebar (Settings → Features turns them on again).
  const shown = (item: NavItem) => pageOn(boot?.settings, item.to);
  const chatItem: NavItem = { to: "/", label: "Chat", icon: <MessagesSquare />, end: true };
  const workNav: NavItem[] = [
    { to: "/inbox", label: "Needs you", icon: <Inbox />, badge: inboxCount || undefined },
    { to: "/tasks", label: "Agent tasks", icon: <SquareKanban />, badge: (attention?.review ?? 0) + (attention?.blocked ?? 0) || undefined },
    { to: "/agents", label: "Agents", icon: <Bot />, badge: runningCount || undefined },
    { to: "/automations", label: "Automations", icon: <Workflow />, badge: attention?.automation || undefined },
    { to: "/activity", label: "Activity", icon: <Activity /> },
    { to: "/calls", label: "Calls", icon: <Phone /> },
    { to: "/plugins", label: "Plugins", icon: <Puzzle />, badge: modsWaiting || undefined },
    { to: "/vault/logins", label: "Passwords", icon: <KeyRound />, also: ["/vault/2fa", "/vault/passkeys"] },
    { to: "/vault/cards", label: "Cards", icon: <CreditCard /> },
  ];
  const machineNav: NavItem[] = [
    { to: "/browser", label: "Browser", icon: <Globe /> },
    { to: "/computer", label: "Computer", icon: <MonitorUp /> },
    { to: "/vms", label: "Virtual machines", icon: <Box /> },
    { to: "/ssh", label: "SSH servers", icon: <Server /> },
  ];
  // Easy mode: the everyday pages in plain words up front, every other page under More.
  const byPath = new Map([...workNav, ...machineNav].map((item) => [item.to, item]));
  const easyItem = (to: string, label: string): NavItem => ({ ...byPath.get(to)!, label });
  const easyNav: NavItem[] = [
    easyItem("/inbox", "Needs you"),
    easyItem("/agents", "Agents"),
    easyItem("/automations", "Automations"),
    easyItem("/tasks", "Agent tasks"),
    easyItem("/vault/logins", "Passwords"),
  ];
  const easyMore: NavItem[] = [
    easyItem("/activity", "History"),
    easyItem("/calls", "Phone calls"),
    easyItem("/vault/cards", "Payment cards"),
    easyItem("/plugins", "Add-ons"),
    easyItem("/browser", "Browser"),
    easyItem("/computer", "Computer control"),
    easyItem("/vms", "Virtual machines"),
    easyItem("/ssh", "Servers"),
  ].filter(shown);
  const workItems = easy ? easyNav : workNav.filter(shown);

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
          <NavSection
            id="work"
            label="Work"
            items={[chatItem, ...workItems.filter((item) => !hiddenNav.includes(item.to))]}
            action={<EditSidebarButton items={workItems} />}
            defaultOpen
          />
          {easy ? (
            <NavSection id="more" label="More" items={easyMore} folded="list" />
          ) : (
            <>
              <NavSection id="machines" label="Machines" items={machineNav.filter(shown)} />
            </>
          )}
          <RecentChats />
        </SidebarContent>

        <SidebarFooter className="px-3 pb-3">
          <MacPermissionsButton />
          <ClaudeUpdateButton />
          <UpdateButton />
          <DeviceIndicator />
          {cloudContext && <CloudComputerLink />}
          <FooterBar />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="group/inset relative h-svh min-h-0 min-w-0 overflow-hidden bg-background">
        <MobileBar attention={inboxCount > 0} />
        <DesktopDragStrip />
        {cloudContext && boot && <CloudVersionNote coreVersion={boot.version} uiVersion={cloudContext.uiVersion} />}
        <PrimaryOfflineBanner />
        <ClaudeSignedOutBanner />
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
        aria-label={attention ? "Open navigation — something needs you" : "Open navigation"}
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
  return <div className="absolute inset-x-0 top-0 z-50 h-7 group-has-[[data-titlebar]]/inset:hidden" data-tauri-drag-region />;
}

/**
 * A sidebar section that folds to its label and a row of icons (or, for long lists, to the label and the page on screen),
 * so chats keep the room. The rail always lists every item.
 */
function NavSection({
  id,
  label,
  items,
  folded = "icons",
  defaultOpen = false,
  action,
}: {
  id: string;
  label: string;
  items: NavItem[];
  folded?: "icons" | "list";
  defaultOpen?: boolean;
  action?: ReactNode;
}) {
  const expanded = useUi((s) => (defaultOpen ? !s.collapsedNav.includes(id) : s.expandedNav.includes(id)));
  const toggle = useUi((s) => (defaultOpen ? s.toggleNavCollapsed : s.toggleNavSection));
  const { state, isMobile } = useSidebar();
  const railed = state === "collapsed" && !isMobile;
  const { pathname } = useLocation();
  const listId = `nav-section-${id}`;
  const open = expanded || railed;
  const toggleButton = <NavSectionHeader label={label} open={open} controls={listId} onToggle={() => toggle(id)} quiet={folded === "icons"} />;
  const header = action ? (
    <div className="group/section flex min-w-0 items-center justify-between gap-1 pr-1">
      {toggleButton}
      {action}
    </div>
  ) : (
    toggleButton
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
  if (folded === "list") {
    const current = items.find((item) => isActive(item, pathname));
    const waiting = items.reduce((sum, item) => sum + (item.badge ?? 0), 0);
    return (
      <SidebarGroup className="py-1">
        <div className="flex items-center justify-between gap-1">
          {header}
          {waiting > 0 && <span className="mr-2 size-1.5 rounded-full bg-brand" aria-label={`${waiting} waiting`} />}
        </div>
        {current && (
          <SidebarGroupContent id={listId}>
            <SidebarMenu>
              <NavMenuItem item={current} />
            </SidebarMenu>
          </SidebarGroupContent>
        )}
      </SidebarGroup>
    );
  }
  const wide = items.length > 5;
  return (
    <SidebarGroup className={cn("gap-1 py-0.5", !wide && "flex-row items-center justify-between")}>
      {header}
      <div id={listId} className={cn("flex items-center", wide && "flex-wrap justify-between px-1")}>
        {items.map((item) => {
          const active = isActive(item, pathname);
          return (
            <Tooltip key={item.to}>
              <TooltipTrigger asChild>
                <NavLink
                  to={item.to}
                  end={item.end}
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
  const active = isActive(item, location.pathname);
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

/** Settings pages, and the pages they open (an agent's files, a phone, an artifact). */
const SETTINGS_PATHS = ["/settings", "/files", "/android/", "/artifacts/"];

function FooterBar() {
  const { data: boot } = useBootstrap();
  // People waiting to talk to a bot: Settings → Messaging shows who.
  const requests = boot?.settings.messaging.enabled ? boot.counts.messagingRequests : 0;
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
            <LiveDot live={false} className={connected ? "bg-brand" : "animate-pulse bg-warning"} />
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
      <LidModeButton />
      <ThemeToggle />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={SETTINGS_PATHS.some((p) => location.pathname.startsWith(p)) ? "secondary" : "ghost"}
            size="icon"
            className="relative size-8"
            aria-label={requests ? `Settings (${requests} waiting in Messaging)` : "Settings"}
            asChild
          >
            <Link to={requests ? "/settings/messaging" : "/settings/general"}>
              <Settings className="size-4" />
              {requests > 0 && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-brand ring-2 ring-card" aria-hidden />}
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{requests ? `Settings · ${requests} waiting in Messaging` : `Settings (${modKey},)`}</TooltipContent>
      </Tooltip>
    </div>
  );
}
