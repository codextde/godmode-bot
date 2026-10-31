import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, Cloud, ExternalLink, KeyRound, RefreshCw, ShieldCheck, Unlink } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { CloudAccessRole, CloudLinkState, CloudSettings, CloudStatus, CloudUiContext } from "@godmode/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { dateLocale } from "@/i18n";
import { cloudContext } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { CloudLinkDialog, isLinked, UnlinkCloudDialog, useCloudStatus, useUnlinkCloud } from "./cloud-link-dialog";
import { Callout, InfoRow, SectionHeading, SettingRow, SettingsGroup } from "./settings-kit";

const STATES = {
  unlinked: { labelKey: "cloud.state.unlinked", tone: "neutral" },
  linking: { labelKey: "cloud.state.linking", tone: "neutral" },
  connecting: { labelKey: "cloud.state.connecting", tone: "neutral" },
  online: { labelKey: "cloud.state.online", tone: "live" },
  offline: { labelKey: "cloud.state.offline", tone: "warning" },
  paused: { labelKey: "cloud.state.paused", tone: "neutral" },
  blocked: { labelKey: "cloud.state.blocked", tone: "warning" },
  revoked: { labelKey: "cloud.state.revoked", tone: "danger" },
} as const satisfies Record<CloudLinkState, { labelKey: string; tone: "live" | "neutral" | "warning" | "danger" }>;

const ROLES = { owner: "cloud.role.owner", operator: "cloud.role.operator", viewer: "cloud.role.viewer" } as const satisfies Record<CloudAccessRole, string>;

export function CloudSection() {
  return cloudContext ? <RemoteCloudSection cloud={cloudContext} /> : <LocalCloudSection />;
}

/** Cloud mode: linking is the computer's business; this only says where you are. */
function RemoteCloudSection({ cloud }: { cloud: CloudUiContext }) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-5">
      <SectionHeading title={t("cloud.title")} description={t("cloud.remoteDescription")} />
      <SettingsGroup title="Godmode Cloud" icon={<Cloud />}>
        <InfoRow label={t("cloud.computer")}>{cloud.deviceName}</InfoRow>
        <InfoRow label={t("cloud.title")} mono>
          {window.location.host}
        </InfoRow>
        <InfoRow label={t("cloud.yourRole")}>
          <Badge variant="outline" className="font-normal">
            {ROLES[cloud.role] ? t(ROLES[cloud.role]) : cloud.role}
          </Badge>
        </InfoRow>
        <div className="space-y-3 py-4">
          <Callout tone="muted">{t("cloud.remoteNote")}</Callout>
          <Button variant="outline" size="sm" asChild>
            <a href={cloud.home}>
              <ArrowLeft /> {t("cloud.allComputers")}
            </a>
          </Button>
        </div>
      </SettingsGroup>
    </div>
  );
}

function LocalCloudSection() {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const [linking, setLinking] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const status = useCloudStatus();
  const s = status.data;
  const unlink = useUnlinkCloud();

  const update = useMutation({
    mutationFn: api.cloud.update,
    onSuccess: (next) => qc.setQueryData(qk.cloud, next),
    onError: (e) => toastApiError(e, t("cloud.accessError"), qc),
  });

  // Switches show the value being saved right away.
  const setting = (key: keyof CloudSettings): boolean =>
    update.isPending && update.variables?.[key] !== undefined ? update.variables[key]! : (s?.settings[key] ?? false);
  const toggle = (key: keyof CloudSettings) => (on: boolean) => update.mutate({ [key]: on });

  return (
    <div className="space-y-5">
      <SectionHeading title={t("cloud.title")} description={t("cloud.description")} />

      {!s && status.isError ? (
        <SettingsGroup title="Godmode Cloud" icon={<Cloud />}>
          <div className="py-4 text-sm">
            <p className="font-medium text-destructive">{t("cloud.loadError")}</p>
            <p className="mt-1 text-muted-foreground">{errorMessage(status.error)}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => status.refetch()}>
              <RefreshCw /> {t("common:actions.tryAgain")}
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
            <Callout tone="warning" title={t("cloud.lastLinkFailed")}>
              {s.error}
            </Callout>
          )}
        </>
      ) : s.state === "linking" ? (
        <SettingsGroup
          title={t("cloud.state.linking")}
          icon={<Cloud />}
          description={t("cloud.approve", { host: host(s.url) })}
          actions={<StateBadge state={s.state} />}
        >
          <InfoRow label={t("cloud.code")} mono>
            <span className="text-sm tracking-[0.08em]">{s.pending?.userCode}</span>
          </InfoRow>
          <div className="flex flex-wrap gap-2 py-4">
            <Button size="sm" onClick={() => setLinking(true)}>
              {t("cloud.showCode")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => unlink.mutate()} disabled={unlink.isPending}>
              {t("cloud.cancelLinking")}
            </Button>
          </div>
        </SettingsGroup>
      ) : (
        <>
          <StatusGroup status={s} onRelink={() => setLinking(true)} />
          {s.state !== "revoked" && (
            <SettingsGroup title={t("cloud.access.title")} icon={<ShieldCheck />} description={t("cloud.access.description")}>
              <SettingRow
                label={t("cloud.access.link")}
                htmlFor="cloud-enabled"
                description={t("cloud.access.linkDescription")}
              >
                <Switch id="cloud-enabled" checked={setting("enabled")} disabled={update.isPending} onCheckedChange={toggle("enabled")} />
              </SettingRow>
              <SettingRow
                label={t("cloud.access.browser")}
                htmlFor="cloud-browser"
                description={t("cloud.access.browserDescription")}
              >
                <Switch id="cloud-browser" checked={setting("browserAccess")} disabled={update.isPending} onCheckedChange={toggle("browserAccess")} />
              </SettingRow>
              <SettingRow
                label={t("cloud.access.phones")}
                htmlFor="cloud-phones"
                description={t("cloud.access.phonesDescription")}
              >
                <Switch id="cloud-phones" checked={setting("phoneAccess")} disabled={update.isPending} onCheckedChange={toggle("phoneAccess")} />
              </SettingRow>
              <SettingRow
                label={t("cloud.access.secrets")}
                htmlFor="cloud-secrets"
                description={t("cloud.access.secretsDescription")}
              >
                <Switch id="cloud-secrets" checked={setting("allowSecrets")} disabled={update.isPending} onCheckedChange={toggle("allowSecrets")} />
              </SettingRow>
            </SettingsGroup>
          )}
          <SettingsGroup title={t("cloud.unlink.title")} icon={<Unlink />} tone="danger">
            <SettingRow label={t("cloud.unlink.label")} description={t("cloud.unlink.description")}>
              <Button variant="outline" size="sm" className="text-destructive" onClick={() => setConfirmUnlink(true)} disabled={unlink.isPending}>
                {t("cloud.unlink.button")}
              </Button>
            </SettingRow>
          </SettingsGroup>
        </>
      )}

      <CloudLinkDialog open={linking} onOpenChange={setLinking} />
      <UnlinkCloudDialog
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        onConfirm={() => unlink.mutate(undefined, { onSuccess: () => toast.success(t("cloud.unlinked")) })}
      />
    </div>
  );
}

function StatusGroup({ status: s, onRelink }: { status: CloudStatus; onRelink: () => void }) {
  const { t } = useTranslation("settings");
  const browserOn = s.settings.enabled && s.settings.browserAccess;
  const revoked = s.state === "revoked";
  return (
    <SettingsGroup
      title="Godmode Cloud"
      icon={<Cloud />}
      description={s.account ? t("cloud.status.linkedTo", { email: s.account.email }) : undefined}
      actions={<StateBadge state={s.state} />}
    >
      {s.account && (
        <InfoRow label={t("cloud.status.account")}>
          <span className="truncate">{s.account.name ? `${s.account.name} · ${s.account.email}` : s.account.email}</span>
        </InfoRow>
      )}
      <InfoRow label={t("cloud.title")} mono>
        {host(s.url)}
      </InfoRow>
      {s.plan && (
        <InfoRow label={t("cloud.status.plan")}>
          {s.plan.name}
          <Link to="/settings/billing" className="ml-2 text-xs font-medium text-foreground underline-offset-4 hover:underline">
            {t("page.sections.billing")}
          </Link>
        </InfoRow>
      )}
      {s.connectedSince && s.state === "online" ? (
        <InfoRow label={t("cloud.status.connected")}>{formatDistanceToNow(new Date(s.connectedSince), { addSuffix: true, locale: dateLocale() })}</InfoRow>
      ) : s.linkedAt ? (
        <InfoRow label={t("cloud.status.linked")}>{formatDistanceToNow(new Date(s.linkedAt), { addSuffix: true, locale: dateLocale() })}</InfoRow>
      ) : null}
      {(s.error || revoked) && (
        <div className="py-4">
          <Callout tone={revoked ? "danger" : "warning"} title={revoked ? t("cloud.status.revoked") : undefined}>
            {s.error ?? t("cloud.status.relinkHint")}
            {revoked && (
              <div className="mt-3">
                <Button variant="outline" size="sm" onClick={onRelink}>
                  <KeyRound /> {t("cloud.status.relink")}
                </Button>
              </div>
            )}
          </Callout>
        </div>
      )}
      {s.browserUrl && isLinked(s) && (
        <SettingRow
          label={t("cloud.status.inBrowser")}
          description={browserOn ? <span className="font-mono text-[11px] break-all">{s.browserUrl}</span> : t("cloud.status.inBrowserOff")}
        >
          <Button variant="outline" size="sm" disabled={!browserOn} onClick={() => void openExternal(s.browserUrl!)}>
            <ExternalLink /> {t("cloud.status.openInBrowser")}
          </Button>
        </SettingRow>
      )}
    </SettingsGroup>
  );
}

function StateBadge({ state }: { state: CloudLinkState }) {
  const { t } = useTranslation("settings");
  const { labelKey, tone } = STATES[state] ?? STATES.unlinked;
  return <ToneBadge tone={tone}>{t(labelKey)}</ToneBadge>;
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
  const { t } = useTranslation("settings");
  return (
    <section className="relative overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex flex-col gap-6 p-6 @xl:flex-row @xl:items-center">
        <div className="min-w-0 flex-1">
          <p className="eyebrow">Godmode Cloud</p>
          <h3 className="mt-2 text-xl leading-snug font-medium tracking-[-0.025em]">{t("cloud.hero.title")}</h3>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{t("cloud.hero.body")}</p>
          <Button className="mt-5" onClick={onConnect}>
            <Cloud /> {t("cloud.hero.connect")}
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
