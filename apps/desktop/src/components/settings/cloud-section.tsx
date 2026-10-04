import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, Cloud, ExternalLink, KeyRound, RefreshCw, ShieldCheck, Unlink } from "lucide-react";
import { toast } from "sonner";
import type { CloudAccessRole, CloudLinkState, CloudSettings, CloudStatus, CloudUiContext } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { cloudContext } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { CloudLinkDialog, isLinked, UnlinkCloudDialog, useCloudStatus, useUnlinkCloud } from "./cloud-link-dialog";
import { Callout, InfoRow, SectionHeading, SettingRow, SettingsGroup } from "./settings-kit";

const STATES: Record<CloudLinkState, { label: string; tone: "live" | "neutral" | "warning" | "danger" }> = {
  unlinked: { label: "Not linked", tone: "neutral" },
  linking: { label: "Waiting for approval", tone: "neutral" },
  connecting: { label: "Connecting…", tone: "neutral" },
  online: { label: "Online", tone: "live" },
  offline: { label: "Offline", tone: "warning" },
  paused: { label: "Paused", tone: "neutral" },
  blocked: { label: "Blocked", tone: "warning" },
  revoked: { label: "Removed in the cloud", tone: "danger" },
};

const ROLES: Record<CloudAccessRole, string> = { owner: "Owner", operator: "Operator", viewer: "Viewer" };

export function CloudSection() {
  return cloudContext ? <RemoteCloudSection cloud={cloudContext} /> : <LocalCloudSection />;
}

/** Cloud mode: linking is the computer's business; this only says where you are. */
function RemoteCloudSection({ cloud }: { cloud: CloudUiContext }) {
  return (
    <div className="space-y-5">
      <SectionHeading title="Cloud" description="You're using this computer through Godmode Cloud." />
      <SettingsGroup title="Godmode Cloud" icon={<Cloud />}>
        <InfoRow label="Computer">{cloud.deviceName}</InfoRow>
        <InfoRow label="Cloud" mono>
          {window.location.host}
        </InfoRow>
        <InfoRow label="Your role">
          <Badge variant="outline" className="font-normal">
            {ROLES[cloud.role] ?? cloud.role}
          </Badge>
        </InfoRow>
        <div className="space-y-3 py-4">
          <Callout tone="muted">Linking and access switches are managed on the computer itself.</Callout>
          <Button variant="outline" size="sm" asChild>
            <a href={cloud.home}>
              <ArrowLeft /> All computers
            </a>
          </Button>
        </div>
      </SettingsGroup>
    </div>
  );
}

function LocalCloudSection() {
  const qc = useQueryClient();
  const [linking, setLinking] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const status = useCloudStatus();
  const s = status.data;
  const unlink = useUnlinkCloud();

  const update = useMutation({
    mutationFn: api.cloud.update,
    onSuccess: (next) => qc.setQueryData(qk.cloud, next),
    onError: (e) => toastApiError(e, "Could not change cloud access", qc),
  });

  // Switches show the value being saved right away.
  const setting = (key: keyof CloudSettings): boolean =>
    update.isPending && update.variables?.[key] !== undefined ? update.variables[key]! : (s?.settings[key] ?? false);
  const toggle = (key: keyof CloudSettings) => (on: boolean) => update.mutate({ [key]: on });

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Cloud"
        description="Open this computer in any browser and reach it from your phone without Tailscale, through your Godmode Cloud account. Nothing leaves this computer until you link it."
      />

      {!s && status.isError ? (
        <SettingsGroup title="Godmode Cloud" icon={<Cloud />}>
          <div className="py-4 text-sm">
            <p className="font-medium text-destructive">Could not load the cloud link</p>
            <p className="mt-1 text-muted-foreground">{errorMessage(status.error)}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => status.refetch()}>
              <RefreshCw /> Try again
            </Button>
          </div>
        </SettingsGroup>
      ) : !s ? (
        <div className="space-y-4 rounded-xl border bg-card p-5 shadow-card">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-4 w-56" />
        </div>
      ) : s.state === "unlinked" ? (
        <>
          <Hero onConnect={() => setLinking(true)} />
          {s.error && (
            <Callout tone="warning" title="The last link didn't go through">
              {s.error}
            </Callout>
          )}
        </>
      ) : s.state === "linking" ? (
        <SettingsGroup
          title="Waiting for approval"
          icon={<Cloud />}
          description={`Approve this computer at ${host(s.url)}. The cloud must show the same code.`}
          actions={<StateBadge state={s.state} />}
        >
          <InfoRow label="Code" mono>
            <span className="text-sm tracking-[0.08em]">{s.pending?.userCode}</span>
          </InfoRow>
          <div className="flex flex-wrap gap-2 py-4">
            <Button size="sm" onClick={() => setLinking(true)}>
              Show code
            </Button>
            <Button variant="ghost" size="sm" onClick={() => unlink.mutate()} disabled={unlink.isPending}>
              Cancel linking
            </Button>
          </div>
        </SettingsGroup>
      ) : (
        <>
          <StatusGroup status={s} onRelink={() => setLinking(true)} />
          {s.state !== "revoked" && (
            <SettingsGroup title="Access" icon={<ShieldCheck />} description="What the cloud may do on this computer. Changes apply at once.">
              <SettingRow
                label="Cloud link"
                htmlFor="cloud-enabled"
                description="Keep the connection to the cloud open. Turn it off to pause browser and phone access without unlinking."
              >
                <Switch id="cloud-enabled" checked={setting("enabled")} disabled={update.isPending} onCheckedChange={toggle("enabled")} />
              </SettingRow>
              <SettingRow
                label="Browser access"
                htmlFor="cloud-browser"
                description="Anyone signed in to your cloud account can do everything in Godmode on this computer, including running commands. The people who run that cloud can too."
              >
                <Switch id="cloud-browser" checked={setting("browserAccess")} disabled={update.isPending} onCheckedChange={toggle("browserAccess")} />
              </SettingRow>
              <SettingRow
                label="Phones through the cloud"
                htmlFor="cloud-phones"
                description="Phones you paired can reach Godmode through the cloud when Tailscale isn't available. Pairing still happens on this computer; the cloud passes their traffic on and can see it."
              >
                <Switch id="cloud-phones" checked={setting("phoneAccess")} disabled={update.isPending} onCheckedChange={toggle("phoneAccess")} />
              </SettingRow>
              <SettingRow
                label="Secrets through the cloud"
                htmlFor="cloud-secrets"
                description="Also lets them unlock the vault and see or change saved passwords and keys from the browser. Turning this off does not make the computer read-only."
              >
                <Switch id="cloud-secrets" checked={setting("allowSecrets")} disabled={update.isPending} onCheckedChange={toggle("allowSecrets")} />
              </SettingRow>
            </SettingsGroup>
          )}
          <SettingsGroup title="Unlink" icon={<Unlink />} tone="danger">
            <SettingRow
              label="Unlink this computer"
              description="Browsers and phones can't reach it through the cloud anymore, and the cloud forgets it. You can link it again later."
            >
              <Button variant="outline" size="sm" className="text-destructive" onClick={() => setConfirmUnlink(true)} disabled={unlink.isPending}>
                Unlink…
              </Button>
            </SettingRow>
          </SettingsGroup>
        </>
      )}

      <CloudLinkDialog open={linking} onOpenChange={setLinking} />
      <UnlinkCloudDialog
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        onConfirm={() => unlink.mutate(undefined, { onSuccess: () => toast.success("Unlinked from Godmode Cloud") })}
      />
    </div>
  );
}

function StatusGroup({ status: s, onRelink }: { status: CloudStatus; onRelink: () => void }) {
  const browserOn = s.settings.enabled && s.settings.browserAccess;
  const revoked = s.state === "revoked";
  return (
    <SettingsGroup
      title="Godmode Cloud"
      icon={<Cloud />}
      description={s.account ? `Linked to ${s.account.email}` : undefined}
      actions={<StateBadge state={s.state} />}
    >
      {s.account && (
        <InfoRow label="Account">
          <span className="truncate">{s.account.name ? `${s.account.name} · ${s.account.email}` : s.account.email}</span>
        </InfoRow>
      )}
      <InfoRow label="Cloud" mono>
        {host(s.url)}
      </InfoRow>
      {s.plan && (
        <InfoRow label="Plan">
          {s.plan.name}
          <Link to="/settings/billing" className="ml-2 text-xs font-medium text-foreground underline-offset-4 hover:underline">
            Billing
          </Link>
        </InfoRow>
      )}
      {s.connectedSince && s.state === "online" ? (
        <InfoRow label="Connected">{formatDistanceToNow(new Date(s.connectedSince), { addSuffix: true })}</InfoRow>
      ) : s.linkedAt ? (
        <InfoRow label="Linked">{formatDistanceToNow(new Date(s.linkedAt), { addSuffix: true })}</InfoRow>
      ) : null}
      {(s.error || revoked) && (
        <div className="py-4">
          <Callout tone={revoked ? "danger" : "warning"} title={revoked ? "This computer was removed in the cloud" : undefined}>
            {s.error ?? "Link it again to reach it from the browser."}
            {revoked && (
              <div className="mt-3">
                <Button variant="outline" size="sm" onClick={onRelink}>
                  <KeyRound /> Link again
                </Button>
              </div>
            )}
          </Callout>
        </div>
      )}
      {s.browserUrl && isLinked(s) && (
        <SettingRow
          label="This computer in the browser"
          description={browserOn ? <span className="font-mono text-[11px] break-all">{s.browserUrl}</span> : "Turn on the cloud link and browser access below to open it."}
        >
          <Button variant="outline" size="sm" disabled={!browserOn} onClick={() => void openExternal(s.browserUrl!)}>
            <ExternalLink /> Open in browser
          </Button>
        </SettingRow>
      )}
    </SettingsGroup>
  );
}

function StateBadge({ state }: { state: CloudLinkState }) {
  const { label, tone } = STATES[state] ?? STATES.unlinked;
  return <ToneBadge tone={tone}>{label}</ToneBadge>;
}

/** Status pill: green only for live or positive states. */
export function ToneBadge({ tone, children }: { tone: "live" | "neutral" | "warning" | "danger"; children: ReactNode }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 font-normal",
        tone === "live" && "border-brand/25 bg-brand-soft text-brand-strong",
        tone === "warning" && "border-warning/30 bg-warning/[0.07] text-warning",
        tone === "danger" && "border-destructive/20 bg-destructive/[0.06] text-destructive",
        tone === "neutral" && "text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "live" && "bg-brand",
          tone === "warning" && "bg-warning",
          tone === "danger" && "bg-destructive",
          tone === "neutral" && "bg-muted-foreground/50",
        )}
      />
      {children}
    </Badge>
  );
}

function Hero({ onConnect }: { onConnect: () => void }) {
  return (
    <section className="relative overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex flex-col gap-6 p-6 @xl:flex-row @xl:items-center">
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Godmode Cloud</p>
          <h3 className="mt-2 text-xl leading-snug font-medium tracking-[-0.025em]">Reach this computer from any browser</h3>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
            Sign in to your cloud anywhere to chat with your coworkers, watch them work and change settings. Phones can connect through it too, without
            Tailscale.
          </p>
          <Button className="mt-5" onClick={onConnect}>
            <Cloud /> Connect to Godmode Cloud
          </Button>
        </div>
        <BrowserGlyph />
      </div>
    </section>
  );
}

/** A quiet browser window with this computer's dashboard in it. */
function BrowserGlyph() {
  return (
    <div aria-hidden className="mx-auto shrink-0 @xl:mx-0 @xl:mr-4">
      <div className="w-[168px] overflow-hidden rounded-[12px] border-[1.5px] border-foreground/15 bg-paper-2">
        <div className="flex items-center gap-1 border-b border-foreground/10 px-2 py-1.5">
          {[0, 1, 2].map((i) => (
            <span key={i} className="size-[5px] rounded-full bg-foreground/20" />
          ))}
          <span className="ml-1.5 h-[5px] flex-1 rounded-full bg-foreground/10" />
        </div>
        <div className="flex gap-1.5 bg-card p-2">
          <div className="w-7 space-y-1">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="block h-[5px] rounded-full bg-foreground/10" />
            ))}
          </div>
          <div className="flex-1 space-y-1.5">
            <span className="block h-[5px] w-3/4 rounded-full bg-foreground/20" />
            <span className="block h-[5px] w-1/2 rounded-full bg-foreground/10" />
            <span className="block h-[5px] w-2/3 rounded-full bg-foreground/10" />
            <span className="mt-3 block h-1 w-8 rounded-full bg-brand/70" />
          </div>
        </div>
      </div>
    </div>
  );
}

function host(url: string | null): string {
  try {
    return url ? new URL(url).host : "—";
  } catch {
    return url ?? "—";
  }
}
