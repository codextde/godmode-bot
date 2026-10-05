/** What the signed-in person may do to one account. The menus hide the rest; the actions and services check again. */
import type { SessionContext } from "@/lib/session";
import type { Role, User } from "@/server/db";
import { can, canGrantRole, isOwner, OWNER_ROLE_ID } from "@/server/rbac/permissions";

export interface UserCapabilities {
  role: boolean;
  status: boolean;
  signOut: boolean;
  remove: boolean;
  plan: boolean;
}

export interface RoleOption {
  id: string;
  name: string;
  description: string;
}

export interface PlanOption {
  id: string;
  name: string;
}

export function userCapabilities(ctx: SessionContext, target: Pick<User, "id" | "roleId">): UserCapabilities {
  const self = target.id === ctx.user.id;
  // Only an owner may change an owner's account.
  const manage = can(ctx, "users.manage") && (target.roleId !== OWNER_ROLE_ID || isOwner(ctx));
  return {
    role: manage && !self,
    status: manage && !self,
    signOut: manage,
    remove: manage && !self,
    plan: can(ctx, "billing.manage"),
  };
}

/** The roles this person may give to others (the granting rule). */
export function grantableRoles(ctx: SessionContext, roles: Role[]): RoleOption[] {
  return roles.filter((r) => canGrantRole(ctx, r)).map((r) => ({ id: r.id, name: r.name, description: r.description }));
}
