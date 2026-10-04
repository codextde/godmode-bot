import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ExternalLink, Network, QrCode, RefreshCw, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { MobileDevice, MobileStatus, Settings } from "@godmode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { CopyButton } from "@/components/chat/copy-button";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { cloudContext } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { isLinked } from "./cloud-link-dialog";
import { PairPhoneDialog, TAILSCALE_DOWNLOAD } from "./pair-phone-dialog";
import { Callout, InfoRow, NumberField, SectionHeading, SettingRow, SettingsGroup } from "./settings-kit";

export function PhoneSection({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const [pairing, setPairing] = useState(false);
  // Through Godmode Cloud the computer refuses phone management: the section is read-only there.
  const remote = !!cloudContext;
  const status = useQuery({ queryKey: qk.mobile, queryFn: () => api.mobile.status() });
  const s = status.data;
  // Phones also come in through the Godmode Cloud gateway while linked (phones only use https addresses).
  const cloud = useQuery({ queryKey: qk.cloud, queryFn: api.cloud.status, enabled: !remote }).data;
  const gateway = !!cloud && isLinked(cloud) && cloud.settings.enabled && cloud.settings.phoneAccess && !!cloud.gatewayUrl?.startsWith("https://");

  const update = useMutation({
    mutationFn: api.mobile.update,
    onSuccess: (next) => {
      qc.setQueryData(qk.mobile, next);
      void qc.invalidateQueries({ queryKey: qk.settings });
    },
    onError: (e) => toastApiError(e, "Could not change phone access", qc),
  });

  const recheck = useMutation({
    mutationFn: () => api.mobile.status(true),
    onSuccess: (next) => qc.setQueryData(qk.mobile, next),
    onError: (e) => toastApiError(e, "Could not check Tailscale", qc),
  });

  const enabled = update.isPending && update.variables?.enabled !== undefined ? update.variables.enabled : (s?.enabled ?? settings.mobile.enabled);

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Phone"
        description="Control Godmode from your iPhone or Android phone: chats, agents, automations and the screens they work on. Phones connect over Tailscale, or through Godmode Cloud when this computer is linked to it. No port is opened to the internet."
      />

      {remote ? (
        <Callout tone="muted">Pairing phones and changing phone access only work in Godmode on the computer itself.</Callout>
      ) : (
        <Hero onConnect={() => setPairing(true)} ready={!!s?.tailscale.running || gateway} loading={status.isLoading} />
      )}

      <SettingsGroup
        title="Tailscale"
        icon={<Network />}
        description="Your private, end-to-end encrypted network."
        actions={
          <>
            {s && <TailscaleBadge status={s} />}
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Check again" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
              {recheck.isPending ? <Spinner /> : <RefreshCw />}
            </Button>
          </>
        }
      >
        {!s && status.isError ? (
          <p className="py-4 text-sm text-muted-foreground">{errorMessage(status.error)}</p>
        ) : !s ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-4 w-40" />
          </div>
        ) : !s.tailscale.running ? (
          <div className="py-4">
            <Callout
              tone={s.tailscale.installed ? "warning" : "info"}
              title={s.tailscale.installed ? "Tailscale isn't connected" : "Tailscale isn't installed"}
            >
              <p>{s.tailscale.detail}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void openExternal(TAILSCALE_DOWNLOAD)}>
                <ExternalLink /> Get Tailscale
              </Button>
            </Callout>
          </div>
        ) : (
          <>
            {s.tailscale.dnsName && (
              <InfoRow label="This computer" mono>
                {s.tailscale.dnsName}
                <CopyButton text={s.tailscale.dnsName} label="Copy name" />
              </InfoRow>
            )}
            <InfoRow label="Tailscale address" mono>
              {s.tailscale.ip}
            </InfoRow>
            {s.tailscale.tailnet && <InfoRow label="Tailnet">{s.tailscale.tailnet}</InfoRow>}
          </>
        )}
        <SettingRow
          label="Phone access"
          htmlFor="phone-access"
          description={
            gateway
              ? "Paired phones may connect, over this computer's Tailscale address or through Godmode Cloud. Godmode only answers phones you paired."
              : "Paired phones may connect. Godmode listens only on this computer's Tailscale address, and only answers phones you paired."
          }
        >
          <Switch id="phone-access" checked={enabled} disabled={remote || update.isPending} onCheckedChange={(on) => update.mutate({ enabled: on })} />
        </SettingRow>
        <SettingRow label="Port" htmlFor="phone-port" description="Change it only if another app uses it. Paired phones need a new code afterwards.">
          <NumberField
            id="phone-port"
            disabled={remote}
            min={1024}
            max={65535}
            value={s?.port ?? settings.mobile.port}
            onCommit={(port) => port !== null && port !== s?.port && update.mutate({ port })}
          />
        </SettingRow>
        {s?.enabled && s.error && s.tailscale.running && (
          <div className="pb-4">
            <Callout tone="warning" title="Phones can't connect">
              {s.error}
            </Callout>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Paired phones"
        icon={<Smartphone />}
        description="Each phone has its own key. Removing a phone disconnects it right away."
        actions={
          s?.devices.length && !remote ? (
            <Button variant="outline" size="sm" onClick={() => setPairing(true)}>
              <QrCode /> Connect a phone
            </Button>
          ) : undefined
        }
      >
        {!s && status.isError ? (
          <p className="py-5 text-sm text-muted-foreground">The list of phones isn't available here.</p>
        ) : !s ? (
          <div className="py-4">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : s.devices.length === 0 ? (
          <p className="py-5 text-sm text-muted-foreground">No phones yet. Connect one to use Godmode on the go.</p>
        ) : (
          s.devices.map((d) => <DeviceRow key={d.id} device={d} readOnly={remote} />)
        )}
      </SettingsGroup>

      <Callout tone="muted" icon={<ShieldCheck className="text-muted-foreground" />} title="What a phone can do">
        Chat with agents, stop runs, run automations, start and stop VMs, and watch browsers, shared screens and VMs live. It can only take control
        of browsers and of screens you shared in a chat. Logins, 2FA codes, backups, integrations and settings can't be opened from a phone.
      </Callout>

      {!remote && <PairPhoneDialog open={pairing} onOpenChange={setPairing} tailnet={s?.tailscale.tailnet ?? null} gateway={gateway} />}
    </div>
  );
}

function Hero({ onConnect, ready, loading }: { onConnect: () => void; ready: boolean; loading: boolean }) {
  return (
    <section className="relative overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex flex-col gap-6 p-6 @xl:flex-row @xl:items-center">
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Godmode for iOS and Android</p>
          <h3 className="mt-2 text-xl leading-snug font-medium tracking-[-0.025em]">Your coworkers, in your pocket.</h3>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
            Hand over a task from anywhere, follow the answer as it's written, and look over an agent's shoulder in its browser or VM.
          </p>
          <Button className="mt-5" onClick={onConnect} disabled={loading}>
            <QrCode /> Connect a phone
          </Button>
          {!loading && !ready && (
            <p className="mt-2.5 text-xs text-muted-foreground">Needs Tailscale on this computer and your phone, or a link to Godmode Cloud.</p>
          )}
        </div>
        <PhoneGlyph />
      </div>
    </section>
  );
}

/** A quiet phone outline with a pairing code on its screen. */
function PhoneGlyph() {
  return (
    <div aria-hidden className="mx-auto shrink-0 @xl:mx-0 @xl:mr-4">
      <div className="relative h-[168px] w-[88px] rounded-[20px] border-[1.5px] border-foreground/15 bg-paper-2 p-1.5">
        <div className="absolute top-2 left-1/2 h-1.5 w-7 -translate-x-1/2 rounded-full bg-foreground/15" />
        <div className="flex h-full flex-col items-center justify-center gap-2 rounded-[15px] bg-card">
          <div className="grid grid-cols-5 gap-[3px] rounded-md p-1.5 ring-1 ring-border">
            {[1, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 0, 1, 1].map((on, i) => (
              <span key={i} className={cn("size-[5px] rounded-[1.5px]", on ? "bg-foreground/80" : "bg-transparent")} />
            ))}
          </div>
          <span className="h-1 w-8 rounded-full bg-brand/70" />
        </div>
      </div>
    </div>
  );
}

function TailscaleBadge({ status }: { status: MobileStatus }) {
  const listening = status.enabled && status.urls.length > 0;
  const tone = listening ? "live" : status.tailscale.running ? "ready" : "off";
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-normal", tone === "live" ? "border-brand/25 bg-brand-soft text-brand-strong" : "text-muted-foreground")}
    >
      <span className={cn("size-1.5 rounded-full", tone === "live" ? "bg-brand" : tone === "ready" ? "bg-foreground/40" : "bg-muted-foreground/50")} />
      {tone === "live" ? "Phones can connect" : tone === "ready" ? "Connected" : status.tailscale.installed ? "Not connected" : "Not installed"}
    </Badge>
  );
}

function DeviceRow({ device, readOnly }: { device: MobileDevice; readOnly: boolean }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.mobile.removeDevice(device.id),
    onSuccess: () => {
      toast.success(`${device.name} removed`);
      void qc.invalidateQueries({ queryKey: qk.mobile });
    },
    onError: (e) => toastApiError(e, "Could not remove the phone", qc),
  });
  const seen = device.online
    ? "Connected now"
    : device.lastSeenAt
      ? `Last seen ${formatDistanceToNow(new Date(device.lastSeenAt), { addSuffix: true })}`
      : "Never connected";

  return (
    <div className="flex items-center gap-3 py-3.5">
      <div className="relative grid size-9 shrink-0 place-items-center rounded-lg border bg-paper-2 [&_svg]:size-4">
        <Smartphone />
        {device.online && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-brand" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{device.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {[device.model ?? (device.platform === "ios" ? "iPhone" : "Android"), seen, `paired ${formatDistanceToNow(new Date(device.createdAt), { addSuffix: true })}`].join(" · ")}
        </p>
      </div>
      {!readOnly && (
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${device.name}`} onClick={() => setConfirm(true)}>
          {remove.isPending ? <Spinner /> : <Trash2 />}
        </Button>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {device.name}?</AlertDialogTitle>
            <AlertDialogDescription>It's disconnected right away and can't control Godmode anymore. You can pair it again with a new code.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
