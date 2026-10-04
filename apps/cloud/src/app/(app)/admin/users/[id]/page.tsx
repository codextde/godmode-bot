import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CreditCard, Laptop, MonitorSmartphone, ScrollText, UserRound } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { StatusBadge, StatusDot } from "@/components/data-display";
import { PageBody, PageHeader } from "@/components/page";
import { RelativeTime } from "@/components/relative-time";
import { InfoRow, SettingsGroup } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { formatDate, formatMoney } from "@/lib/format";
import { requirePermission } from "@/lib/session";
import { AUDIT_ACTIONS, listAudit } from "@/server/audit";
import { listSessions } from "@/server/auth/sessions";
import { adminListDevices } from "@/server/devices";
import { listRoles } from "@/server/rbac";
import { can, PAGE_PERMISSIONS } from "@/server/rbac/permissions";
import { relayHub } from "@/server/relay-bridge";
import { getUser } from "@/server/users";
import { RevokeSessionButton } from "../_components/revoke-session-button";
import { UserActions } from "../_components/user-actions";
import { grantableRoles, userCapabilities } from "../capabilities";
import { actionsTarget, givablePlans, plansOf, SOURCE_LABEL } from "../data";

export const metadata: Metadata = { title: "Person" };

const ACTION_LABELS = new Map<string, string>(AUDIT_ACTIONS.map((a) => [a.action, a.label]));

const SUBSCRIPTION_STATUS: Record<string, { label: string; tone: "positive" | "neutral" | "warning" | "danger" }> = {
  active: { label: "Active", tone: "positive" },
  trialing: { label: "Trial", tone: "positive" },
  past_due: { label: "Past due", tone: "warning" },
  canceled: { label: "Ended", tone: "neutral" },
  unpaid: { label: "Unpaid", tone: "danger" },
  incomplete: { label: "Incomplete", tone: "warning" },
  paused: { label: "Paused", tone: "neutral" },
};

export default async function PersonPage({ params }: PageProps<"/admin/users/[id]">) {
  const ctx = await requirePermission(PAGE_PERMISSIONS["/admin/users"]);
  const { id } = await params;
  const user = await getUser(id);
  if (!user) notFound();

  const caps = userCapabilities(ctx, user);
  const seeComputers = can(ctx, "devices.read");
  const seeBilling = can(ctx, "billing.read");
  const seeAudit = can(ctx, "audit.read");
  const [sessions, roles, plans, computers, activity, { billingOn, byUser }] = await Promise.all([
    listSessions(user.id),
    listRoles(),
    caps.plan ? givablePlans() : Promise.resolve([]),
    seeComputers ? adminListDevices({ userId: user.id, pageSize: 50 }) : Promise.resolve(null),
    seeAudit ? listAudit({ targetId: user.id, pageSize: 10 }) : Promise.resolve(null),
    plansOf([user.id]),
  ]);
  const entitlements = byUser.get(user.id) ?? null;
  const subscription = entitlements?.subscription ?? null;
  const subscriptionStatus = subscription ? (SUBSCRIPTION_STATUS[subscription.status] ?? { label: subscription.status, tone: "neutral" as const }) : null;
  const givenPlan = user.planOverrideId ? (plans.find((p) => p.id === user.planOverrideId)?.name ?? "A plan") : null;
  const hub = relayHub();
  const self = user.id === ctx.user.id;

  return (
    <>
      <PageHeader
        width="form"
        back={{ href: "/admin/users", label: "People" }}
        title={user.name || user.email}
        description={user.name ? user.email : undefined}
        icon={<UserRound />}
        badge={user.status === "active" ? <StatusBadge tone="neutral">Active</StatusBadge> : <StatusBadge tone="danger">Suspended</StatusBadge>}
        actions={
          <UserActions
            user={actionsTarget(user)}
            caps={caps}
            roles={grantableRoles(ctx, roles)}
            plans={plans}
            billingOn={billingOn}
            variant="button"
            afterDelete="/admin/users"
          />
        }
      />
      <PageBody width="form">
        <SettingsGroup title="Profile" icon={<UserRound />}>
          <InfoRow label="E-mail">
            {user.email}
            <CopyButton value={user.email} label="Copy e-mail address" iconOnly variant="ghost" />
          </InfoRow>
          <InfoRow label="Name">{user.name || <span className="text-muted-foreground">Not set</span>}</InfoRow>
          <InfoRow label="Role">
            {user.role.name}
            {self && <span className="text-muted-foreground">(you)</span>}
          </InfoRow>
          <InfoRow label="Joined">{formatDate(user.createdAt, "date")}</InfoRow>
          <InfoRow label="Last sign-in">
            <RelativeTime date={user.lastLoginAt} />
          </InfoRow>
          <InfoRow label="Account id" mono>
            {user.id}
          </InfoRow>
        </SettingsGroup>

        <SettingsGroup
          title="Signed-in browsers"
          description="Every browser where this account is signed in right now."
          icon={<MonitorSmartphone />}
        >
          {sessions.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">Not signed in anywhere.</p>
          ) : (
            sessions.map((s) => {
              const current = s.id === ctx.session.id;
              const label = s.label || "Unknown browser";
              return (
                <div key={s.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {label}
                      {current && <StatusBadge tone="info" dot={false}>This browser</StatusBadge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {s.ip && <span className="font-mono tabular-nums">{s.ip} · </span>}
                      Active <RelativeTime date={s.lastSeenAt} />
                    </p>
                  </div>
                  {caps.signOut && !current && <RevokeSessionButton userId={user.id} sessionId={s.id} label={label} />}
                </div>
              );
            })
          )}
        </SettingsGroup>

        {computers && (
          <SettingsGroup
            title="Computers"
            description="Linked to this account. Nobody in the admin area can open them."
            icon={<Laptop />}
          >
            {computers.rows.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">No computer is linked to this account.</p>
            ) : (
              computers.rows.map((d) => {
                const online = d.status === "active" && hub.isOnline(d.id);
                return (
                  <div key={d.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
                    <div className="min-w-0 space-y-0.5">
                      <p className="flex items-center gap-2 text-sm font-medium [overflow-wrap:anywhere]">
                        <StatusDot status={online ? "online" : "offline"} />
                        {d.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {[d.platform, d.appVersion && `Godmode ${d.appVersion}`].filter(Boolean).join(" · ") || "No details yet"}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {d.status === "disabled" ? "Turned off" : online ? "Online" : <>Seen <RelativeTime date={d.lastSeenAt} fallback="never" /></>}
                    </span>
                  </div>
                );
              })
            )}
          </SettingsGroup>
        )}

        <SettingsGroup title="Plan" icon={<CreditCard />}>
          <InfoRow label="Current plan">
            {billingOn ? (entitlements?.plan.name ?? "—") : "Unlimited"}
            {billingOn && entitlements && SOURCE_LABEL[entitlements.source] && (
              <span className="text-muted-foreground">· {SOURCE_LABEL[entitlements.source]}</span>
            )}
          </InfoRow>
          {!billingOn && <InfoRow label="Billing">Off — everyone has everything</InfoRow>}
          {givenPlan && (
            <InfoRow label="Given by an admin">
              {givenPlan}
              <span className="text-muted-foreground">
                {user.planOverrideUntil ? `until ${formatDate(user.planOverrideUntil, "date")}` : "without an end date"}
              </span>
            </InfoRow>
          )}
          {seeBilling && subscription && subscriptionStatus && (
            <>
              <InfoRow label="Subscription">
                <StatusBadge tone={subscriptionStatus.tone}>{subscriptionStatus.label}</StatusBadge>
              </InfoRow>
              {subscription.amount !== null && subscription.currency && (
                <InfoRow label="Price" mono>
                  {formatMoney(subscription.amount, subscription.currency)}
                  {subscription.interval ? ` / ${subscription.interval}` : ""}
                </InfoRow>
              )}
              {subscription.currentPeriodEnd && (
                <InfoRow label={subscription.cancelAtPeriodEnd ? "Ends" : "Renews"}>{formatDate(subscription.currentPeriodEnd, "date")}</InfoRow>
              )}
            </>
          )}
          {seeBilling && billingOn && !subscription && <InfoRow label="Subscription">None</InfoRow>}
        </SettingsGroup>

        {activity && (
          <SettingsGroup
            title="Recent activity"
            description="The latest audit entries about this account."
            icon={<ScrollText />}
            actions={
              activity.total > 0 && (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/admin/audit?q=${encodeURIComponent(user.id)}`}>View all</Link>
                </Button>
              )
            }
          >
            {activity.rows.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">Nothing has been recorded about this account yet.</p>
            ) : (
              activity.rows.map((entry) => (
                <div key={entry.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-3 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium">{ACTION_LABELS.get(entry.action) ?? entry.action}</span>{" "}
                    <span className="text-muted-foreground [overflow-wrap:anywhere]">by {entry.actor}</span>
                  </div>
                  <RelativeTime date={entry.at} className="text-xs text-muted-foreground" />
                </div>
              ))
            )}
          </SettingsGroup>
        )}
      </PageBody>
    </>
  );
}
