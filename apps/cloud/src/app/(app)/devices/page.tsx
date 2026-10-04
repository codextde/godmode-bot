import type { Metadata } from "next";
import Link from "next/link";
import { Laptop, Plus } from "lucide-react";
import { AutoRefresh } from "@/components/auto-refresh";
import { EmptyState } from "@/components/empty-state";
import { Mascot } from "@/components/mascot";
import { PageBody, PageHeader } from "@/components/page";
import { Callout } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/session";
import { config } from "@/server/config";
import { listDevicesFor } from "@/server/devices";
import { can } from "@/server/rbac/permissions";
import { getSettings } from "@/server/settings";
import { usageTotals } from "@/server/usage";
import { DeviceCard } from "./_components/device-card";
import { openStates, ownerPlans } from "./_components/device-info";
import { linkSteps } from "./_components/link-steps";

export const metadata: Metadata = { title: "Computers" };

export default async function DevicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [ctx, query] = await Promise.all([requireUser(), searchParams]);
  const rows = await listDevicesFor(ctx.user.id);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [states, traffic, relay, plans] = await Promise.all([
    openStates(rows),
    usageTotals(
      rows.map((r) => r.device.id),
      monthStart,
    ),
    getSettings("relay"),
    ownerPlans([ctx.user.id]),
  ]);
  const mayLink = can(ctx, "devices.link");
  const canShare = can(ctx, "devices.share") && relay.sharing && Boolean(plans.get(ctx.user.id)?.limits.sharing);
  const { publicUrl } = config();

  return (
    <>
      <AutoRefresh seconds={10} />
      <PageHeader
        icon={<Laptop />}
        title="Computers"
        description="Every Godmode linked to your account, and the ones other people shared with you. Open one to use it in this browser."
        actions={
          mayLink && rows.length > 0 ? (
            <Button asChild>
              <Link href="/link">
                <Plus />
                Link a computer
              </Link>
            </Button>
          ) : undefined
        }
      />
      <PageBody>
        {query.denied === "1" && (
          <Callout tone="warning" title="You don't have access to that computer">
            It does not exist any more, or it is not shared with you. These are the computers you can open.
          </Callout>
        )}
        {rows.length === 0 ? (
          mayLink ? (
            <EmptyState
              art={<Mascot size={72} />}
              title="Link your first computer"
              description="Godmode keeps running on your own computer. Linking it lets you open it from any browser and reach it from your phone."
              steps={linkSteps(publicUrl)}
              action={
                <Button asChild variant="outline">
                  <Link href="/link">I have a code</Link>
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Laptop />}
              title="No computers yet"
              description="Your role can't link computers. Computers that other people share with you appear here."
            />
          )
        ) : (
          <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {rows.map(({ device, role, owner }) => (
              <DeviceCard
                key={device.id}
                device={device}
                role={role}
                owner={owner}
                state={states.get(device.id)!}
                traffic={(traffic[device.id]?.bytesIn ?? 0) + (traffic[device.id]?.bytesOut ?? 0)}
                userId={ctx.user.id}
                canShare={canShare}
              />
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}
