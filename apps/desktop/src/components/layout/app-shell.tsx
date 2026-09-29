import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  Box,
  Globe,
  MonitorUp,
  Inbox,
  KeyRound,
  Lock,
  MessageCircle,
  MessageSquarePlus,
  MessagesSquare,
  PanelLeft,
  Plug,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Workflow,
} from "lucide-react";
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
import { WorkspaceSwitcher } from "@/components/layout/workspace-switcher";
import { RecentChats } from "@/components/layout/recent-chats";
import { CommandPalette } from "@/components/layout/command-palette";
import { UpdateButton } from "@/components/layout/update-button";
import { ClaudeUpdateButton } from "@/components/layout/claude-update-button";
import { PageScrollContext } from "@/components/layout/page-scroll";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useBootstrap } from "@/lib/hooks";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { isMac, modKey } from "@/lib/desktop";
import { isTauri } from "@/lib/core";
import { useLive } from "@/stores/live";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";

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
  const runningCount = useLive((s) => Object.keys(s.runs).length);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const location = useLocation();
  // 768–1023px: icon rail by default; expanding it is a temporary peek that folds back on navigation.
  const compact = useMediaQuery("(width >= 768px) and (width < 1024px)");
  const [peek, setPeek] = useState(false);
  useEffect(() => setPeek(false), [compact, location.key]);
  const inboxCount = (boot?.counts.openMissingLogins ?? 0) + (boot?.counts.unreadNotifications ?? 0);

  // Global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
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
    { to: "/agents", label: "Agents", icon: <Bot />, badge: runningCount || undefined },
    { to: "/automations", label: "Automations", icon: <Workflow /> },
    { to: "/activity", label: "Activity", icon: <Activity /> },
    { to: "/inbox", label: "Inbox", icon: <Inbox />, badge: inboxCount || undefined },
  ];
  const accessNav: NavItem[] = [
    { to: "/vault/logins", label: "Logins", icon: <KeyRound />, badge: undefined },
    { to: "/vault/2fa", label: "2FA Codes", icon: <ShieldCheck /> },
    { to: "/integrations", label: "Integrations", icon: <Plug /> },
    { to: "/messaging", label: "Messaging", icon: <MessageCircle />, badge: boot?.counts.messagingRequests || undefined },
    { to: "/browser", label: "Browser", icon: <Globe /> },
    { to: "/computer", label: "Computer", icon: <MonitorUp /> },
    { to: "/vms", label: "Virtual machines", icon: <Box /> },
    { to: "/ssh", label: "SSH servers", icon: <Server /> },
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
          <div className="flex items-center justify-between px-1 group-data-[collapsible=icon]:justify-center" data-tauri-drag-region>
            <Link to="/" className="no-drag">
              <Wordmark className="group-data-[collapsible=icon]:[&>div:last-child]:hidden" />
            </Link>
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
          <SidebarGroup>
            <SidebarGroupLabel className="eyebrow text-[10.5px]">Access</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="group-data-[collapsible=icon]:items-center">
                {accessNav.map((item) => (
                  <NavMenuItem key={item.to} item={item} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <RecentChats />
        </SidebarContent>

        <SidebarFooter className="px-3 pb-3">
          <ClaudeUpdateButton />
          <UpdateButton />
          <FooterBar />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="relative h-svh min-h-0 min-w-0 overflow-hidden bg-background">
        <MobileBar attention={inboxCount > 0} />
        <DesktopDragStrip />
        <div ref={setScrollEl} className="@container min-h-0 flex-1 overflow-y-auto">
          <PageScrollContext value={scrollEl}>{children}</PageScrollContext>
        </div>
      </SidebarInset>
      <CommandPalette />
    </SidebarProvider>
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
      <Link to="/" className="no-drag flex items-center gap-2 rounded-md px-1 py-1" aria-label="Godmode home">
        <Logo className="size-6" />
        <span className="text-[15px] font-medium tracking-[-0.02em]">Godmode</span>
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
        <TooltipContent>{connected ? "Connected to Godmode core" : "Connection to core lost — retrying"}</TooltipContent>
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
