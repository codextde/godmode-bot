import type { ReactNode } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requestMeta, requirePermission, type SessionContext } from "@/lib/session";
import { countActiveSessions } from "@/server/auth/sessions";
import { previewBillingEnable } from "@/server/billing/entitlements";
import { WEBHOOK_EVENTS } from "@/server/billing/stripe";
import { config } from "@/server/config";
import { lastMailFailure, SES_REGIONS, sesHost } from "@/server/mail";
import { listRoles } from "@/server/rbac";
import { can, canGrantRole, OWNER_ROLE_KEY, SETTINGS_PERMISSIONS, type SettingsPageGroup } from "@/server/rbac/permissions";
import { getSettings } from "@/server/settings";
import { getSystemStatus } from "@/server/system";
import { AuthForm } from "../_components/auth-form";
import { BillingOptionsForm } from "../_components/billing-form";
import { ChargingCard, StripeCard, WebhookCard } from "../_components/billing-panels";
import { EmailForm } from "../_components/email-form";
import { GeneralForm } from "../_components/general-form";
import { RelayForm } from "../_components/relay-form";
import { SecurityForm } from "../_components/security-form";
import { isSettingsGroup, SETTINGS_GROUP_META } from "../_lib/groups";

export async function generateMetadata({ params }: PageProps<"/admin/settings/[group]">): Promise<Metadata> {
  const { group } = await params;
  return { title: isSettingsGroup(group) ? `${SETTINGS_GROUP_META[group].label} · Settings` : "Settings" };
}

/** One settings group. The permission of the group is checked here and again by every action. */
export default async function SettingsGroupPage({ params }: PageProps<"/admin/settings/[group]">) {
  const { group } = await params;
  if (!isSettingsGroup(group)) notFound();
  const ctx = await requirePermission(SETTINGS_PERMISSIONS[group]);
  const sections: Record<SettingsPageGroup, () => Promise<ReactNode>> = {
    general: generalSection,
    auth: () => authSection(ctx),
    email: () => emailSection(ctx),
    billing: () => billingSection(ctx),
    relay: relaySection,
    security: () => securitySection(ctx),
  };
  return sections[group]();
}

async function generalSection() {
  return <GeneralForm initial={await getSettings("general")} />;
}

async function authSection(ctx: SessionContext) {
  const [auth, roles] = await Promise.all([getSettings("auth"), listRoles()]);
  // People who sign up on their own never get admin access, and only a role the saver could grant.
  const choices = roles
    .filter((role) => role.key !== OWNER_ROLE_KEY && !role.permissions.includes("admin.access") && canGrantRole(ctx, role))
    .map((role) => ({ key: role.key, name: role.name }));
  return <AuthForm initial={auth} roles={choices} />;
}

async function emailSection(ctx: SessionContext) {
  const [email, general] = await Promise.all([getSettings("email"), getSettings("general")]);
  const { passwordSet, ...settings } = email;
  return (
    <EmailForm
      initial={settings}
      passwordSet={passwordSet}
      regions={SES_REGIONS.map((region) => ({ region, host: sesHost(region) }))}
      defaultRegion="eu-central-1"
      testTo={ctx.user.email}
      appName={general.appName}
      lastFailure={lastMailFailure()}
    />
  );
}

async function billingSection(ctx: SessionContext) {
  const [billing, general, preview, system] = await Promise.all([getSettings("billing"), getSettings("general"), previewBillingEnable(), getSystemStatus()]);
  const { stripeSecretKeySet, webhookSecretSet, ...settings } = billing;
  return (
    <div className="flex flex-col gap-5">
      <ChargingCard enabled={settings.enabled} connected={stripeSecretKeySet} webhookReady={webhookSecretSet} preview={preview} />
      <StripeCard keySet={stripeSecretKeySet} accountName={settings.stripeAccountName} livemode={settings.livemode} />
      <WebhookCard
        connected={stripeSecretKeySet}
        endpointId={settings.webhookEndpointId}
        secretSet={webhookSecretSet}
        url={`${config().publicUrl}/api/stripe/webhook`}
        events={[...WEBHOOK_EVENTS]}
        lastEventAt={system.stripe.lastEventAt}
      />
      <BillingOptionsForm initial={settings} termsUrl={general.termsUrl} canEditGeneral={can(ctx, SETTINGS_PERMISSIONS.general)} />
    </div>
  );
}

async function relaySection() {
  return <RelayForm initial={await getSettings("relay")} />;
}

async function securitySection(ctx: SessionContext) {
  const [security, sessions] = await Promise.all([getSettings("security"), countActiveSessions()]);
  return <SecurityForm initial={security} activeSessions={sessions} requestIp={ctx.ip ?? (await requestMeta()).ip} />;
}
