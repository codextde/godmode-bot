import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, Globe2, KeyRound, Lock, LockKeyhole, MonitorSmartphone, ShieldCheck, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import type { SecretAccessMode, Settings } from "@godmode/shared";
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
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { InlineCode } from "@/components/onboarding/doctor-checklist";
import { isGrantCancelled, useVaultGrant, withGrant } from "@/components/vault/grant";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { useBootstrap, useVaultStatus } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { AuditLog } from "./audit-log";
import { ChangePassphraseDialog, DashboardPasswordDialog } from "./password-dialogs";
import {
  Callout,
  ChoiceCards,
  CommitInput,
  LinesTextarea,
  NumberField,
  SectionHeading,
  SettingRow,
  SettingsGroup,
  useSettingsPatch,
} from "./settings-kit";

export function SecuritySection({ settings }: { settings: Settings }) {
  const { t } = useTranslation(["settings", "common"]);
  const qc = useQueryClient();
  const { patch } = useSettingsPatch();
  const { data: boot } = useBootstrap();
  const { data: vaultStatus } = useVaultStatus();
  const vault = vaultStatus ?? boot?.vault;
  const sec = settings.security;
  const srv = settings.server;

  const [passphraseOpen, setPassphraseOpen] = useState(false);
  const [dashboardOpen, setDashboardOpen] = useState(false);
  const [confirmRemote, setConfirmRemote] = useState(false);
  const ensureGrant = useVaultGrant();

  // Making "reveal" the default for new agents needs the vault passphrase.
  const setDefaultSecretAccess = async (defaultSecretAccess: SecretAccessMode) => {
    if (defaultSecretAccess === "reveal" && sec.defaultSecretAccess !== "reveal") {
      try {
        await ensureGrant();
      } catch {
        return;
      }
    }
    patch({ security: { defaultSecretAccess } });
  };

  const lock = useMutation({
    mutationFn: api.vault.lock,
    onSuccess: () => {
      toast.success(t("security.locked"));
      void qc.invalidateQueries({ queryKey: qk.vaultStatus });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
    onError: (e) => toastApiError(e, t("security.lockError"), qc),
  });

  const remember = useMutation({
    // Storing the vault key on this device needs the vault passphrase (asked for when the core requires it).
    mutationFn: (on: boolean) => withGrant((grant) => api.vault.remember(on, grant)),
    onSuccess: (status, on) => {
      qc.setQueryData(qk.vaultStatus, status);
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      toast.success(on ? t("security.rememberOn") : t("security.rememberOff"), {
        description: on ? t("security.rememberOnDescription") : t("security.rememberOffDescription"),
      });
    },
    onError: (e) => !isGrantCancelled(e) && toastApiError(e, t("security.rememberError"), qc),
  });

  const rememberOn = remember.isPending ? !!remember.variables : !!vault?.rememberDevice;

  return (
    <div className="space-y-5">
      <SectionHeading title={t("security.title")} description={t("security.description")} />

      <SettingsGroup
        title={t("security.vault.title")}
        icon={<LockKeyhole />}
        description={t("security.vault.description")}
        actions={
          <Badge variant="outline" className={cn("gap-1.5 font-normal", vault?.unlocked ? "border-brand/25 bg-brand-soft text-brand-strong" : "text-muted-foreground")}>
            <span className={cn("size-1.5 rounded-full", vault?.unlocked ? "bg-brand" : "bg-muted-foreground")} />
            {vault?.unlocked ? t("security.vault.unlocked") : t("security.vault.lockedBadge")}
          </Badge>
        }
      >
        <SettingRow label={t("security.vault.lock")} description={t("security.vault.lockDescription")}>
          <Button variant="outline" size="sm" onClick={() => lock.mutate()} disabled={lock.isPending || !vault?.unlocked}>
            {lock.isPending ? <Spinner /> : <Lock />} {t("security.vault.lockNow")}
          </Button>
        </SettingRow>
        <SettingRow label={t("security.vault.passphrase")} description={t("security.vault.passphraseDescription")}>
          <Button variant="outline" size="sm" onClick={() => setPassphraseOpen(true)}>
            <KeyRound /> {t("security.change")}
          </Button>
        </SettingRow>
        <SettingRow
          label={t("security.vault.remember")}
          htmlFor="remember-device"
          description={t("security.vault.rememberDescription")}
        >
          <Switch id="remember-device" checked={rememberOn} disabled={remember.isPending} onCheckedChange={(on) => remember.mutate(on)} />
        </SettingRow>
        <SettingRow label={t("security.vault.autoLock")} htmlFor="auto-lock" description={t("security.vault.autoLockDescription")}>
          <NumberField
            id="auto-lock"
            min={0}
            max={10080}
            suffix={t("ai.limits.minutes")}
            value={sec.autoLockMinutes}
            onCommit={(v) => v !== null && patch({ security: { autoLockMinutes: v } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("security.secrets.title")} icon={<ShieldCheck />} description={t("security.secrets.description")}>
        <div className="space-y-2 py-4">
          <p className="text-sm font-medium">{t("security.secrets.defaultAccess")}</p>
          <ChoiceCards<SecretAccessMode>
            name="secret-access"
            value={sec.defaultSecretAccess}
            onChange={(defaultSecretAccess) => void setDefaultSecretAccess(defaultSecretAccess)}
            options={[
              {
                value: "fill",
                icon: <Wand2 />,
                title: t("security.secrets.fill"),
                badge: (
                  <Badge variant="secondary" className="h-5 text-[10px]">
                    {t("memory.backend.recommended")}
                  </Badge>
                ),
                description: t("security.secrets.fillDescription"),
              },
              {
                value: "reveal",
                icon: <Eye />,
                title: t("security.secrets.reveal"),
                description: t("security.secrets.revealDescription"),
              },
            ]}
          />
        </div>
        <SettingRow
          label={t("security.secrets.redact")}
          htmlFor="redact"
          description={t("security.secrets.redactDescription")}
        >
          <Switch id="redact" checked={sec.redactSecrets} onCheckedChange={(redactSecrets) => patch({ security: { redactSecrets } })} />
        </SettingRow>
        <SettingRow
          label={t("security.secrets.icons")}
          htmlFor="site-icons"
          description={t("security.secrets.iconsDescription")}
        >
          <Switch id="site-icons" checked={sec.fetchSiteIcons} onCheckedChange={(fetchSiteIcons) => patch({ security: { fetchSiteIcons } })} />
        </SettingRow>
        <SettingRow label={t("security.secrets.retention")} htmlFor="audit-retention" description={t("security.secrets.retentionDescription")}>
          <NumberField
            id="audit-retention"
            min={1}
            max={3650}
            suffix={t("security.secrets.days")}
            value={sec.auditRetentionDays}
            onCommit={(v) => v !== null && patch({ security: { auditRetentionDays: v } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title={t("security.web.title")}
        icon={<MonitorSmartphone />}
        description={<InlineCode text={t("security.web.description")} />}
      >
        <SettingRow
          label={t("security.web.password")}
          description={
            srv.hasDashboardPassword ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-success" /> {t("security.web.passwordSet")}
              </span>
            ) : (
              <InlineCode text={t("security.web.passwordNotSet")} />
            )
          }
        >
          <Button variant="outline" size="sm" onClick={() => setDashboardOpen(true)}>
            <KeyRound /> {srv.hasDashboardPassword ? t("security.change") : t("security.web.setPassword")}
          </Button>
        </SettingRow>
        <SettingRow
          label={t("security.web.remote")}
          htmlFor="remote-access"
          description={t("security.web.remoteDescription")}
        >
          <Switch
            id="remote-access"
            checked={srv.remoteAccess}
            onCheckedChange={(on) => (on ? setConfirmRemote(true) : patch({ server: { remoteAccess: false } }))}
          />
        </SettingRow>
        {srv.remoteAccess && (
          <div className="py-4">
            <Callout tone="danger" title={t("security.web.exposeTitle")}>
              {t("security.web.exposeBody")}
              {!srv.hasDashboardPassword && <strong className="mt-1 block text-destructive">{t("security.web.noPassword")}</strong>}
            </Callout>
          </div>
        )}
        <SettingRow label={t("security.web.host")} htmlFor="host" description={srv.remoteAccess ? t("security.web.hostRemote") : t("security.web.hostLocal")}>
          <CommitInput
            id="host"
            className="w-44 font-mono text-[13px]"
            placeholder="127.0.0.1"
            value={srv.host}
            onCommit={(host) => patch({ server: { host: host.trim() } })}
          />
        </SettingRow>
        <SettingRow label={t("security.web.port")} htmlFor="port">
          <NumberField id="port" min={1} max={65535} value={srv.port} onCommit={(v) => v !== null && patch({ server: { port: v } })} />
        </SettingRow>
        <SettingRow
          stacked
          label={t("security.web.origins")}
          htmlFor="origins"
          description={t("security.web.originsDescription")}
        >
          <LinesTextarea
            id="origins"
            placeholder="https://godmode.example.com"
            value={srv.allowedOrigins}
            onCommit={(allowedOrigins) => patch({ server: { allowedOrigins } })}
          />
        </SettingRow>
      </SettingsGroup>

      <AuditLog />

      <ChangePassphraseDialog open={passphraseOpen} onOpenChange={setPassphraseOpen} />
      <DashboardPasswordDialog open={dashboardOpen} onOpenChange={setDashboardOpen} hasPassword={srv.hasDashboardPassword} />

      <AlertDialog open={confirmRemote} onOpenChange={setConfirmRemote}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Globe2 className="size-5 text-destructive" /> {t("security.remoteConfirm.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("security.remoteConfirm.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => patch({ server: { remoteAccess: true } })}>
              {t("security.web.remote")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
