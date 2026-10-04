/** Data the People list and a person's page share. */
import { billingEnabled, getEntitlements, type Entitlements } from "@/server/billing/entitlements";
import { listPlans } from "@/server/billing/plans";
import type { User } from "@/server/db";
import type { PlanOption } from "./capabilities";
import type { UserActionsTarget } from "./_components/user-actions";

/** The plans an admin can give: current, paid ones (the free plan is what people have anyway). */
export async function givablePlans(): Promise<PlanOption[]> {
  const plans = await listPlans();
  return plans.filter((p) => !p.isFree).map((p) => ({ id: p.id, name: p.name }));
}

export const SOURCE_LABEL: Record<Entitlements["source"], string | null> = {
  unlimited: null,
  subscription: "Subscription",
  override: "Given by an admin",
  free: null,
};

/** Each person's current plan. With billing off nobody is looked up: everyone has everything. */
export async function plansOf(userIds: string[]): Promise<{ billingOn: boolean; byUser: Map<string, Entitlements> }> {
  const billingOn = await billingEnabled();
  const byUser = new Map<string, Entitlements>();
  if (!billingOn) return { billingOn, byUser };
  const all = await Promise.all(userIds.map((id) => getEntitlements(id)));
  userIds.forEach((id, i) => byUser.set(id, all[i]!));
  return { billingOn, byUser };
}

/** The serialisable part of an account the actions menu needs. */
export function actionsTarget(user: User): UserActionsTarget {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    roleId: user.roleId,
    planOverrideId: user.planOverrideId,
    planOverrideUntil: user.planOverrideUntil ? user.planOverrideUntil.toISOString().slice(0, 10) : null,
  };
}
