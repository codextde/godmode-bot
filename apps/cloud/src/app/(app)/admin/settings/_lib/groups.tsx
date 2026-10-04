import type { ReactNode } from "react";
import { CreditCard, KeyRound, Mail, Radio, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { SETTINGS_PERMISSIONS, type SettingsPageGroup } from "@/server/rbac/permissions";

/** Name, one sentence and icon of every settings group, in menu order (the order of SETTINGS_PERMISSIONS). */
export const SETTINGS_GROUP_META: Record<SettingsPageGroup, { label: string; description: string; icon: ReactNode }> = {
  general: { label: "General", description: "Name, contact and legal links, and the announcement bar.", icon: <SlidersHorizontal /> },
  auth: { label: "Sign-in & access", description: "Who can sign in, and how long sign-ins and invitations last.", icon: <KeyRound /> },
  email: { label: "E-mail", description: "How sign-in links and invitations are delivered.", icon: <Mail /> },
  billing: { label: "Billing", description: "Stripe, the webhook and what checkout asks for.", icon: <CreditCard /> },
  relay: { label: "Relay", description: "How linked computers are reached through this cloud.", icon: <Radio /> },
  security: { label: "Security", description: "Sign-in limits, the audit log, the proxy in front and active sign-ins.", icon: <ShieldCheck /> },
};

export function isSettingsGroup(value: string): value is SettingsPageGroup {
  return Object.hasOwn(SETTINGS_PERMISSIONS, value);
}

export function settingsHref(group: SettingsPageGroup): string {
  return `/admin/settings/${group}`;
}
