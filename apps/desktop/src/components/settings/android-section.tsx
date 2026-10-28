import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AppWindow, CircleCheck, CircleDashed, Eye, EyeOff, KeyRound, RectangleEllipsis, ScrollText, Smartphone, Terminal, Usb, UserCheck, Wrench } from "lucide-react";
import { toast } from "sonner";
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
  const { patch, patchAsync } = useSettingsPatch();
  const a = settings.android;
  const qc = useQueryClient();
  const status = useAndroidStatus();
  const s = status.data;
  const short = useShortPath();
  const install = useMutation({
    mutationFn: api.android.install,
    onSuccess: (res) => {
      if (res.ok) toast.success("adb is ready");
      else toast.error("adb couldn't be installed", { description: res.output || undefined });
      void qc.invalidateQueries({ queryKey: qk.android });
    },
    onError: (e) => toastApiError(e, "adb couldn't be installed", qc),
  });
  const set = (p: Partial<AndroidSettings>) => patch({ android: p });
  const ensureGrant = useVaultGrant();
  const setVaultFill = async (vaultFill: boolean) => {
    if (vaultFill) {
      try {
        await ensureGrant("Enter your vault passphrase to let agents type your logins and 2FA codes into phones.");
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
      title="Android phones"
      summary="Agents use real Android phones and emulators connected to this computer by USB or Wi-Fi: they see the screen, tap, type, open apps and run shell commands."
      icon={<Smartphone />}
      points={[
        { icon: <Usb />, text: "Phones and emulators over USB or Wi-Fi" },
        { icon: <Eye />, text: "Watch live and take over any time" },
        { icon: <UserCheck />, text: "Only the agents and chats you give a phone" },
      ]}
    >
      <div className="space-y-8">
        <AndroidOverview />
        <div className="space-y-5">
          {s?.error && (
            <Callout tone="warning" title="Godmode can't list the phones">
              {s.error}
            </Callout>
          )}
          <SettingsGroup
            title="Logins and 2FA codes"
            icon={<KeyRound />}
            description="Let agents sign in to apps and websites on a phone with the logins and 2FA codes from your vault."
          >
            <SettingRow
              label="Type logins and 2FA codes into phones"
              htmlFor="android-vault-fill"
              description="Godmode types saved logins into password fields on the phone. Whatever is typed on a phone can be read through its shell, so only agents you allow to see passwords get this; the others ask you to sign in on the phone. Turning this on asks for your vault passphrase."
            >
              <Switch id="android-vault-fill" checked={a.vaultFill} onCheckedChange={(on) => void setVaultFill(on)} />
            </SettingRow>
            <ul aria-label="How it works" className="flex flex-wrap gap-2 py-3.5">
              <Fact icon={<EyeOff />}>Only agents that may see passwords</Fact>
              <Fact icon={<RectangleEllipsis />}>Passwords only into password fields</Fact>
              <Fact icon={<ScrollText />}>Every fill audited</Fact>
              <Fact icon={<AppWindow />} caution>
                Not bound to an app
              </Fact>
              <Fact icon={<Terminal />} caution>
                Readable through the shell
              </Fact>
            </ul>
          </SettingsGroup>

          <SettingsGroup
            title="adb"
            icon={<Wrench />}
            description="Android Debug Bridge, from Google's platform-tools. Godmode reaches the phones through it."
            actions={
              s && !s.adb.installed && s.canInstall ? (
                <Button size="sm" onClick={() => install.mutate()} disabled={install.isPending}>
                  {install.isPending && <Spinner />} {install.isPending ? "Installing…" : "Install"}
                </Button>
              ) : undefined
            }
          >
            <InfoRow label="Status">
              {s ? (
                <State ok={s.adb.installed}>
                  {s.adb.installed
                    ? [s.adb.version ? `adb ${s.adb.version}` : "Installed", s.adb.managed ? "Godmode's own copy" : "found on this computer"].join(" · ")
                    : s.canInstall
                      ? "Not installed — Godmode can download it from Google"
                      : "Not installed — install Android's platform-tools"}
                </State>
              ) : (
                <State ok={null}>Checking…</State>
              )}
            </InfoRow>
            {s?.adb.path && (
              <InfoRow label="Binary" mono>
                <span className="break-all">{short(s.adb.path)}</span>
              </InfoRow>
            )}
            <SettingRow
              label="Custom adb binary"
              htmlFor="android-adb-path"
              description="Leave empty to use the one from the Android SDK, your PATH or Homebrew, else Godmode's own copy."
            >
              <CommitInput
                id="android-adb-path"
                className="w-72 font-mono text-[13px]"
                placeholder="Found automatically"
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
