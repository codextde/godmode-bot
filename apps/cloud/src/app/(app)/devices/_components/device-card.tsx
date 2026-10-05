import type { ReactNode } from "react";
import Link from "next/link";
import type { CloudAccessRole } from "@godmode/shared";
import { ExternalLink, Laptop } from "lucide-react";
import { StatusBadge } from "@/components/data-display";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import type { Device } from "@/server/db";
import { platformLabel, ROLE_LABELS, type OpenState } from "./device-info";
import { DeviceMenu } from "./device-menu";

/** Online / Offline / Turned off, the same wording on the list and the detail page. */
export function DeviceStatusBadge({ device, state }: { device: Pick<Device, "status">; state: OpenState }) {
  if (device.status !== "active") return <StatusBadge tone="warning">Turned off</StatusBadge>;
  if (state.online) {
    return (
      <StatusBadge tone="positive" live>
        Online
      </StatusBadge>
    );
  }
  return <StatusBadge tone="neutral">Offline</StatusBadge>;
}

/**
 * "Open" leaves the Next app: /d/<id>/ is answered by the custom server, so it is a plain link. When the computer
 * can't be opened the button is disabled and the reason stands next to it.
 */
export function OpenDevice({ deviceId, state, size }: { deviceId: string; state: OpenState; size?: "sm" | "default" }) {
  if (!state.canOpen) {
    return (
      <Button size={size} disabled aria-describedby={`open-reason-${deviceId}`}>
        <ExternalLink />
        Open
      </Button>
    );
  }
  return (
    <Button size={size} asChild>
      <a href={`/d/${deviceId}/`}>
        <ExternalLink />
        Open
      </a>
    </Button>
  );
}

export function DeviceCard({
  device,
  role,
  owner,
  state,
  traffic,
  userId,
  canShare,
}: {
  device: Device;
  role: CloudAccessRole;
  owner: { email: string; name: string | null };
  state: OpenState;
  /** Bytes relayed this month, both directions. */
  traffic: number;
  userId: string;
  canShare: boolean;
}) {
  const mine = role === "owner";
  return (
    <article className="animate-enter flex min-w-0 flex-col rounded-xl border bg-card shadow-card" aria-label={device.name}>
      <div className="flex items-start gap-3 px-5 pt-4">
        <div aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg border bg-paper-2 text-foreground [&_svg]:size-4">
          <Laptop />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] leading-snug font-medium tracking-[-0.01em] [overflow-wrap:anywhere]">
            <Link
              href={`/devices/${device.id}`}
              className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {device.name}
            </Link>
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <DeviceStatusBadge device={device} state={state} />
            {!mine && (
              <StatusBadge tone="info" dot={false}>
                Shared with you · {ROLE_LABELS[role]}
              </StatusBadge>
            )}
          </div>
        </div>
        <div className="-mt-1 -mr-2 shrink-0">
          <DeviceMenu device={{ id: device.id, name: device.name, status: device.status }} owner={mine} userId={userId} canShare={canShare} />
        </div>
      </div>

      <dl className="space-y-1.5 px-5 py-4 text-[13px]">
        <Fact label="Platform">{platformLabel(device.platform)}</Fact>
        <Fact label="Godmode version" mono>
          {device.appVersion || "—"}
        </Fact>
        <Fact label="Last seen">{state.online ? "Now" : <RelativeTime date={device.lastSeenAt} fallback="Never connected" />}</Fact>
        <Fact label="Traffic this month" mono>
          {formatBytes(traffic)}
        </Fact>
        {!mine && <Fact label="Owner">{owner.name?.trim() || owner.email}</Fact>}
      </dl>

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 rounded-b-xl border-t bg-paper-2/60 px-5 py-3">
        <OpenDevice deviceId={device.id} state={state} size="sm" />
        {state.reason && (
          <p id={`open-reason-${device.id}`} className="min-w-0 flex-1 basis-40 text-xs leading-relaxed text-muted-foreground">
            {state.reason}
          </p>
        )}
      </div>
    </article>
  );
}

function Fact({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={mono ? "min-w-0 text-right font-mono text-xs tabular-nums [overflow-wrap:anywhere]" : "min-w-0 text-right [overflow-wrap:anywhere]"}>
        {children}
      </dd>
    </div>
  );
}
