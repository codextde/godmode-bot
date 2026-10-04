import type { ReactNode } from "react";
import {
  CircleUserRound,
  CreditCard,
  LayoutDashboard,
  Laptop,
  MailPlus,
  MonitorSmartphone,
  Receipt,
  ScrollText,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import { PAGE_PERMISSIONS, type PagePermission } from "@/server/rbac/permissions";

/*
 * Navigation model shared by the server layout (which computes it) and the client AppShell (which draws it).
 * No "use client" here: buildNav runs on the server and its icons travel to the shell as rendered elements.
 */

export interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /** Path prefix that marks the item active when it differs from `href` (Settings → /admin/settings/…). */
  match?: string;
  /** Active only on exactly this path (Overview at /admin). */
  exact?: boolean;
  /** A count shown at the end of the row. */
  badge?: number | string;
}

export interface NavGroup {
  id: string;
  /** Eyebrow above the group; null for none. */
  label: string | null;
  items: NavItem[];
}

/** Cookie holding the desktop sidebar choice ("collapsed" | "expanded"); the layout may read it for `sidebarCollapsed`. */
export const SIDEBAR_COOKIE = "gmc_sidebar";

/** Settings pages in menu order (the nav's Settings entry opens the first one the person may edit). */
const SETTINGS_PAGES = [
  "/admin/settings/general",
  "/admin/settings/auth",
  "/admin/settings/email",
  "/admin/settings/billing",
  "/admin/settings/relay",
  "/admin/settings/security",
] as const;

/**
 * The sidebar groups for one person: Workspace (Computers, Billing, Account) and, with `admin.access`, Admin
 * (Overview, People, Invites, Roles, Computers, Billing, Audit log, Settings) filtered by PAGE_PERMISSIONS.
 * `permissions` are the role's keys; owners pass `isOwner` (they hold everything, including "owner" pages).
 */
export function buildNav({ permissions, isOwner }: { permissions: readonly string[]; isOwner: boolean }): NavGroup[] {
  const has = (p: PagePermission) => isOwner || (p !== "owner" && permissions.includes(p));
  const page = (path: keyof typeof PAGE_PERMISSIONS) => has(PAGE_PERMISSIONS[path]);

  const workspace: NavItem[] = [
    { href: "/devices", label: "Computers", icon: <Laptop /> },
    ...(has("billing.self") ? [{ href: "/billing", label: "Billing", icon: <CreditCard /> }] : []),
    { href: "/account", label: "Account", icon: <CircleUserRound /> },
  ];

  const groups: NavGroup[] = [{ id: "workspace", label: "Workspace", items: workspace }];
  if (!page("/admin")) return groups;

  const settings = SETTINGS_PAGES.find((p) => page(p));
  const admin: NavItem[] = [
    { href: "/admin", label: "Overview", icon: <LayoutDashboard />, exact: true },
    ...(page("/admin/users") ? [{ href: "/admin/users", label: "People", icon: <Users /> }] : []),
    ...(page("/admin/invites") ? [{ href: "/admin/invites", label: "Invites", icon: <MailPlus /> }] : []),
    ...(page("/admin/roles") ? [{ href: "/admin/roles", label: "Roles", icon: <ShieldCheck /> }] : []),
    ...(page("/admin/devices") ? [{ href: "/admin/devices", label: "Computers", icon: <MonitorSmartphone /> }] : []),
    ...(page("/admin/billing") ? [{ href: "/admin/billing", label: "Billing", icon: <Receipt /> }] : []),
    ...(page("/admin/audit") ? [{ href: "/admin/audit", label: "Audit log", icon: <ScrollText /> }] : []),
    ...(settings ? [{ href: settings, label: "Settings", icon: <Settings />, match: "/admin/settings" }] : []),
  ];
  groups.push({ id: "admin", label: "Admin", items: admin });
  return groups;
}

/** The nav item for `pathname`: exact items match only themselves, others their prefix; the longest prefix wins. */
export function activeNavItem(groups: NavGroup[], pathname: string): NavItem | null {
  let best: NavItem | null = null;
  let bestLength = -1;
  for (const item of groups.flatMap((g) => g.items)) {
    const prefix = item.match ?? item.href;
    const hit = item.exact ? pathname === item.href : pathname === prefix || pathname.startsWith(`${prefix}/`);
    if (hit && prefix.length > bestLength) {
      best = item;
      bestLength = prefix.length;
    }
  }
  return best;
}
