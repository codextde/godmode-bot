import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, Globe2, KeyRound, Lock, LockKeyhole, MonitorSmartphone, ShieldCheck, Wand2 } from "lucide-react";
import { toast } from "sonner";
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
      toast.success("Vault locked");
      void qc.invalidateQueries({ queryKey: qk.vaultStatus });
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
    },
    onError: (e) => toastApiError(e, "Could not lock the vault", qc),
  });

  const remember = useMutation({
    // Storing the vault key on this device needs the vault passphrase (asked for when the core requires it).
    mutationFn: (on: boolean) => withGrant((grant) => api.vault.remember(on, grant)),
    onSuccess: (status, on) => {
      qc.setQueryData(qk.vaultStatus, status);
      void qc.invalidateQueries({ queryKey: qk.bootstrap });
      toast.success(on ? "This device will unlock automatically" : "Device key removed", {
        description: on ? "The vault key is stored in your OS keychain." : "You'll enter your passphrase after every restart.",
      });
    },
    onError: (e) => !isGrantCancelled(e) && toastApiError(e, "Could not change device unlock", qc),
  });

  const rememberOn = remember.isPending ? !!remember.variables : !!vault?.rememberDevice;

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Security"
        description="Your vault, how agents may use secrets, and who can reach the dashboard. Every secret access is audited."
      />

      <SettingsGroup
        title="Vault"
        icon={<LockKeyhole />}
        description="AES-256-GCM encrypted. The key is derived from your passphrase and only lives in memory — or in your OS keychain if you allow it."
        actions={
          <Badge variant="outline" className={cn("gap-1.5 font-normal", vault?.unlocked ? "border-brand/25 bg-brand-soft text-brand-strong" : "text-muted-foreground")}>
            <span className={cn("size-1.5 rounded-full", vault?.unlocked ? "bg-brand" : "bg-muted-foreground")} />
            {vault?.unlocked ? "Unlocked" : "Locked"}
          </Badge>
        }
      >
        <SettingRow label="Lock vault now" description="Agents can't use logins or 2FA codes until you unlock again.">
          <Button variant="outline" size="sm" onClick={() => lock.mutate()} disabled={lock.isPending || !vault?.unlocked}>
            {lock.isPending ? <Spinner /> : <Lock />} Lock now
          </Button>
        </SettingRow>
        <SettingRow label="Passphrase" description="Change the passphrase that protects your vault.">
          <Button variant="outline" size="sm" onClick={() => setPassphraseOpen(true)}>
            <KeyRound /> Change…
          </Button>
        </SettingRow>
        <SettingRow
          label="Remember on this device"
          htmlFor="remember-device"
          description="Stores the vault key in the macOS Keychain / Windows Credential Manager so routines can run unattended after a restart. Turn off for maximum security on shared machines."
        >
          <Switch id="remember-device" checked={rememberOn} disabled={remember.isPending} onCheckedChange={(on) => remember.mutate(on)} />
        </SettingRow>
        <SettingRow label="Auto-lock" htmlFor="auto-lock" description="Lock the vault after this many idle minutes. 0 = never.">
          <NumberField
            id="auto-lock"
            min={0}
            max={10080}
            suffix="min"
            value={sec.autoLockMinutes}
            onCommit={(v) => v !== null && patch({ security: { autoLockMinutes: v } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Agents & secrets" icon={<ShieldCheck />} description="Defaults for new agents. Each agent can be adjusted individually.">
        <div className="space-y-2 py-4">
          <p className="text-sm font-medium">Default secret access</p>
          <ChoiceCards<SecretAccessMode>
            name="secret-access"
            value={sec.defaultSecretAccess}
            onChange={(defaultSecretAccess) => void setDefaultSecretAccess(defaultSecretAccess)}
            options={[
              {
                value: "fill",
                icon: <Wand2 />,
                title: "Fill only",
                badge: (
                  <Badge variant="secondary" className="h-5 text-[10px]">
                    Recommended
                  </Badge>
                ),
                description: "Godmode types passwords and 2FA codes straight into the page. The AI never sees them.",
              },
              {
                value: "reveal",
                icon: <Eye />,
                title: "Allow reveal",
                description: "The AI may read raw passwords and codes — needed for API-only tools. Every reveal is audited.",
              },
            ]}
          />
        </div>
        <SettingRow
          label="Redact secrets"
          htmlFor="redact"
          description="Mask every known password, token and code in transcripts, run logs and the live stream."
        >
          <Switch id="redact" checked={sec.redactSecrets} onCheckedChange={(redactSecrets) => patch({ security: { redactSecrets } })} />
        </SettingRow>
        <SettingRow
          label="Load website icons"
          htmlFor="site-icons"
          description="Show login icons from Google's favicon service. This tells Google which sites you have saved; turn off for maximum privacy."
        >
          <Switch id="site-icons" checked={sec.fetchSiteIcons} onCheckedChange={(fetchSiteIcons) => patch({ security: { fetchSiteIcons } })} />
        </SettingRow>
        <SettingRow label="Keep audit log for" htmlFor="audit-retention" description="Older entries are pruned automatically.">
          <NumberField
            id="audit-retention"
            min={1}
            max={3650}
            suffix="days"
            value={sec.auditRetentionDays}
            onCommit={(v) => v !== null && patch({ security: { auditRetentionDays: v } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title="Web dashboard"
        icon={<MonitorSmartphone />}
        description={<InlineCode text="Use Godmode from any browser with `godmode serve`. Host, port and remote access apply after a restart." />}
      >
        <SettingRow
          label="Dashboard password"
          description={
            srv.hasDashboardPassword ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-success" /> Password is set
              </span>
            ) : (
              <InlineCode text="Not set — only the access token (`godmode token`) can sign in." />
            )
          }
        >
          <Button variant="outline" size="sm" onClick={() => setDashboardOpen(true)}>
            <KeyRound /> {srv.hasDashboardPassword ? "Change…" : "Set password…"}
          </Button>
        </SettingRow>
        <SettingRow
          label="Allow remote access"
          htmlFor="remote-access"
          description="Listen on your network instead of only this computer (127.0.0.1)."
        >
          <Switch
            id="remote-access"
            checked={srv.remoteAccess}
            onCheckedChange={(on) => (on ? setConfirmRemote(true) : patch({ server: { remoteAccess: false } }))}
          />
        </SettingRow>
        {srv.remoteAccess && (
          <div className="py-4">
            <Callout tone="danger" title="Only expose Godmode through a reverse proxy with TLS">
              Anyone who reaches this port can try to sign in to a coworker with full access to your machine and vault. Put it behind HTTPS (e.g.
              Caddy, Cloudflare Tunnel or Tailscale), set a strong dashboard password, and restrict allowed origins.
              {!srv.hasDashboardPassword && <strong className="mt-1 block text-destructive">No dashboard password is set yet.</strong>}
            </Callout>
          </div>
        )}
        <SettingRow label="Host" htmlFor="host" description={srv.remoteAccess ? "e.g. 0.0.0.0 for all interfaces." : "Loopback only while remote access is off."}>
          <CommitInput
            id="host"
            className="w-44 font-mono text-[13px]"
            placeholder="127.0.0.1"
            value={srv.host}
            onCommit={(host) => patch({ server: { host: host.trim() } })}
          />
        </SettingRow>
        <SettingRow label="Port" htmlFor="port">
          <NumberField id="port" min={1} max={65535} value={srv.port} onCommit={(v) => v !== null && patch({ server: { port: v } })} />
        </SettingRow>
        <SettingRow
          stacked
          label="Allowed origins"
          htmlFor="origins"
          description="Extra origins allowed to call the API (one per line), e.g. the HTTPS URL of your reverse proxy."
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
              <Globe2 className="size-5 text-destructive" /> Allow remote access?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Godmode will accept connections from other devices after a restart. Only do this behind a reverse proxy with TLS, and set a strong
              dashboard password first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => patch({ server: { remoteAccess: true } })}>
              Allow remote access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
