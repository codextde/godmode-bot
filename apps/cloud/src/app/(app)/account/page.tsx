import type { Metadata } from "next";
import { CircleUserRound, SunMoon } from "lucide-react";
import { PageBody, PageHeader } from "@/components/page";
import { SettingRow, SettingsGroup } from "@/components/settings-kit";
import { ThemeToggle } from "@/components/theme-toggle";
import { requireUser } from "@/lib/session";
import { listSessions } from "@/server/auth/sessions";
import { getSubscription, LIVE_STATUSES } from "@/server/billing/entitlements";
import { listDevicesFor } from "@/server/devices";
import { isOwner, OWNER_ROLE_ID } from "@/server/rbac/permissions";
import { listUsers } from "@/server/users";
import { DeleteAccount } from "./_components/delete-account";
import { ProfileForm } from "./_components/profile-form";
import { SessionsList } from "./_components/sessions-list";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const ctx = await requireUser();
  const [sessions, devices, subscription, owners] = await Promise.all([
    listSessions(ctx.user.id),
    listDevicesFor(ctx.user.id),
    getSubscription(ctx.user.id),
    isOwner(ctx) ? listUsers({ roleId: OWNER_ROLE_ID, status: "active", pageSize: 1 }) : Promise.resolve(null),
  ]);
  const lastOwner = owners !== null && owners.total <= 1;
  const subscribed = subscription !== null && (LIVE_STATUSES as readonly string[]).includes(subscription.status);

  return (
    <>
      <PageHeader width="form" icon={<CircleUserRound />} title="Account" description="Your profile, where you are signed in, and how this site looks." />
      <PageBody width="form">
        <ProfileForm name={ctx.user.name} email={ctx.user.email} roleName={ctx.role.name} />
        <SessionsList
          sessions={sessions.map((s) => ({
            id: s.id,
            label: s.label,
            ip: s.ip,
            lastSeenAt: s.lastSeenAt.toISOString(),
            createdAt: s.createdAt.toISOString(),
            current: s.id === ctx.session.id,
          }))}
        />
        <SettingsGroup icon={<SunMoon />} title="Appearance" description="Remembered in this browser, also for your computers' dashboards.">
          <SettingRow label="Theme" description="System follows your device.">
            <ThemeToggle />
          </SettingRow>
        </SettingsGroup>
        <DeleteAccount
          email={ctx.user.email}
          lastOwner={lastOwner}
          computers={devices.filter((d) => d.role === "owner").length}
          subscribed={subscribed}
        />
      </PageBody>
    </>
  );
}
