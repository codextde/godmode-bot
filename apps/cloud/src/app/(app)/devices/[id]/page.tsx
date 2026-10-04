import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Info, Laptop, UserRound } from "lucide-react";
import { AutoRefresh } from "@/components/auto-refresh";
import { ChartCard } from "@/components/chart-card";
import { CopyButton } from "@/components/copy-button";
import { PageBody, PageHeader } from "@/components/page";
import { RelativeTime } from "@/components/relative-time";
import {
  Callout,
  InfoRow,
  SettingRow,
  SettingsGroup,
} from "@/components/settings-kit";
import { formatBytes, formatDate } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { getDeviceForUser, getDeviceWithOwner } from "@/server/devices";
import { listDeviceAccess } from "@/server/devices/access";
import { can } from "@/server/rbac/permissions";
import { getSettings } from "@/server/settings";
import { usageSeries } from "@/server/usage";
import { DeviceStatusBadge, OpenDevice } from "../_components/device-card";
import {
  openStates,
  ownerPlans,
  platformLabel,
  ROLE_LABELS,
} from "../_components/device-info";
import {
  DangerZone,
  LeaveButton,
  RenameButton,
} from "./_components/device-controls";
import { PeopleAccess } from "./_components/people-access";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [ctx, { id }] = await Promise.all([requireUser(), params]);
  const access = await getDeviceForUser(id, ctx.user.id);
  return { title: access?.device.name ?? "Computer" };
}

export default async function DevicePage({ params }: Props) {
  const [ctx, { id }] = await Promise.all([requireUser(), params]);
  // Someone else's computer looks exactly like one that does not exist.
  const access = await getDeviceForUser(id, ctx.user.id);
  if (!access) notFound();
  const { device, role } = access;
  const mine = role === "owner";

  const [states, series, people, found, relay, plans] = await Promise.all([
    openStates([access]),
    usageSeries({ deviceId: device.id, days: 30 }),
    mine ? listDeviceAccess(device.id) : Promise.resolve([]),
    mine ? Promise.resolve(null) : getDeviceWithOwner(device.id),
    getSettings("relay"),
    ownerPlans([device.userId]),
  ]);
  const state = states.get(device.id)!;
  const total = series.reduce(
    (sum, day) => sum + day.bytesIn + day.bytesOut,
    0,
  );
  const sharingBlocked = !can(ctx, "devices.share")
    ? "Your role can't share computers. Ask an administrator."
    : !relay.sharing
      ? "Sharing computers is turned off on this cloud."
      : !plans.get(device.userId)?.limits.sharing
        ? "Your plan doesn't include sharing computers. Choose a plan with sharing under Billing."
        : null;
  const allowed =
    role === "operator"
      ? "Everything its owner can do on this computer, including running commands"
      : "Read every chat, file list and agent file";

  return (
    <>
      <AutoRefresh seconds={10} />
      <PageHeader
        back={{ href: "/devices", label: "Computers" }}
        icon={<Laptop />}
        title={device.name}
        badge={<DeviceStatusBadge device={device} state={state} />}
        description={
          mine
            ? "Linked to your account."
            : `Shared with you by ${found?.owner.name?.trim() || found?.owner.email || "its owner"}. It runs under their plan.`
        }
        actions={<OpenDevice deviceId={device.id} state={state} />}
      />
      <PageBody>
        {state.reason && (
          <Callout
            tone={
              state.included && device.status === "active" ? "muted" : "warning"
            }
            title="This computer can't be opened right now"
          >
            <span id={`open-reason-${device.id}`}>{state.reason}</span>
          </Callout>
        )}

        <SettingsGroup
          icon={<Info />}
          title="Details"
          description="As the computer reported them when it last connected."
          actions={
            mine ? (
              <RenameButton deviceId={device.id} name={device.name} />
            ) : undefined
          }
        >
          <InfoRow label="Platform">{platformLabel(device.platform)}</InfoRow>
          <InfoRow label="Godmode version" mono>
            {device.appVersion || "—"}
          </InfoRow>
          <InfoRow label="Last seen">
            {state.online ? (
              "Now"
            ) : (
              <RelativeTime
                date={device.lastSeenAt}
                fallback="Never connected"
              />
            )}
          </InfoRow>
          {mine && device.lastIp && (
            <InfoRow label="Last address" mono>
              {device.lastIp}
            </InfoRow>
          )}
          <InfoRow label="Linked">
            <time
              dateTime={device.createdAt.toISOString()}
              title={formatDate(device.createdAt, "datetime")}
            >
              {formatDate(device.createdAt)}
            </time>
          </InfoRow>
          <InfoRow label="Browser access">
            {device.browserAccess ? "On" : "Off on the computer"}
          </InfoRow>
          <InfoRow label="Phone access">
            {device.phoneAccess ? "On" : "Off on the computer"}
          </InfoRow>
          <InfoRow label="Computer ID" mono>
            {device.id}
            <CopyButton
              value={device.id}
              label="Copy the computer ID"
              iconOnly
              variant="ghost"
            />
          </InfoRow>
        </SettingsGroup>

        <ChartCard
          title="Traffic"
          description="Relayed through this cloud in the last 30 days"
          summary={formatBytes(total)}
          data={series.map((day) => ({
            day: day.day,
            bytesIn: day.bytesIn,
            bytesOut: day.bytesOut,
          }))}
          xKey="day"
          series={[
            { key: "bytesOut", label: "From the computer" },
            { key: "bytesIn", label: "To the computer" },
          ]}
          type="area"
          stacked
          valueFormat="bytes"
          emptyText="Nothing was relayed for this computer in the last 30 days."
        />

        {mine ? (
          <>
            <PeopleAccess
              deviceId={device.id}
              deviceName={device.name}
              people={people.map((p) => ({
                id: p.user.id,
                email: p.user.email,
                name: p.user.name,
                role: p.role,
              }))}
              blocked={sharingBlocked}
            />
            <DangerZone
              device={{
                id: device.id,
                name: device.name,
                status: device.status,
              }}
            />
          </>
        ) : (
          <SettingsGroup
            icon={<UserRound />}
            title="Your access"
            description="Only the owner of this computer can rename, share, turn off or remove it."
          >
            <InfoRow label="Role">{ROLE_LABELS[role]}</InfoRow>
            <InfoRow label="What you can do">{allowed}</InfoRow>
            {found && <InfoRow label="Owner">{found.owner.email}</InfoRow>}
            <SettingRow
              label="Remove from my list"
              description="You lose access until its owner shares it with you again."
            >
              <LeaveButton
                deviceId={device.id}
                deviceName={device.name}
                userId={ctx.user.id}
              />
            </SettingRow>
          </SettingsGroup>
        )}
      </PageBody>
    </>
  );
}
