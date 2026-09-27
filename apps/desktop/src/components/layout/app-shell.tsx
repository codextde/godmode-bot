import type { ReactNode } from "react";
import { useEffect } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  CalendarClock,
  Globe,
  Inbox,
  KeyRound,
  Lock,
  MessageSquarePlus,
  MessagesSquare,
  Plug,
  Search,
  Settings,
  ShieldCheck,
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
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Wordmark } from "@/components/brand";
import { LiveDot } from "@/components/aicss/Motion";
import { WorkspaceSwitcher } from "@/components/layout/workspace-switcher";
import { RecentChats } from "@/components/layout/recent-chats";
import { CommandPalette } from "@/components/layout/command-palette";
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
    { to: "/routines", label: "Routines", icon: <CalendarClock /> },
    { to: "/activity", label: "Activity", icon: <Activity /> },
    { to: "/inbox", label: "Inbox", icon: <Inbox />, badge: (boot?.counts.openMissingLogins ?? 0) + (boot?.counts.unreadNotifications ?? 0) || undefined },
  ];
  const accessNav: NavItem[] = [
    { to: "/vault/logins", label: "Logins", icon: <KeyRound />, badge: undefined },
    { to: "/vault/2fa", label: "2FA Codes", icon: <ShieldCheck /> },
    { to: "/integrations", label: "Integrations", icon: <Plug /> },
    { to: "/browser", label: "Browser", icon: <Globe /> },
  ];

  return (
    // Fixed viewport height: pages get a definite `h-full`, so the chat thread scrolls inside itself and the
    // composer stays put (with `min-h-svh` the whole page grew and scrolled the composer away).
    <SidebarProvider open={!collapsed} onOpenChange={(open) => setCollapsed(!open)} className="h-svh min-h-0 overflow-hidden">
      <Sidebar collapsible="icon" variant="sidebar">
        <SidebarHeader className={cn("gap-3 px-3 pt-3", isTauri && isMac && "pt-10")} data-tauri-drag-region>
          <div className="flex items-center justify-between px-1 group-data-[collapsible=icon]:justify-center" data-tauri-drag-region>
            <Link to="/" className="no-drag">
              <Wordmark className="group-data-[collapsible=icon]:[&>div:last-child]:hidden" />
            </Link>
          </div>
          <WorkspaceSwitcher />
          <div className="flex gap-2 group-data-[collapsible=icon]:flex-col">
            <Button
              asChild
              className="h-9 flex-1 justify-start gap-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
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
              <SidebarMenu>
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
              <SidebarMenu>
                {accessNav.map((item) => (
                  <NavMenuItem key={item.to} item={item} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <RecentChats />
        </SidebarContent>

        <SidebarFooter className="px-3 pb-3">
          <FooterBar />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="relative h-svh min-h-0 overflow-hidden bg-background">
        {isTauri && isMac && <div className="absolute inset-x-0 top-0 z-50 h-7" data-tauri-drag-region />}
        <div className="h-full overflow-y-auto">{children}</div>
      </SidebarInset>
      <CommandPalette />
    </SidebarProvider>
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
