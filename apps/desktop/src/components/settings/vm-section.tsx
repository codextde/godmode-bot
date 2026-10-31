import { Link } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Box, CircleCheck, CircleDashed, EyeOff, Globe, KeyRound, Moon, Power, PowerOff, RectangleEllipsis, ScrollText, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import type { Settings, VmSettings } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useShortPath } from "@/components/chat/folder-picker";
import { useVaultGrant } from "@/components/vault/grant";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { useVmStatus } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { FeatureSection } from "./feature-section";
import { Callout, ChoiceCards, CommitInput, InfoRow, NumberField, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

function Fact({ icon, children, caution }: { icon: React.ReactNode; children: React.ReactNode; caution?: boolean }) {
  return (
    <li className="inline-flex items-center gap-1.5 rounded-md border bg-paper-2 px-2 py-1 text-xs text-muted-foreground [&_svg]:size-3.5">
      <span className={caution ? "text-warning" : "text-foreground"}>{icon}</span>
      {children}
    </li>
  );
}

function State({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px]", ok ? "text-foreground" : "text-muted-foreground")}>
      {ok ? <CircleCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <CircleDashed className="size-3.5" />}
      {children}
    </span>
  );
}

export function VmSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation(["settings", "common"]);
  const { patch, patchAsync } = useSettingsPatch();
  const v = settings.vm;
  const qc = useQueryClient();
  const status = useVmStatus();
  const s = status.data;
  const short = useShortPath();
  const install = useMutation({
    mutationFn: api.vms.install,
    onSuccess: (res) => {
      if (res.ok) toast.success(t("vms.tartReady"));
      else toast.error(t("vms.tartInstallError"), { description: res.output || undefined });
      void qc.invalidateQueries({ queryKey: qk.vms });
    },
    onError: (e) => toastApiError(e, t("vms.tartInstallError"), qc),
  });
  const removeImage = useMutation({
    mutationFn: (image: string) => api.vms.removeImage(image),
    onSuccess: () => {
      toast.success(t("vms.imageRemoved"));
      void qc.invalidateQueries({ queryKey: qk.vms });
    },
    onError: (e) => toastApiError(e, t("vms.imageRemoveError"), qc),
  });
  const downloaded = s?.images.filter((i) => i.downloaded) ?? [];
  const set = (p: Partial<VmSettings>) => patch({ vm: p });
  const ensureGrant = useVaultGrant();
  const setVaultFill = async (vaultFill: boolean) => {
    if (vaultFill) {
      try {
        await ensureGrant(t("vms.grantReason"));
      } catch {
        return;
      }
    }
    set({ vaultFill });
  };
  // Another binary changes what the status reports (installed, version). Failures are toasted by the patch hook.
  const saveTartPath = (tartPath: string) =>
    void patchAsync({ vm: { tartPath: tartPath.trim() } })
      .then(() => qc.invalidateQueries({ queryKey: qk.vms }))
      .catch(() => undefined);

  return (
    <FeatureSection
      feature="vm"
      settings={settings}
      title={t("vms.title")}
      summary={t("vms.summary")}
      icon={<Box />}
      offNote={t("vms.offNote")}
      points={[
        { icon: <Box />, text: t("vms.pointOwn") },
        { icon: <Wrench />, text: t("vms.pointIsolated") },
        { icon: <Moon />, text: t("vms.pointIdle") },
      ]}
    >
      <div className="space-y-5">
        {s && !s.supported && (
          <Callout tone="warning" title={t("vms.unsupported")}>
            {s.reason ?? t("vms.unsupportedReason")}
          </Callout>
        )}

        <SettingsGroup
          title={t("vms.title")}
          icon={<Box />}
          actions={
            <Button variant="outline" size="sm" asChild>
              <Link to="/vms">
                {t("vms.manage")} <ArrowRight />
              </Link>
            </Button>
          }
        >
          <SettingRow
            label={t("vms.isolate")}
            htmlFor="vm-isolate"
            disabled={!v.enabled}
            description={t("vms.isolateDescription")}
          >
            <Switch id="vm-isolate" checked={v.isolateHostShell} disabled={!v.enabled} onCheckedChange={(isolateHostShell) => set({ isolateHostShell })} />
          </SettingRow>
          <SettingRow
            label={t("vms.idle")}
            htmlFor="vm-idle"
            description={t("vms.idleDescription")}
          >
            <NumberField
              id="vm-idle"
              min={0}
              max={1440}
              suffix={t("ai.limits.minutes")}
              value={v.idleStopMinutes}
              onCommit={(n) => n !== null && set({ idleStopMinutes: n })}
            />
          </SettingRow>
        </SettingsGroup>

        <SettingsGroup
          title={t("vms.fill.title")}
          icon={<KeyRound />}
          description={t("vms.fill.description")}
        >
          <SettingRow
            label={t("vms.fill.label")}
            htmlFor="vm-vault-fill"
            disabled={!v.enabled}
            description={t("vms.fill.labelDescription")}
          >
            <Switch id="vm-vault-fill" checked={v.vaultFill} disabled={!v.enabled} onCheckedChange={(on) => void setVaultFill(on)} />
          </SettingRow>
          <ul aria-label={t("vms.fill.howItWorks")} className="flex flex-wrap gap-2 py-3.5">
            <Fact icon={<EyeOff />}>{t("vms.fill.factTyped")}</Fact>
            <Fact icon={<RectangleEllipsis />}>{t("vms.fill.factPasswords")}</Fact>
            <Fact icon={<ScrollText />}>{t("vms.fill.factAudited")}</Fact>
            <Fact icon={<Globe />} caution>
              {t("vms.fill.factApps")}
            </Fact>
          </ul>
        </SettingsGroup>

        <SettingsGroup
          title={t("vms.quit.title")}
          icon={<Power />}
          description={t("vms.quit.description")}
          bodyClassName="py-4"
        >
          <ChoiceCards<VmSettings["onQuit"]>
            name="vm-on-quit"
            value={v.onQuit}
            onChange={(onQuit) => set({ onQuit })}
            className="@xl:grid-cols-3"
            options={[
              {
                value: "suspend",
                title: t("vms.quit.suspend"),
                icon: <Moon />,
                badge: <span className="rounded-[5px] border border-brand/25 bg-brand-soft px-1.5 py-px text-[10px] font-medium text-brand-strong">{t("modePicker.default")}</span>,
                description: t("vms.quit.suspendDescription"),
              },
              { value: "stop", title: t("common:actions.stop"), icon: <PowerOff />, description: t("vms.quit.stopDescription") },
              { value: "keep", title: t("vms.quit.keep"), icon: <Power />, description: t("vms.quit.keepDescription") },
            ]}
          />
        </SettingsGroup>

        <SettingsGroup
          title="Tart"
          icon={<Wrench />}
          description={
            <Trans t={t} i18nKey="vms.tart.description" components={{ link: <a href="https://tart.run" target="_blank" rel="noreferrer" className="underline underline-offset-2" /> }} />
          }
          actions={
            s?.supported && !s.tart.installed ? (
              <Button size="sm" onClick={() => install.mutate()} disabled={install.isPending}>
                {install.isPending && <Spinner />} {install.isPending ? t("computer.cua.installing") : t("computer.cua.install")}
              </Button>
            ) : undefined
          }
        >
          <InfoRow label={t("computer.cua.status")}>
            {s ? (
              <State ok={s.tart.installed}>
                {s.tart.installed
                  ? [s.tart.version ? `Tart ${s.tart.version}` : t("vms.tart.installed"), s.tart.managed ? t("vms.tart.ownCopy") : t("vms.tart.fromMac")].join(" · ")
                  : s.supported
                    ? t("vms.tart.notInstalled", { version: s.tart.bundledVersion })
                    : t("vms.tart.notAvailable")}
              </State>
            ) : (
              <State ok={null}>{t("vms.tart.checking")}</State>
            )}
          </InfoRow>
          {s?.tart.path && (
            <InfoRow label={t("vms.tart.binary")} mono>
              <span className="break-all">{short(s.tart.path)}</span>
            </InfoRow>
          )}
          <InfoRow label={t("vms.tart.storage")} mono>
            <span className="break-all">{s ? short(s.storageDir) : "…"}</span>
          </InfoRow>
          {s?.host.freeDiskGb != null && <InfoRow label={t("vms.tart.freeSpace")}>{t("vms.tart.gb", { size: s.host.freeDiskGb })}</InfoRow>}
          {downloaded.map((img) => (
            <SettingRow
              key={img.id}
              label={img.name}
              description={img.sizeBytes ? t("vms.tart.imageWithSize", { size: (img.sizeBytes / 1e9).toFixed(1) }) : t("vms.tart.image")}
            >
              <Button
                size="sm"
                variant="outline"
                disabled={removeImage.isPending && removeImage.variables === img.id}
                onClick={() => removeImage.mutate(img.id)}
              >
                {removeImage.isPending && removeImage.variables === img.id && <Spinner />} {t("common:actions.remove")}
              </Button>
            </SettingRow>
          ))}
          <SettingRow
            label={t("vms.tart.custom")}
            htmlFor="vm-tart-path"
            description={t("vms.tart.customDescription")}
          >
            <CommitInput
              id="vm-tart-path"
              className="w-72 font-mono text-[13px]"
              placeholder={t("vms.tart.ownCopy")}
              value={v.tartPath}
              onCommit={saveTartPath}
            />
          </SettingRow>
        </SettingsGroup>
      </div>
    </FeatureSection>
  );
}
