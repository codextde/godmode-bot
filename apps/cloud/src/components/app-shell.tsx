"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeft, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { Brand, Logo } from "@/components/brand";
import { CommandPalette, type CommandEntry } from "@/components/command-palette";
import { activeNavItem, SIDEBAR_COOKIE, type NavGroup, type NavItem } from "@/components/nav";
import { AnnouncementBar, EmailNoticeBar, LegalLinks, type Announcement, type LegalInfo } from "@/components/shell-parts";
import { UserMenu, type ShellUser } from "@/components/user-menu";
import { Button } from "@/components/ui/button";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

const noSubscribe = () => () => {};

/** "⌘" on Apple devices, "Ctrl " elsewhere (the server and the hydration pass say "⌘"). */
function useModKey() {
  return useSyncExternalStore(
    noSubscribe,
    () => (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘" : "Ctrl "),
    () => "⌘",
  );
}

function readSidebarCookie(): boolean | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${SIDEBAR_COOKIE}=(collapsed|expanded)`));
  return match ? match[1] === "collapsed" : null;
}

/**
 * The signed-in frame (house rule 2), the same as the Godmode desktop app:
 * ≥ 1024 px a 16 rem sidebar that collapses to a 3 rem rail (Cmd/Ctrl+B, remembered in a cookie);
 * 768–1023 px an icon rail whose expansion is a temporary peek; < 768 px a left sheet plus a 48 px top bar
 * (menu, logo, page title, search, account) that closes on navigation. The page scrolls inside <main>, which is
 * the `@container` every page's container queries refer to.
 */
export function AppShell({
  user,
  nav,
  legal,
  announcement,
  emailNotice,
  onSignOut,
  commands = [],
  appName,
  sidebarCollapsed,
  children,
}: {
  user: ShellUser;
  /** From buildNav(). */
  nav: NavGroup[];
  legal: LegalInfo;
  announcement: Announcement | null;
  /** Show the "E-mail delivery is not set up" bar (people who may edit e-mail settings, transport "log"). */
  emailNotice: boolean;
  /** The logout server action. */
  onSignOut: () => Promise<void>;
  /** Extra palette entries, e.g. the person's computers ({ group: "Computers", href: "/d/<id>/" }). */
  commands?: CommandEntry[];
  /** general.appName; defaults to "Godmode Cloud". */
  appName?: string;
  /** The remembered desktop choice; pass `cookies().get(SIDEBAR_COOKIE)?.value === "collapsed"` to avoid a flash. */
  sidebarCollapsed?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const compact = useMediaQuery("(min-width: 768px) and (max-width: 1023px)");
  const [collapsed, setCollapsed] = useState(sidebarCollapsed ?? false);
  const [peek, setPeek] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    if (sidebarCollapsed !== undefined) return;
    const remembered = readSidebarCookie();
    if (remembered !== null) setCollapsed(remembered);
  }, [sidebarCollapsed]);

  // A peek on the tablet rail folds back when the page changes or the window crosses a breakpoint.
  useEffect(() => setPeek(false), [compact, pathname]);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (compact) {
        setPeek(open);
        return;
      }
      setCollapsed(!open);
      document.cookie = `${SIDEBAR_COOKIE}=${open ? "expanded" : "collapsed"}; path=/; max-age=31536000; samesite=lax`;
    },
    [compact],
  );

  const active = activeNavItem(nav, pathname);
  const entries = useMemo<CommandEntry[]>(
    () => [
      ...nav.flatMap((group) =>
        group.items.map((item) => ({
          id: `nav:${item.href}`,
          label: item.label,
          group: group.label ?? "Pages",
          href: item.href,
          icon: item.icon,
          keywords: group.label ? [group.label] : undefined,
        })),
      ),
      ...commands,
    ],
    [nav, commands],
  );
  const accountLinks = nav
    .flatMap((g) => g.items)
    .filter((item) => item.href === "/account" || item.href === "/billing")
    .map((item) => ({ href: item.href, label: item.label, icon: item.icon }));

  return (
    <SidebarProvider open={compact ? peek : !collapsed} onOpenChange={onOpenChange} className="h-svh min-h-0 overflow-hidden">
      <a
        href="#main"
        className="sr-only z-[60] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>

      <Sidebar collapsible="icon" variant="sidebar">
        <SidebarHeader className="gap-3 px-3 pt-3 group-data-[collapsible=icon]:items-center">
          <div className="relative flex items-center justify-between gap-2 px-1 group-data-[collapsible=icon]:justify-center">
            <Link
              href="/"
              aria-label={`${appName ?? "Godmode Cloud"} home`}
              className="min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            >
              <Brand appName={appName} className="group-data-[collapsible=icon]:[&>div:last-child]:hidden" />
            </Link>
            <SidebarToggle />
          </div>
          <SearchButton onOpen={() => setPaletteOpen(true)} />
        </SidebarHeader>

        <SidebarContent>
          {nav.map((group) => (
            <SidebarGroup key={group.id}>
              {group.label && <SidebarGroupLabel className="eyebrow text-[10.5px]">{group.label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu className="group-data-[collapsible=icon]:items-center">
                  {group.items.map((item) => (
                    <NavMenuItem key={item.href} item={item} active={active === item} />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>

        <SidebarFooter className="gap-2.5 px-3 pb-3">
          <div className="rounded-lg border bg-card p-1 shadow-card group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:shadow-none">
            <UserMenu user={user} onSignOut={onSignOut} links={accountLinks} />
          </div>
          <LegalLinks legal={legal} className="px-1.5 group-data-[collapsible=icon]:hidden" />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="relative h-svh min-h-0 min-w-0 overflow-hidden">
        <MobileBar
          title={active?.label ?? appName ?? "Godmode Cloud"}
          user={user}
          onSignOut={onSignOut}
          accountLinks={accountLinks}
          onSearch={() => setPaletteOpen(true)}
        />
        {announcement && announcement.text.trim() && <AnnouncementBar announcement={announcement} />}
        {emailNotice && <EmailNoticeBar />}
        <main id="main" tabIndex={-1} className="@container min-h-0 flex-1 overflow-y-auto outline-none">
          {children}
        </main>
      </SidebarInset>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} entries={entries} onSignOut={onSignOut} />
    </SidebarProvider>
  );
}

function SearchButton({ onOpen }: { onOpen: () => void }) {
  const { state, isMobile } = useSidebar();
  const mod = useModKey();
  const rail = state === "collapsed" && !isMobile;
  const button = (
    <Button
      variant="outline"
      onClick={onOpen}
      aria-label="Search and go to"
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        "h-9 w-full justify-start gap-2 px-2.5 font-normal text-muted-foreground shadow-none hover:text-foreground",
        "group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0 pointer-coarse:group-data-[collapsible=icon]:size-11",
      )}
    >
      <Search className="size-4" />
      <span className="group-data-[collapsible=icon]:hidden">Search…</span>
      <kbd className="ml-auto hidden font-mono text-[10px] tracking-wide opacity-70 group-data-[collapsible=icon]:hidden pointer-fine:inline">
        {mod}K
      </kbd>
    </Button>
  );
  if (!rail) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">Search ({mod}K)</TooltipContent>
    </Tooltip>
  );
}

function SidebarToggle() {
  const { open, isMobile, toggleSidebar } = useSidebar();
  const mod = useModKey();
  const expanded = isMobile || open;
  const label = isMobile ? "Close navigation" : expanded ? "Collapse sidebar" : "Expand sidebar";
  const Icon = expanded ? PanelLeftClose : PanelLeftOpen;
  const button = (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn(
        "size-7 shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:size-11",
        // The rail has no room for another row: the button takes the logo's place while the rail is hovered or focused.
        !expanded &&
          "absolute top-1/2 left-1/2 -translate-1/2 bg-sidebar opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
      )}
      aria-label={label}
      aria-keyshortcuts="Meta+B Control+B"
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
        {label} ({mod}B)
      </TooltipContent>
    </Tooltip>
  );
}

function MobileBar({
  title,
  user,
  onSignOut,
  accountLinks,
  onSearch,
}: {
  title: string;
  user: ShellUser;
  onSignOut: () => Promise<void>;
  accountLinks: { href: string; label: string; icon?: ReactNode }[];
  onSearch: () => void;
}) {
  const { openMobile, setOpenMobile } = useSidebar();
  const pathname = usePathname();
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);
  return (
    // Rendered on every width and hidden by CSS from md, so phones never see it pop in after hydration.
    <header className="z-30 flex h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 border-b bg-background/85 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-md md:hidden">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open navigation"
        aria-haspopup="dialog"
        aria-expanded={openMobile}
        onClick={() => setOpenMobile(true)}
      >
        <PanelLeft className="size-[18px]" />
      </Button>
      <Link href="/" aria-label="Home" className="grid shrink-0 place-items-center rounded-md p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        <Logo className="size-6" />
      </Link>
      <p className="min-w-0 flex-1 truncate px-1.5 text-[15px] font-medium tracking-[-0.02em]">{title}</p>
      <Button variant="ghost" size="icon" aria-label="Search and go to" onClick={onSearch}>
        <Search className="size-[18px]" />
      </Button>
      <UserMenu user={user} onSignOut={onSignOut} links={accountLinks} variant="avatar" />
    </header>
  );
}

function NavMenuItem({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={item.label}
        className="h-8 gap-2.5 text-[13.5px] text-sidebar-foreground/85 pointer-coarse:h-11 pointer-coarse:group-data-[collapsible=icon]:size-11! pointer-coarse:group-data-[collapsible=icon]:p-3.5! [&>svg]:size-4 [&>svg]:text-muted-foreground data-[active=true]:bg-card data-[active=true]:font-medium data-[active=true]:text-foreground data-[active=true]:shadow-card data-[active=true]:ring-1 data-[active=true]:ring-border data-[active=true]:[&>svg]:text-foreground"
      >
        <Link href={item.href} aria-current={active ? "page" : undefined}>
          {item.icon}
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
      {item.badge !== undefined && item.badge !== 0 && (
        <SidebarMenuBadge className="rounded-[5px] bg-foreground/[0.07] font-mono text-[10.5px] text-foreground/70 tabular-nums">
          {item.badge}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}
