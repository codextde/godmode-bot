import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AppWindow, CircleCheck, CircleDashed, Eye, EyeOff, KeyRound, RectangleEllipsis, ScrollText, Smartphone, Terminal, Usb, UserCheck, Wrench } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { AndroidSettings, Settings } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { AndroidOverview } from "@/components/android/android-overview";
import { useShortPath } from "@/components/chat/folder-picker";
import { useVaultGrant } from "@/components/vault/grant";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { useAndroidStatus } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { FeatureSection } from "./feature-section";
import { Callout, CommitInput, InfoRow, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

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

export function AndroidSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const { patch, patchAsync } = useSettingsPatch();
  const a = settings.android;
  const qc = useQueryClient();
  const status = useAndroidStatus();
  const s = status.data;
  const short = useShortPath();
  const install = useMutation({
    mutationFn: api.android.install,
    onSuccess: (res) => {
      if (res.ok) toast.success(t("android.adbReady"));
      else toast.error(t("android.adbInstallError"), { description: res.output || undefined });
      void qc.invalidateQueries({ queryKey: qk.android });
    },
    onError: (e) => toastApiError(e, t("android.adbInstallError"), qc),
  });
  const set = (p: Partial<AndroidSettings>) => patch({ android: p });
  const ensureGrant = useVaultGrant();
  const setVaultFill = async (vaultFill: boolean) => {
    if (vaultFill) {
      try {
        await ensureGrant(t("android.grantReason"));
      } catch {
        return;
      }
    }
    set({ vaultFill });
  };
  // Another binary changes what the status reports (installed, version). Failures are toasted by the patch hook.
  const saveAdbPath = (adbPath: string) =>
    void patchAsync({ android: { adbPath: adbPath.trim() } })
      .then(() => qc.invalidateQueries({ queryKey: qk.android }))
      .catch(() => undefined);

  return (
    <FeatureSection
      feature="android"
      settings={settings}
      title={t("android.title")}
      summary={t("android.summary")}
      icon={<Smartphone />}
      points={[
        { icon: <Usb />, text: t("android.pointUsb") },
        { icon: <Eye />, text: t("android.pointWatch") },
        { icon: <UserCheck />, text: t("android.pointAccess") },
      ]}
    >
      <div className="space-y-8">
        <AndroidOverview />
        <div className="space-y-5">
          {s?.error && (
            <Callout tone="warning" title={t("android.listError")}>
              {s.error}
            </Callout>
          )}
          <SettingsGroup
            title={t("vms.fill.title")}
            icon={<KeyRound />}
            description={t("android.fill.description")}
          >
            <SettingRow
              label={t("android.fill.label")}
              htmlFor="android-vault-fill"
              description={t("android.fill.labelDescription")}
            >
              <Switch id="android-vault-fill" checked={a.vaultFill} onCheckedChange={(on) => void setVaultFill(on)} />
            </SettingRow>
            <ul aria-label={t("vms.fill.howItWorks")} className="flex flex-wrap gap-2 py-3.5">
              <Fact icon={<EyeOff />}>{t("android.fill.factAgents")}</Fact>
              <Fact icon={<RectangleEllipsis />}>{t("vms.fill.factPasswords")}</Fact>
              <Fact icon={<ScrollText />}>{t("vms.fill.factAudited")}</Fact>
              <Fact icon={<AppWindow />} caution>
                {t("android.fill.factApp")}
              </Fact>
              <Fact icon={<Terminal />} caution>
                {t("android.fill.factShell")}
              </Fact>
            </ul>
          </SettingsGroup>

          <SettingsGroup
            title="adb"
            icon={<Wrench />}
            description={t("android.adb.description")}
            actions={
              s && !s.adb.installed && s.canInstall ? (
                <Button size="sm" onClick={() => install.mutate()} disabled={install.isPending}>
                  {install.isPending && <Spinner />} {install.isPending ? t("computer.cua.installing") : t("computer.cua.install")}
                </Button>
              ) : undefined
            }
          >
            <InfoRow label={t("computer.cua.status")}>
              {s ? (
                <State ok={s.adb.installed}>
                  {s.adb.installed
                    ? [s.adb.version ? `adb ${s.adb.version}` : t("vms.tart.installed"), s.adb.managed ? t("vms.tart.ownCopy") : t("android.adb.found")].join(" · ")
                    : s.canInstall
                      ? t("android.adb.notInstalledCanInstall")
                      : t("android.adb.notInstalled")}
                </State>
              ) : (
                <State ok={null}>{t("vms.tart.checking")}</State>
              )}
            </InfoRow>
            {s?.adb.path && (
              <InfoRow label={t("vms.tart.binary")} mono>
                <span className="break-all">{short(s.adb.path)}</span>
              </InfoRow>
            )}
            <SettingRow
              label={t("android.adb.custom")}
              htmlFor="android-adb-path"
              description={t("android.adb.customDescription")}
            >
              <CommitInput
                id="android-adb-path"
                className="w-72 font-mono text-[13px]"
                placeholder={t("android.adb.auto")}
                value={a.adbPath}
                onCommit={saveAdbPath}
              />
            </SettingRow>
          </SettingsGroup>
        </div>
      </div>
    </FeatureSection>
  );
}
