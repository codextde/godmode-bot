import { useEffect, useState } from "react";
import { Bell, Laptop, Monitor, Moon, Palette, Send, Sun, UserRound } from "lucide-react";
import { toast } from "sonner";
import type { Settings } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/components/theme-provider";
import { isTauri } from "@/lib/core";
import { notifyDesktop } from "@/lib/desktop";
import { errorMessage } from "@/lib/api";
import { CommitInput, Segmented, SectionHeading, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

type Theme = Settings["general"]["theme"];

export function GeneralSection({ settings }: { settings: Settings }) {
  const { patch } = useSettingsPatch();
  const { theme, setTheme } = useTheme();
  const g = settings.general;

  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    import("@tauri-apps/plugin-autostart")
      .then((m) => m.isEnabled())
      .then((v) => !cancelled && setAutostart(v))
      .catch(() => !cancelled && setAutostart(g.launchAtLogin));
    return () => {
      cancelled = true;
    };
  }, [g.launchAtLogin]);

  const toggleAutostart = async (on: boolean) => {
    setAutostartBusy(true);
    try {
      const m = await import("@tauri-apps/plugin-autostart");
      if (on) await m.enable();
      else await m.disable();
      setAutostart(on);
      patch({ general: { launchAtLogin: on } });
    } catch (e) {
      toast.error("Could not change launch at login", { description: errorMessage(e) });
    } finally {
      setAutostartBusy(false);
    }
  };

  const changeTheme = (t: Theme) => {
    setTheme(t);
    patch({ general: { theme: t } });
  };

  return (
    <div className="space-y-5">
      <SectionHeading title="General" description="How Godmode greets you, looks and behaves on your desktop." />

      <SettingsGroup title="Profile" icon={<UserRound />}>
        <SettingRow label="Your name" htmlFor="user-name" description="Agents use it to address you and sign messages on your behalf.">
          <CommitInput
            id="user-name"
            className="w-56"
            placeholder="e.g. Alex"
            value={g.userName}
            onCommit={(userName) => patch({ general: { userName: userName.trim() } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Appearance" icon={<Palette />}>
        <SettingRow label="Theme" description="Dark is the signature look. System follows your OS setting.">
          <Segmented<Theme>
            aria-label="Theme"
            value={theme}
            onChange={changeTheme}
            options={[
              { value: "dark", label: "Dark", icon: <Moon /> },
              { value: "light", label: "Light", icon: <Sun /> },
              { value: "system", label: "System", icon: <Laptop /> },
            ]}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Desktop" icon={<Monitor />} description={isTauri ? undefined : "These options only apply to the desktop app."}>
        <SettingRow
          label="Launch at login"
          htmlFor="launch-at-login"
          disabled={!isTauri}
          description={isTauri ? "Start Godmode in the background when you sign in, so routines keep running." : "Desktop app only."}
        >
          <Switch
            id="launch-at-login"
            checked={isTauri ? (autostart ?? g.launchAtLogin) : false}
            disabled={!isTauri || autostartBusy || autostart === null}
            onCheckedChange={toggleAutostart}
          />
        </SettingRow>
        <SettingRow
          label="Keep running in the menu bar"
          htmlFor="minimize-to-tray"
          disabled={!isTauri}
          description="Closing the window hides Godmode to the tray instead of quitting — agents and routines keep working."
        >
          <Switch
            id="minimize-to-tray"
            checked={g.minimizeToTray}
            disabled={!isTauri}
            onCheckedChange={(minimizeToTray) => patch({ general: { minimizeToTray } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Notifications" icon={<Bell />}>
        <SettingRow
          label="Desktop notifications"
          htmlFor="desktop-notifications"
          description="Get notified when a task finishes, a routine fails, or an agent needs a login from you."
        >
          <Button
            variant="ghost"
            size="sm"
            disabled={!g.desktopNotifications}
            onClick={() => {
              void notifyDesktop("Godmode Bot", "Notifications are working. You'll hear from your agents here.");
              toast.info("Test notification sent", { description: "If nothing appeared, check your OS notification permissions." });
            }}
          >
            <Send /> Test
          </Button>
          <Switch
            id="desktop-notifications"
            checked={g.desktopNotifications}
            onCheckedChange={(desktopNotifications) => patch({ general: { desktopNotifications } })}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}
