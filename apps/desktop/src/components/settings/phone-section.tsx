import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ExternalLink, Network, QrCode, RefreshCw, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
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
import { dateLocale } from "@/i18n";
import { cloudContext } from "@/lib/core";
import { openExternal } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { isLinked } from "./cloud-link-dialog";
import { PairPhoneDialog, TAILSCALE_DOWNLOAD } from "./pair-phone-dialog";
import { Callout, InfoRow, NumberField, SectionHeading, SettingRow, SettingsGroup } from "./settings-kit";

export function PhoneSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
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
    onError: (e) => toastApiError(e, t("phone.accessError"), qc),
  });

  const recheck = useMutation({
    mutationFn: () => api.mobile.status(true),
    onSuccess: (next) => qc.setQueryData(qk.mobile, next),
    onError: (e) => toastApiError(e, t("phone.checkError"), qc),
  });

  const enabled = update.isPending && update.variables?.enabled !== undefined ? update.variables.enabled : (s?.enabled ?? settings.mobile.enabled);

  return (
    <div className="space-y-5">
      <SectionHeading title={t("phone.title")} description={t("phone.description")} />

      {remote ? (
        <Callout tone="muted">{t("phone.remoteOnly")}</Callout>
      ) : (
        <Hero onConnect={() => setPairing(true)} ready={!!s?.tailscale.running || gateway} loading={status.isLoading} />
      )}

      <SettingsGroup
        title="Tailscale"
        icon={<Network />}
        description={t("phone.tailscale.description")}
        actions={
          <>
            {s && <TailscaleBadge status={s} />}
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t("botCheck.again")} onClick={() => recheck.mutate()} disabled={recheck.isPending}>
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
              title={s.tailscale.installed ? t("phone.tailscale.notConnectedTitle") : t("phone.tailscale.notInstalledTitle")}
            >
              <p>{s.tailscale.detail}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void openExternal(TAILSCALE_DOWNLOAD)}>
                <ExternalLink /> {t("phone.tailscale.get")}
              </Button>
            </Callout>
          </div>
        ) : (
          <>
            {s.tailscale.dnsName && (
              <InfoRow label={t("phone.tailscale.thisComputer")} mono>
                {s.tailscale.dnsName}
                <CopyButton text={s.tailscale.dnsName} label={t("phone.tailscale.copyName")} />
              </InfoRow>
            )}
            <InfoRow label={t("phone.tailscale.address")} mono>
              {s.tailscale.ip}
            </InfoRow>
            {s.tailscale.tailnet && <InfoRow label="Tailnet">{s.tailscale.tailnet}</InfoRow>}
          </>
        )}
        <SettingRow
          label={t("phone.access")}
          htmlFor="phone-access"
          description={gateway ? t("phone.accessGateway") : t("phone.accessTailscale")}
        >
          <Switch id="phone-access" checked={enabled} disabled={remote || update.isPending} onCheckedChange={(on) => update.mutate({ enabled: on })} />
        </SettingRow>
        <SettingRow label={t("security.web.port")} htmlFor="phone-port" description={t("phone.portDescription")}>
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
            <Callout tone="warning" title={t("phone.cantConnect")}>
              {s.error}
            </Callout>
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title={t("phone.paired.title")}
        icon={<Smartphone />}
        description={t("phone.paired.description")}
        actions={
          s?.devices.length && !remote ? (
            <Button variant="outline" size="sm" onClick={() => setPairing(true)}>
              <QrCode /> {t("phone.connect")}
            </Button>
          ) : undefined
        }
      >
        {!s && status.isError ? (
          <p className="py-5 text-sm text-muted-foreground">{t("phone.paired.unavailable")}</p>
        ) : !s ? (
          <div className="py-4">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : s.devices.length === 0 ? (
          <p className="py-5 text-sm text-muted-foreground">{t("phone.paired.empty")}</p>
        ) : (
          s.devices.map((d) => <DeviceRow key={d.id} device={d} readOnly={remote} />)
        )}
      </SettingsGroup>

      <Callout tone="muted" icon={<ShieldCheck className="text-muted-foreground" />} title={t("phone.can.title")}>
        {t("phone.can.body")}
      </Callout>

      {!remote && <PairPhoneDialog open={pairing} onOpenChange={setPairing} tailnet={s?.tailscale.tailnet ?? null} gateway={gateway} />}
    </div>
  );
}

function Hero({ onConnect, ready, loading }: { onConnect: () => void; ready: boolean; loading: boolean }) {
  const { t } = useTranslation("settings");
  return (
    <section className="relative overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="flex flex-col gap-6 p-6 @xl:flex-row @xl:items-center">
        <div className="min-w-0 flex-1">
          <p className="eyebrow">{t("phone.hero.eyebrow")}</p>
          <h3 className="mt-2 text-xl leading-snug font-medium tracking-[-0.025em]">{t("phone.hero.title")}</h3>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{t("phone.hero.body")}</p>
          <Button className="mt-5" onClick={onConnect} disabled={loading}>
            <QrCode /> {t("phone.connect")}
          </Button>
          {!loading && !ready && <p className="mt-2.5 text-xs text-muted-foreground">{t("phone.hero.needs")}</p>}
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
  const { t } = useTranslation("settings");
  const listening = status.enabled && status.urls.length > 0;
  const tone = listening ? "live" : status.tailscale.running ? "ready" : "off";
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-normal", tone === "live" ? "border-brand/25 bg-brand-soft text-brand-strong" : "text-muted-foreground")}
    >
      <span className={cn("size-1.5 rounded-full", tone === "live" ? "bg-brand" : tone === "ready" ? "bg-foreground/40" : "bg-muted-foreground/50")} />
      {tone === "live" ? t("phone.badge.live") : tone === "ready" ? t("phone.badge.connected") : status.tailscale.installed ? t("phone.badge.notConnected") : t("phone.badge.notInstalled")}
    </Badge>
  );
}

function DeviceRow({ device, readOnly }: { device: MobileDevice; readOnly: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.mobile.removeDevice(device.id),
    onSuccess: () => {
      toast.success(t("phone.device.removed", { name: device.name }));
      void qc.invalidateQueries({ queryKey: qk.mobile });
    },
    onError: (e) => toastApiError(e, t("phone.device.removeError"), qc),
  });
  const seen = device.online
    ? t("phone.device.online")
    : device.lastSeenAt
      ? t("phone.device.lastSeen", { time: formatDistanceToNow(new Date(device.lastSeenAt), { addSuffix: true, locale: dateLocale() }) })
      : t("phone.device.never");

  return (
    <div className="flex items-center gap-3 py-3.5">
      <div className="relative grid size-9 shrink-0 place-items-center rounded-lg border bg-paper-2 [&_svg]:size-4">
        <Smartphone />
        {device.online && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-brand" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{device.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {[device.model ?? (device.platform === "ios" ? "iPhone" : "Android"), seen, t("phone.device.paired", { time: formatDistanceToNow(new Date(device.createdAt), { addSuffix: true, locale: dateLocale() }) })].join(" · ")}
        </p>
      </div>
      {!readOnly && (
        <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={t("phone.device.removeLabel", { name: device.name })} onClick={() => setConfirm(true)}>
          {remove.isPending ? <Spinner /> : <Trash2 />}
        </Button>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("phone.device.confirmTitle", { name: device.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("phone.device.confirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>
              {t("common:actions.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
