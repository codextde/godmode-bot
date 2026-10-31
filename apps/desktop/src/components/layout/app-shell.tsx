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
import { useTranslation } from "react-i18next";
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
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Logo } from "@/components/brand";
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
import { UsageRing } from "@/components/layout/usage-ring";
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
  const { t } = useTranslation(["layout", "system"]);
  const { data: boot } = useBootstrap();
  const navigate = useNavigate();
  const setCommandOpen = useUi((s) => s.setCommandOpen);
  const { toggle: toggleTheme } = useTheme();
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const sidebarWidth = useUi((s) => s.sidebarWidth);
  const [resizing, setResizing] = useState(false);
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
  const workNav: NavItem[] = [
    { to: "/inbox", label: t("nav.inbox"), icon: <Inbox />, badge: inboxCount || undefined },
    { to: "/tasks", label: t("nav.tasks"), icon: <SquareKanban />, badge: (attention?.review ?? 0) + (attention?.blocked ?? 0) || undefined },
    { to: "/agents", label: t("nav.agents"), icon: <Bot />, badge: runningCount || undefined },
    { to: "/automations", label: t("nav.automations"), icon: <Workflow />, badge: attention?.automation || undefined },
    { to: "/activity", label: t("nav.activity"), icon: <Activity /> },
    { to: "/calls", label: t("nav.calls"), icon: <Phone /> },
    { to: "/plugins", label: t("nav.plugins"), icon: <Puzzle />, badge: modsWaiting || undefined },
    { to: "/vault/logins", label: t("nav.passwords"), icon: <KeyRound />, also: ["/vault/2fa", "/vault/passkeys"] },
    { to: "/vault/cards", label: t("nav.cards"), icon: <CreditCard /> },
  ];
  const machineNav: NavItem[] = [
    { to: "/browser", label: t("nav.browser"), icon: <Globe /> },
    { to: "/computer", label: t("nav.computer"), icon: <MonitorUp /> },
    { to: "/vms", label: t("nav.vms"), icon: <Box /> },
    { to: "/ssh", label: t("nav.ssh"), icon: <Server /> },
  ];
  // Easy mode: the everyday pages in plain words up front, every other page under More.
  const byPath = new Map([...workNav, ...machineNav].map((item) => [item.to, item]));
  const easyItem = (to: string, label: string): NavItem => ({ ...byPath.get(to)!, label });
  const easyNav: NavItem[] = [
    easyItem("/inbox", t("nav.inbox")),
    easyItem("/agents", t("nav.agents")),
    easyItem("/automations", t("nav.automations")),
    easyItem("/tasks", t("nav.tasks")),
    easyItem("/vault/logins", t("nav.passwords")),
  ];
  const easyMore: NavItem[] = [
    easyItem("/activity", t("system:easyPages.activity.title")),
    easyItem("/calls", t("system:easyPages.calls.title")),
    easyItem("/vault/cards", t("system:easyPages.cards.title")),
    easyItem("/plugins", t("system:easyPages.plugins.title")),
    easyItem("/browser", t("nav.browser")),
    easyItem("/computer", t("system:easyPages.computer.title")),
    easyItem("/vms", t("nav.vms")),
    easyItem("/ssh", t("system:easyPages.ssh.title")),
  ].filter(shown);
  const workItems = easy ? easyNav : workNav.filter(shown);

  return (
    // Fixed viewport height: pages get a definite `h-full`, so the chat thread scrolls inside itself and the
    // composer stays put (with `min-h-svh` the whole page grew and scrolled the composer away).
    <SidebarProvider
      open={compact ? peek : !collapsed}
      onOpenChange={(open) => (compact ? setPeek(open) : setCollapsed(!open))}
      className={cn(
        "h-svh min-h-0 overflow-hidden",
        resizing && "cursor-col-resize select-none [&_[data-slot=sidebar-container]]:transition-none [&_[data-slot=sidebar-gap]]:transition-none",
      )}
      // The macOS traffic lights reach 72px in; widen the icon rail so they never sit on top of a page.
      style={
        {
          ...(isTauri && isMac ? { "--sidebar-width-icon": "5rem" } : {}),
          ...(sidebarWidth ? { "--sidebar-width": `${sidebarWidth}px` } : {}),
        } as CSSProperties
      }
    >
      <Sidebar collapsible="icon" variant="sidebar">
        <SidebarHeader
          className={cn("gap-2 px-3 pt-2 pb-1 group-data-[collapsible=icon]:items-center", isTauri && isMac && "pt-[15px] group-data-[collapsible=icon]:pt-10")}
          data-tauri-drag-region
        >
          <div
            className={cn("relative flex h-7 items-center gap-0.5 group-data-[collapsible=icon]:justify-center", isTauri && isMac && "pl-16 group-data-[collapsible=icon]:pl-0")}
            data-tauri-drag-region
          >
            <Link to="/" className={cn("no-drag rounded-md", isTauri && isMac && "hidden group-data-[collapsible=icon]:block")} aria-label={t("shell.home")}>
              <Logo className="size-6" />
            </Link>
            <div className="flex-1 self-stretch group-data-[collapsible=icon]:hidden" data-tauri-drag-region />
            <SearchButton className="group-data-[collapsible=icon]:hidden" />
            <SidebarToggle />
          </div>
          <div className="-mx-1 group-data-[collapsible=icon]:mx-0">
            <WorkspaceSwitcher />
          </div>
          <div className="-mx-1 flex gap-1.5 group-data-[collapsible=icon]:mx-0 group-data-[collapsible=icon]:flex-col">
            <Button
              asChild
              variant="ghost"
              className="h-8 flex-1 justify-start gap-2.5 rounded-md border border-sidebar-border bg-sidebar-accent/50 px-2 text-[13px] font-normal text-sidebar-foreground shadow-none hover:bg-sidebar-accent hover:text-foreground has-[>svg]:px-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
            >
              <Link to="/">
                <MessageSquarePlus className="size-4 text-muted-foreground" />
                <span className="group-data-[collapsible=icon]:hidden">{t("shell.newChat")}</span>
                <kbd className="ml-auto font-mono text-[10px] tracking-wide text-muted-foreground group-data-[collapsible=icon]:hidden">{modKey}N</kbd>
              </Link>
            </Button>
            <SearchButton className="hidden group-data-[collapsible=icon]:inline-flex" />
          </div>
        </SidebarHeader>

        <SidebarContent>
          <NavSection id="work" label={t("shell.sections.work")} items={workItems.filter((item) => !hiddenNav.includes(item.to))} bare />
          {easy ? (
            <NavSection id="more" label={t("shell.sections.more")} items={easyMore} folded="list" action={<EditSidebarButton items={workItems} />} />
          ) : (
            <NavSection id="machines" label={t("shell.sections.machines")} items={machineNav.filter(shown)} action={<EditSidebarButton items={workItems} />} />
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
        <ResizeRail onResizing={setResizing} />
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

const SIDEBAR_MIN = 208;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 256;

function ResizeRail({ onResizing }: { onResizing: (resizing: boolean) => void }) {
  const { t } = useTranslation("layout");
  const { state, isMobile, toggleSidebar } = useSidebar();
  const setWidth = useUi((s) => s.setSidebarWidth);
  if (isMobile) return null;
  const expanded = state === "expanded";
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const container = e.currentTarget.closest<HTMLElement>("[data-slot=sidebar-container]");
    const startWidth = container?.getBoundingClientRect().width ?? SIDEBAR_DEFAULT;
    let dragged = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!dragged && Math.abs(dx) < 4) return;
      if (!dragged) {
        dragged = true;
        onResizing(true);
      }
      if (!expanded) {
        if (dx > 24) {
          toggleSidebar();
          cleanup();
        }
        return;
      }
      const next = startWidth + dx;
      if (next < SIDEBAR_MIN - 64) {
        toggleSidebar();
        cleanup();
        return;
      }
      setWidth(Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, next))));
    };
    const up = () => {
      if (!dragged) toggleSidebar();
      cleanup();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onResizing(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <button
      type="button"
      data-sidebar="rail"
      tabIndex={-1}
      aria-label={expanded ? t("shell.resizeSidebar") : t("shell.expandSidebar")}
      title={expanded ? t("shell.resizeHint") : t("shell.expandHint")}
      onPointerDown={onPointerDown}
      className="absolute inset-y-0 -right-2 z-20 hidden w-4 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 after:transition-colors hover:after:bg-sidebar-border sm:flex"
    />
  );
}

function SearchButton({ className }: { className?: string }) {
  const { t } = useTranslation("layout");
  const setCommandOpen = useUi((s) => s.setCommandOpen);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("no-drag size-7 text-muted-foreground hover:text-foreground", className)}
          aria-label={t("shell.search")}
          aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
          onClick={() => setCommandOpen(true)}
        >
          <Search className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t("shell.searchTooltip", { shortcut: `${modKey}K` })}</TooltipContent>
    </Tooltip>
  );
}

function SidebarToggle() {
  const { t } = useTranslation("layout");
  const { open, isMobile, toggleSidebar } = useSidebar();
  const expanded = isMobile || open;
  const label = isMobile ? t("shell.closeNavigation") : expanded ? t("shell.collapseSidebar") : t("shell.expandSidebar");
  const Icon = expanded ? PanelLeftClose : PanelLeftOpen;
  const button = (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn(
        "no-drag size-7 text-muted-foreground hover:text-foreground",
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
  const { t } = useTranslation("layout");
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
        aria-label={attention ? t("shell.openNavigationAttention") : t("shell.openNavigation")}
        aria-haspopup="dialog"
        aria-expanded={openMobile}
        onClick={() => setOpenMobile(true)}
      >
        <PanelLeft className="size-[18px]" />
        {attention && <span className="absolute top-2 right-2 size-1.5 rounded-full bg-brand ring-2 ring-background" />}
      </Button>
      <Link to="/" className="no-drag flex min-w-0 items-center gap-2 rounded-md px-1 py-1" aria-label={t("shell.home")}>
        <Logo className="size-6" />
        <span className="truncate text-[15px] font-medium tracking-[-0.02em]">{cloudContext?.deviceName ?? "Godmode"}</span>
      </Link>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="icon" aria-label={t("shell.search")} aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"} onClick={() => setCommandOpen(true)}>
          <Search className="size-[18px]" />
        </Button>
        <Button size="icon" className="size-8" aria-label={t("shell.newChat")} asChild>
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
  bare = false,
}: {
  id: string;
  label: string;
  items: NavItem[];
  folded?: "icons" | "list";
  defaultOpen?: boolean;
  action?: ReactNode;
  bare?: boolean;
}) {
  const { t } = useTranslation("layout");
  const expanded = useUi((s) => (defaultOpen ? !s.collapsedNav.includes(id) : s.expandedNav.includes(id)));
  const toggle = useUi((s) => (defaultOpen ? s.toggleNavCollapsed : s.toggleNavSection));
  const { state, isMobile } = useSidebar();
  const railed = state === "collapsed" && !isMobile;
  const { pathname } = useLocation();
  const listId = `nav-section-${id}`;
  const open = bare || expanded || railed;
  const toggleButton = <NavSectionHeader label={label} open={open} controls={listId} onToggle={() => toggle(id)} quiet={folded === "icons"} />;
  const header = action ? (
    <div className="group/section flex min-w-0 flex-1 items-center justify-between gap-1 pr-1">
      {toggleButton}
      {action}
    </div>
  ) : (
    toggleButton
  );
  if (open)
    return (
      <SidebarGroup className={cn("py-1", bare && "pt-0")}>
        {!bare && header}
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
      <SidebarGroup className="py-0">
        <div className="flex items-center justify-between gap-1">
          {header}
          {waiting > 0 && <span className="mr-2 size-1.5 rounded-full bg-brand" aria-label={t("shell.waiting", { count: waiting })} />}
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
        className="h-7 gap-2.5 text-[13px] text-sidebar-foreground/85 [&>svg]:size-4 [&>svg]:text-muted-foreground data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:text-foreground data-[active=true]:shadow-card data-[active=true]:ring-1 data-[active=true]:ring-border data-[active=true]:[&>svg]:text-foreground"
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
  const { t } = useTranslation("layout");
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
            <span className="block text-[11px] text-muted-foreground">{t("cloud.allComputers")}</span>
            <span className="block truncate text-[13px] font-medium text-foreground">{cloud.deviceName}</span>
          </span>
        </a>
      </TooltipTrigger>
      <TooltipContent side="right">{t("cloud.allComputersTooltip")}</TooltipContent>
    </Tooltip>
  );
}

/** Cloud mode: the cloud serves its own build of this dashboard, which can be older or newer than Godmode on the computer. */
function CloudVersionNote({ coreVersion, uiVersion }: { coreVersion: string; uiVersion: string }) {
  const { t } = useTranslation(["layout", "common"]);
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
        {t("cloud.versionNote", { coreVersion, uiVersion })}
      </Callout>
      <Button variant="ghost" size="icon-xs" className="absolute top-5 right-5 text-muted-foreground" aria-label={t("cloud.dismiss")} onClick={dismiss}>
        <X />
      </Button>
    </div>
  );
}

/** Settings pages, and the pages they open (an agent's files, a phone, an artifact). */
const SETTINGS_PATHS = ["/settings", "/files", "/android/", "/artifacts/"];

function FooterBar() {
  const { t } = useTranslation(["layout", "common"]);
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
            {connected ? t("footer.online") : t("footer.reconnecting")}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {cloudContext
            ? connected
              ? t("footer.connectedCloud", { device: cloudContext.deviceName })
              : t("footer.lostCloud", { device: cloudContext.deviceName })
            : connected
              ? t("footer.connectedCore")
              : t("footer.lostCore")}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => lock.mutate()}>
            <Lock className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("footer.lockVault")}</TooltipContent>
      </Tooltip>
      <LidModeButton />
      <UsageRing />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={SETTINGS_PATHS.some((p) => location.pathname.startsWith(p)) ? "secondary" : "ghost"}
            size="icon"
            className="relative size-8"
            aria-label={requests ? t("footer.settingsWaitingLabel", { count: requests }) : t("common:words.settings")}
            asChild
          >
            <Link to={requests ? "/settings/messaging" : "/settings/general"}>
              <Settings className="size-4" />
              {requests > 0 && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-brand ring-2 ring-card" aria-hidden />}
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{requests ? t("footer.settingsWaiting", { count: requests }) : t("footer.settingsShortcut", { shortcut: `${modKey},` })}</TooltipContent>
      </Tooltip>
    </div>
  );
}
