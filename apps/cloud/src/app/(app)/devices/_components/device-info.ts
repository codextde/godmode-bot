/** What the Computers pages need to know about each computer: whether it can be opened right now, and why not. */
import type { CloudAccessRole, CloudPlanLimits } from "@godmode/shared";
import { deviceAllowance, getEntitlements } from "@/server/billing/entitlements";
import type { Device } from "@/server/db";
import { relayHub } from "@/server/relay-bridge";
import { getSettings } from "@/server/settings";

const PLATFORMS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** "darwin" → "macOS"; anything unknown is shown as the computer reported it. */
export function platformLabel(platform: string): string {
  return PLATFORMS[platform.toLowerCase()] ?? (platform || "Unknown");
}

export const ROLE_LABELS: Record<CloudAccessRole, string> = { owner: "Owner", operator: "Operator", viewer: "Viewer" };

export interface OpenState {
  online: boolean;
  /** Counted in the owner's plan (over the limit, the oldest computers stay included). */
  included: boolean;
  canOpen: boolean;
  /** One sentence shown next to the disabled Open button. */
  reason: string | null;
}

export interface OwnerPlan {
  limits: CloudPlanLimits;
  allowedDeviceIds: Set<string>;
}

/** Plan limits and included computers of each owner (a shared computer runs under its owner's plan). */
export async function ownerPlans(ownerIds: string[]): Promise<Map<string, OwnerPlan>> {
  const unique = [...new Set(ownerIds)];
  const entries = await Promise.all(
    unique.map(async (id) => {
      const [entitlements, allowance] = await Promise.all([getEntitlements(id), deviceAllowance(id)]);
      return [id, { limits: entitlements.limits, allowedDeviceIds: allowance.allowedDeviceIds }] as const;
    }),
  );
  return new Map(entries);
}

/** The same order of checks as the relay (server/relay/access.ts), so the reason here matches what opening would say. */
export async function openStates(rows: { device: Device; role: CloudAccessRole }[]): Promise<Map<string, OpenState>> {
  const [relay, plans] = await Promise.all([getSettings("relay"), ownerPlans(rows.map((r) => r.device.userId))]);
  const hub = relayHub();
  const out = new Map<string, OpenState>();
  for (const { device, role } of rows) {
    const plan = plans.get(device.userId);
    const mine = role === "owner";
    const online = device.status === "active" && hub.isOnline(device.id);
    const included = plan ? plan.allowedDeviceIds.has(device.id) : true;
    let reason: string | null = null;
    if (!relay.enabled || !relay.browserAccess) reason = "Opening computers in the browser is turned off on this cloud.";
    else if (device.status !== "active") reason = mine ? "Turned off. Turn it on to use it again." : "Its owner turned this computer off.";
    else if (!included) {
      reason = mine
        ? "Not included in your plan. Remove a computer or choose a bigger plan."
        : "Not included in its owner's plan.";
    } else if (plan && !plan.limits.browserAccess) {
      reason = mine ? "Your plan doesn't include opening computers in the browser." : "Its owner's plan doesn't include opening it in the browser.";
    } else if (!mine && (!relay.sharing || (plan && !plan.limits.sharing))) {
      reason = "Sharing is not available for this computer right now. Ask its owner.";
    } else if (!online) reason = "Offline. Start Godmode on that computer to connect it.";
    else if (!device.browserAccess) reason = "Browser access is turned off on this computer. Turn it on in Godmode under Settings → Cloud.";
    out.set(device.id, { online, included, canOpen: reason === null, reason });
  }
  return out;
}
