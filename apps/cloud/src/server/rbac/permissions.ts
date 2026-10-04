/**
 * Permissions, system roles and which page needs what. Pure data and pure functions: client components import this
 * file too, so it must never reach the database or Node APIs.
 */

export const PERMISSIONS = [
  { key: "admin.access", label: "Open the admin area", group: "Admin" },
  { key: "users.read", label: "See people", group: "People" },
  { key: "users.manage", label: "Change roles, suspend, delete and sign people out", group: "People" },
  { key: "invites.manage", label: "Invite people, resend and revoke invitations", group: "People" },
  { key: "roles.manage", label: "Create and edit roles", group: "People" },
  { key: "devices.read", label: "See every linked computer (details only)", group: "Computers" },
  { key: "devices.manage", label: "Turn off or remove any computer", group: "Computers" },
  { key: "billing.read", label: "See subscriptions and revenue", group: "Billing" },
  { key: "billing.manage", label: "Edit plans and Stripe, give plans", group: "Billing" },
  { key: "settings.manage", label: "Change the General and Relay settings", group: "Admin" },
  { key: "audit.read", label: "Read the audit log", group: "Admin" },
  { key: "devices.link", label: "Link own computers and use them", group: "Personal" },
  { key: "devices.share", label: "Share own computers with other accounts", group: "Personal" },
  { key: "billing.self", label: "Subscribe, change and cancel the own plan", group: "Personal" },
] as const;

export type Permission = (typeof PERMISSIONS)[number]["key"];

/** "owner" stands for the owner role itself: only owners pass. */
export type PagePermission = Permission | "owner";

export const PERMISSION_KEYS: Permission[] = PERMISSIONS.map((p) => p.key);

export function isPermission(value: string): value is Permission {
  return (PERMISSION_KEYS as string[]).includes(value);
}

export const OWNER_ROLE_KEY = "owner";
export const OWNER_ROLE_ID = "role_owner";

/** What a person may do with their own account. The role open sign-ups get may hold nothing else. */
export const PERSONAL_PERMISSIONS: Permission[] = ["devices.link", "devices.share", "billing.self"];
const PERSONAL = PERSONAL_PERMISSIONS;

/** Seeded by `ensureSystemRoles()`. The owner's list is ignored: owners may do everything. */
export const SYSTEM_ROLES: { id: string; key: string; name: string; description: string; permissions: Permission[] }[] = [
  {
    id: OWNER_ROLE_ID,
    key: OWNER_ROLE_KEY,
    name: "Owner",
    description: "Runs this cloud. Can do everything, including sign-in, e-mail and security settings.",
    permissions: [],
  },
  {
    id: "role_admin",
    key: "admin",
    name: "Admin",
    description: "Manages people, invitations and computers. Cannot edit roles, billing, or sign-in and e-mail settings.",
    permissions: PERMISSION_KEYS.filter((p) => p !== "roles.manage" && p !== "billing.manage"),
  },
  {
    id: "role_billing",
    key: "billing",
    name: "Billing",
    description: "Manages plans, prices and subscriptions.",
    permissions: ["admin.access", "users.read", "billing.read", "billing.manage", ...PERSONAL],
  },
  {
    id: "role_member",
    key: "member",
    name: "Member",
    description: "Links and uses their own computers.",
    permissions: [...PERSONAL],
  },
];

/** Anything with a role: a SessionContext, or just `{ role }`. */
export interface RoleHolder {
  role: { key: string; permissions: readonly string[] };
}

export function isOwner(holder: RoleHolder): boolean {
  return holder.role.key === OWNER_ROLE_KEY;
}

export function can(holder: RoleHolder, permission: PagePermission): boolean {
  if (isOwner(holder)) return true;
  if (permission === "owner") return false;
  return holder.role.permissions.includes(permission);
}

/** The permissions a role really has (owners: all of them). */
export function effectivePermissions(role: { key: string; permissions: readonly string[] }): Permission[] {
  if (role.key === OWNER_ROLE_KEY) return [...PERMISSION_KEYS];
  return PERMISSION_KEYS.filter((p) => role.permissions.includes(p));
}

/**
 * The granting rule: the owner role only by an owner; any other role only by someone who holds every permission of
 * that role. Used for role changes, invitations and the default role of open sign-up.
 */
export function canGrantRole(granter: RoleHolder, role: { key: string; permissions: readonly string[] }): boolean {
  if (role.key === OWNER_ROLE_KEY) return isOwner(granter);
  if (isOwner(granter)) return true;
  return role.permissions.every((p) => granter.role.permissions.includes(p));
}

/** Settings groups shown in the admin area and who may edit each. */
export const SETTINGS_PERMISSIONS = {
  general: "settings.manage",
  auth: "owner",
  email: "owner",
  billing: "billing.manage",
  relay: "settings.manage",
  security: "owner",
} as const satisfies Record<string, PagePermission>;

export type SettingsPageGroup = keyof typeof SETTINGS_PERMISSIONS;

/** What each admin page needs to be opened. Nav and page guards use this; actions check their own permission. */
export const PAGE_PERMISSIONS = {
  "/admin": "admin.access",
  "/admin/users": "users.read",
  "/admin/invites": "invites.manage",
  "/admin/roles": "roles.manage",
  "/admin/devices": "devices.read",
  "/admin/billing": "billing.read",
  "/admin/audit": "audit.read",
  "/admin/settings/general": SETTINGS_PERMISSIONS.general,
  "/admin/settings/relay": SETTINGS_PERMISSIONS.relay,
  "/admin/settings/billing": SETTINGS_PERMISSIONS.billing,
  "/admin/settings/auth": SETTINGS_PERMISSIONS.auth,
  "/admin/settings/email": SETTINGS_PERMISSIONS.email,
  "/admin/settings/security": SETTINGS_PERMISSIONS.security,
} as const satisfies Record<string, PagePermission>;

export type AdminPage = keyof typeof PAGE_PERMISSIONS;

/**
 * The permission of the closest page above `pathname` ("/admin/users/usr_1" → users.read), or null when the path is
 * not an admin page.
 */
export function pagePermission(pathname: string): PagePermission | null {
  const path = pathname.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
  let best: AdminPage | null = null;
  for (const page of Object.keys(PAGE_PERMISSIONS) as AdminPage[]) {
    if ((path === page || path.startsWith(`${page}/`)) && (!best || page.length > best.length)) best = page;
  }
  return best ? PAGE_PERMISSIONS[best] : null;
}

/** Whether `holder` may open the admin page at `pathname`. Paths that are not admin pages are allowed. */
export function canOpenPage(holder: RoleHolder, pathname: string): boolean {
  const needed = pagePermission(pathname);
  return needed === null || can(holder, needed);
}

/** The settings groups `holder` may edit, in menu order. */
export function editableSettingsGroups(holder: RoleHolder): SettingsPageGroup[] {
  return (Object.keys(SETTINGS_PERMISSIONS) as SettingsPageGroup[]).filter((g) => can(holder, SETTINGS_PERMISSIONS[g]));
}
