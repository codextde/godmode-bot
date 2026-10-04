import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { Activity, CreditCard, Laptop, LayoutDashboard, ScrollText, ServerCog, Users } from "lucide-react";
import { ChartCard } from "@/components/chart-card";
import { StatCard, StatGrid, StatusBadge } from "@/components/data-display";
import { PageBody, PageHeader } from "@/components/page";
import { RelativeTime } from "@/components/relative-time";
import { Callout, InfoRow, SettingsGroup } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { formatBytes, formatMoney, formatNumber } from "@/lib/format";
import { requirePermission } from "@/lib/session";
import { AUDIT_ACTIONS, listAudit } from "@/server/audit";
import { billingEnabled } from "@/server/billing/entitlements";
import { revenueSummary } from "@/server/billing/subscriptions";
import { adminListDevices } from "@/server/devices";
import { can, isOwner, PAGE_PERMISSIONS } from "@/server/rbac/permissions";
import { relayHub } from "@/server/relay-bridge";
import { getSettings } from "@/server/settings";
import { publicUrlCheck } from "@/server/setup";
import { getSystemStatus } from "@/server/system";
import { usageSeries } from "@/server/usage";
import { countUsers, signupSeries } from "@/server/users";
import { SetupChecklist, type ChecklistItem } from "./_components/setup-checklist";

export const metadata: Metadata = { title: "Overview" };

const ACTION_LABELS = new Map<string, string>(AUDIT_ACTIONS.map((a) => [a.action, a.label]));
const DAYS = 30;

export default async function AdminOverviewPage() {
  const ctx = await requirePermission(PAGE_PERMISSIONS["/admin"]);
  const seePeople = can(ctx, "users.read");
  const seeComputers = can(ctx, "devices.read");
  const seeBilling = can(ctx, "billing.read");
  const seeAudit = can(ctx, "audit.read");

  const [urlCheck, system, setup, email, billing, billingOn] = await Promise.all([
    publicUrlCheck(await headers()),
    getSystemStatus(),
    getSettings("setup"),
    getSettings("email"),
    getSettings("billing"),
    billingEnabled(),
  ]);
  const [people, signups, computers, usage, revenue, recent] = await Promise.all([
    seePeople ? countUsers() : null,
    seePeople ? signupSeries(DAYS) : null,
    seeComputers ? adminListDevices({ pageSize: 1 }) : null,
    seeComputers ? usageSeries({ days: DAYS }) : null,
    seeBilling && billingOn ? revenueSummary() : null,
    seeAudit ? listAudit({ pageSize: 8 }) : null,
  ]);

  const online = relayHub().online().length;
  const newPeople = signups?.reduce((sum, d) => sum + d.count, 0) ?? 0;
  const today = usage?.[usage.length - 1];
  const trafficToday = today ? today.bytesIn + today.bytesOut : 0;
  const trafficMonth = usage?.reduce((sum, d) => sum + d.bytesIn + d.bytesOut, 0) ?? 0;

  // Setup steps that were skipped or never finished, each with the page that finishes it (only ones this person may open).
  const checklist: ChecklistItem[] = [
    {
      id: "url",
      title: "Set the public address",
      description: `No DOMAIN is configured, so the cloud guesses ${system.publicUrl}. Set it in the deployment's environment.`,
      done: system.publicUrlConfigured,
      href: null,
    },
    {
      id: "email",
      title: "Set up e-mail delivery",
      description: "Sign-in links and invitations are written to the server log until an SMTP server is configured.",
      done: email.transport === "smtp" || (setup.emailDone && email.transport !== "log"),
      href: can(ctx, PAGE_PERMISSIONS["/admin/settings/email"]) ? "/admin/settings/email" : null,
      cta: "E-mail settings",
    },
    {
      id: "access",
      title: "Decide who can sign in",
      description: "Invite-only, allowed domains and the default role were not reviewed during setup.",
      done: setup.accessDone,
      href: can(ctx, PAGE_PERMISSIONS["/admin/settings/auth"]) ? "/admin/settings/auth" : null,
      cta: "Sign-in settings",
    },
    {
      id: "billing",
      title: "Connect Stripe",
      description: "Without Stripe every account has everything. Connect it to sell plans.",
      done: billing.stripeSecretKeySet,
      optional: true,
      href: can(ctx, PAGE_PERMISSIONS["/admin/settings/billing"]) ? "/admin/settings/billing" : null,
      cta: "Billing settings",
    },
  ].filter((item) => item.done || item.href !== null || item.id === "url");
  const showChecklist = checklist.some((item) => !item.done && !item.optional);

  const localhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(system.publicUrl);

  return (
    <>
      <PageHeader title="Overview" description="How this cloud is doing today." icon={<LayoutDashboard />} />
      <PageBody>
        {!urlCheck.ok && (
          <Callout tone="danger" title={`You opened this site at ${urlCheck.requestOrigin}, but it is configured as ${urlCheck.publicUrl}`}>
            Sign-in and links only work at the configured address. Open the cloud at{" "}
            <a href={urlCheck.publicUrl}>{urlCheck.publicUrl}</a>, or change DOMAIN in the deployment if that address is wrong.
          </Callout>
        )}
        {urlCheck.ok && !urlCheck.https && !localhost && (
          <Callout tone="warning" title="This cloud is not served over https">
            Sign-in cookies are sent in the clear and the relay cannot be used from phones. Put it behind a proxy with a certificate.
          </Callout>
        )}

        <StatGrid>
          {people !== null && (
            <StatCard
              label="People"
              value={formatNumber(people)}
              icon={<Users />}
              hint={newPeople > 0 ? `${formatNumber(newPeople)} new in ${DAYS} days` : `No one new in ${DAYS} days`}
              href="/admin/users"
            />
          )}
          {computers && (
            <StatCard
              label="Computers online"
              value={
                <>
                  {formatNumber(Math.min(online, computers.total))}
                  <span className="text-muted-foreground"> / {formatNumber(computers.total)}</span>
                </>
              }
              icon={<Laptop />}
              hint={computers.total === 1 ? "1 computer linked" : `${formatNumber(computers.total)} computers linked`}
              href="/admin/devices"
            />
          )}
          {seeBilling &&
            (revenue ? (
              <StatCard
                label="Active subscriptions"
                value={formatNumber(revenue.active + revenue.trialing)}
                icon={<CreditCard />}
                hint={
                  <>
                    <span className="font-mono tabular-nums">{formatMoney(revenue.mrr, revenue.currency)}</span> a month
                    {revenue.pastDue > 0 ? ` · ${revenue.pastDue} past due` : ""}
                  </>
                }
                href="/admin/billing"
              />
            ) : (
              <StatCard label="Billing" value="Off" icon={<CreditCard />} hint="Everyone has everything" href="/admin/billing" />
            ))}
          {usage && (
            <StatCard
              label="Relay traffic today"
              value={formatBytes(trafficToday)}
              icon={<Activity />}
              mono
              hint={`${formatNumber(today?.requests ?? 0)} requests · ${formatBytes(trafficMonth)} in ${DAYS} days`}
            />
          )}
        </StatGrid>

        {(signups || usage) && (
          <div className="grid grid-cols-1 gap-3 @4xl:grid-cols-2">
            {signups && (
              <ChartCard
                title="New people"
                description={`Last ${DAYS} days`}
                summary={formatNumber(newPeople)}
                type="bar"
                data={signups}
                xKey="day"
                series={[{ key: "count", label: "New accounts" }]}
                emptyText="Nobody joined in this period."
              />
            )}
            {usage && (
              <ChartCard
                title="Relay traffic"
                description={`Last ${DAYS} days`}
                summary={formatBytes(trafficMonth)}
                type="area"
                stacked
                valueFormat="bytes"
                data={usage}
                xKey="day"
                series={[
                  { key: "bytesIn", label: "To computers" },
                  { key: "bytesOut", label: "From computers" },
                ]}
                emptyText="Nothing was relayed in this period."
              />
            )}
          </div>
        )}

        <div className="grid grid-cols-1 items-start gap-5 @4xl:grid-cols-2">
          {showChecklist && <SetupChecklist items={checklist} />}
          <SettingsGroup title="System" description="The parts this cloud depends on." icon={<ServerCog />}>
            <InfoRow label="Version" mono>
              {system.version}
            </InfoRow>
            <InfoRow label="Address" mono>
              {system.publicUrl}
              {!system.publicUrlConfigured && <span className="font-sans text-xs text-muted-foreground">(guessed)</span>}
            </InfoRow>
            <InfoRow label="Database">
              {system.database ? <StatusBadge tone="positive">Connected</StatusBadge> : <StatusBadge tone="danger">Unreachable</StatusBadge>}
            </InfoRow>
            <InfoRow label="E-mail">
              {system.email.transport === "smtp" ? (
                system.email.lastFailure ? (
                  <StatusBadge tone="warning">Last send failed</StatusBadge>
                ) : (
                  <StatusBadge tone="positive">SMTP</StatusBadge>
                )
              ) : (
                <StatusBadge tone="warning">Server log only</StatusBadge>
              )}
            </InfoRow>
            {system.email.lastFailure && (
              <InfoRow label="Last e-mail failure">
                <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {system.email.lastFailure.error} · <RelativeTime date={system.email.lastFailure.at} />
                </span>
              </InfoRow>
            )}
            <InfoRow label="Stripe">
              {system.stripe.connected ? (
                <>
                  <StatusBadge tone="positive">Connected</StatusBadge>
                  {system.stripe.livemode !== null && (
                    <StatusBadge tone={system.stripe.livemode ? "info" : "neutral"} dot={false}>
                      {system.stripe.livemode ? "Live" : "Test"}
                    </StatusBadge>
                  )}
                </>
              ) : (
                <StatusBadge tone="neutral">Not connected</StatusBadge>
              )}
            </InfoRow>
            {system.stripe.connected && (
              <InfoRow label="Last Stripe event">
                <RelativeTime date={system.stripe.lastEventAt} fallback="None yet" />
              </InfoRow>
            )}
            <InfoRow label="Dashboard build">
              {system.uiBuild ? <StatusBadge tone="positive">Present</StatusBadge> : <StatusBadge tone="danger">Missing</StatusBadge>}
            </InfoRow>
            <InfoRow label="Relay" mono>
              {formatNumber(system.relay.links)} {system.relay.links === 1 ? "link" : "links"} · {formatNumber(system.relay.streams)}{" "}
              {system.relay.streams === 1 ? "stream" : "streams"}
            </InfoRow>
            {isOwner(ctx) && !billingOn && billing.stripeSecretKeySet && (
              <InfoRow label="Billing">
                Stripe is connected but billing is off
                <Link href="/admin/settings/billing" className="font-medium underline-offset-4 hover:underline">
                  Turn on
                </Link>
              </InfoRow>
            )}
          </SettingsGroup>
        </div>

        {recent && (
          <SettingsGroup
            title="Recent activity"
            description="The latest entries of the audit log."
            icon={<ScrollText />}
            actions={
              <Button variant="outline" size="sm" asChild>
                <Link href="/admin/audit">Audit log</Link>
              </Button>
            }
          >
            {recent.rows.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">Nothing has been recorded yet.</p>
            ) : (
              recent.rows.map((entry) => (
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
