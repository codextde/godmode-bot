import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound, Link2, ListOrdered } from "lucide-react";
import { PageBody, PageHeader } from "@/components/page";
import { RelativeTime } from "@/components/relative-time";
import { Callout, InfoRow, SettingsGroup } from "@/components/settings-kit";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/session";
import { deviceAllowance } from "@/server/billing/entitlements";
import { config } from "@/server/config";
import { listDevicesFor } from "@/server/devices";
import { getPendingLink } from "@/server/devices/link";
import { can } from "@/server/rbac/permissions";
import { relayHub } from "@/server/relay-bridge";
import { platformLabel } from "../devices/_components/device-info";
import { linkSteps } from "../devices/_components/link-steps";
import { CodeForm } from "./_components/code-form";
import { LinkDecision } from "./_components/link-decision";

export const metadata: Metadata = { title: "Link a computer" };

export default async function LinkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [ctx, query] = await Promise.all([requireUser(), searchParams]);
  const typed = typeof query.code === "string" ? query.code.slice(0, 32) : "";
  const request = typed ? await getPendingLink(typed) : null;

  if (!request) {
    const steps = linkSteps(config().publicUrl);
    return (
      <>
        <PageHeader
          width="form"
          back={{ href: "/devices", label: "Computers" }}
          icon={<Link2 />}
          title="Link a computer"
          description="Enter the code that Godmode shows on the computer you want to link to your account."
        />
        <PageBody width="form">
          <SettingsGroup icon={<KeyRound />} title="Enter the code" description={`The computer will be linked to ${ctx.user.email}.`}>
            <CodeForm
              initial={typed}
              error={typed ? "This code has expired or was already used. Start linking again on the computer." : null}
            />
          </SettingsGroup>
          <SettingsGroup icon={<ListOrdered />} title="Where the code comes from" description="Linking always starts on the computer.">
            <ol className="space-y-3 py-4">
              {steps.map((step, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span
                    aria-hidden
                    className="grid size-6 shrink-0 place-items-center rounded-md border bg-paper-2 font-mono text-[11px] font-medium tabular-nums"
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5 leading-relaxed text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
                    {step}
                  </div>
                </li>
              ))}
            </ol>
          </SettingsGroup>
        </PageBody>
      </>
    );
  }

  const mayLink = can(ctx, "devices.link");
  const [mine, allowance] = await Promise.all([listDevicesFor(ctx.user.id), deviceAllowance(ctx.user.id)]);
  // Linking the same computer again makes a new computer: the old record and its link go away.
  const existing = mine.find((row) => row.role === "owner" && row.device.instanceId === request.instanceId)?.device ?? null;
  const existingOnline = existing ? relayHub().isOnline(existing.id) : false;
  const overLimit = !existing && allowance.limit !== null && allowance.used >= allowance.limit;
  const otherNetwork = Boolean(request.ip && ctx.ip && request.ip !== ctx.ip);
  const limit = allowance.limit ?? 0;

  return (
    <>
      <PageHeader
        width="form"
        back={{ href: "/devices", label: "Computers" }}
        icon={<Link2 />}
        title="Link a computer"
        description="A computer asks to be linked to your account. Whoever is linked can be opened from this cloud."
      />
      <PageBody width="form">
        <SettingsGroup
          title={`Link to ${ctx.user.email}`}
          description="Not your account? Sign out and sign in with the right one before you approve."
          footer={<LinkDecision code={request.userCode} deviceName={request.name} blocked={!mayLink || existingOnline || overLimit} />}
        >
          <div className="py-6 text-center">
            <p className="eyebrow text-[10.5px]">Code</p>
            <p className="mt-2 font-mono text-[34px] leading-none font-medium tracking-[0.14em] tabular-nums @md:text-[40px]">{request.userCode}</p>
            <p className="mx-auto mt-3 max-w-sm text-sm text-muted-foreground">
              Only approve if this code is shown in Godmode on that computer.
            </p>
          </div>
          <InfoRow label="Computer">{request.name}</InfoRow>
          <InfoRow label="Platform">{platformLabel(request.platform)}</InfoRow>
          <InfoRow label="Godmode version" mono>
            {request.appVersion || "—"}
          </InfoRow>
          <InfoRow label="Request came from" mono>
            {request.ip ?? "Unknown address"}
          </InfoRow>
          <InfoRow label="Requested">
            <RelativeTime date={request.createdAt} />
          </InfoRow>
          {(otherNetwork || existing || overLimit || !mayLink) && (
            <div className="flex flex-col gap-3 py-4">
              {otherNetwork && (
                <Callout tone="warning" title="This request does not come from your network.">
                  Only continue if you are sitting at that computer.
                </Callout>
              )}
              {!mayLink && (
                <Callout tone="danger" title="Your role can't link computers" role="note">
                  Ask an administrator of this cloud to change your role.
                </Callout>
              )}
              {existing && existingOnline && (
                <Callout tone="danger" title={`${existing.name} is connected right now`} role="note">
                  This computer is already linked to your account and online. Unlink it on the computer first, then start linking again.
                </Callout>
              )}
              {existing && !existingOnline && (
                <Callout tone="info" title={`This links ${existing.name} again as a new computer`}>
                  The computer is already linked to your account. Approving links it as a new computer, and the old link stops working. People
                  you shared it with lose their access until you share it again.
                </Callout>
              )}
              {overLimit && (
                <Callout
                  tone="warning"
                  title="Your plan's computers are all linked"
                  action={
                    <Button asChild variant="outline" size="sm">
                      <Link href="/billing">Open billing</Link>
                    </Button>
                  }
                >
                  Your plan includes {limit} computer{limit === 1 ? "" : "s"}. Remove one on the Computers page or choose a bigger plan, then
                  approve this request.
                </Callout>
              )}
            </div>
          )}
        </SettingsGroup>
      </PageBody>
    </>
  );
}
