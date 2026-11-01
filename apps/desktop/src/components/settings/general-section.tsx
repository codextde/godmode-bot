import { useEffect, useState } from "react";
import { Bell, Clock, Sparkles, Gauge, Languages, Laptop, MessagesSquare, Monitor, Moon, Palette, Send, Sun, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { AppLanguage, Settings, TimeFormat } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useTheme } from "@/components/theme-provider";
import { THEME_SHORTCUT } from "@/components/layout/theme-toggle";
import { isTauri } from "@/lib/core";
import { paletteBlurb } from "@/lib/palettes";
import { notifyDesktop } from "@/lib/desktop";
import { errorMessage } from "@/lib/api";
import { useSetInterfaceMode } from "@/lib/mode";
import { useUi, type ToolCallView } from "@/stores/ui";
import { useLanguage } from "@/i18n/language";
import { ModePicker } from "./mode-picker";
import { PalettePicker } from "./palette-picker";
import { PowerGroup } from "./power-group";
import { CommitInput, Segmented, SectionHeading, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

type Theme = Settings["general"]["theme"];

const loadAutostart = () => import("@tauri-apps/plugin-autostart");

export function GeneralSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation(["settings", "common"]);
  const { language, setLanguage, timeFormat, setTimeFormat, systemHour12 } = useLanguage();
  const { patch } = useSettingsPatch();
  const { theme, resolved, palette, setTheme, setPalette } = useTheme();
  const g = settings.general;
  const { setMode } = useSetInterfaceMode();
  const reduceAnimations = useUi((s) => s.reduceAnimations);
  const setReduceAnimations = useUi((s) => s.setReduceAnimations);
  const toolCallView = useUi((s) => s.toolCallView);
  const setToolCallView = useUi((s) => s.setToolCallView);

  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    loadAutostart()
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
      const m = await loadAutostart();
      if (on) await m.enable();
      else await m.disable();
      setAutostart(on);
      patch({ general: { launchAtLogin: on } });
    } catch (e) {
      toast.error(t("general.launchAtLoginError"), { description: errorMessage(e) });
    }
    setAutostartBusy(false);
  };

  return (
    <div className="space-y-5">
      <SectionHeading title={t("general.title")} description={t("general.description")} />

      <SettingsGroup
        title={t("general.interface.title")}
        icon={<Gauge />}
        description={t("general.interface.description")}
        bodyClassName="p-5"
      >
        <ModePicker value={g.mode === "easy" ? "easy" : "pro"} onChange={(mode) => mode !== g.mode && setMode(mode)} />
      </SettingsGroup>

      <SettingsGroup title={t("general.profile.title")} icon={<UserRound />}>
        <SettingRow label={t("general.profile.name")} htmlFor="user-name" description={t("general.profile.nameDescription")}>
          <CommitInput
            id="user-name"
            className="w-56"
            placeholder={t("general.profile.namePlaceholder")}
            value={g.userName}
            onCommit={(userName) => patch({ general: { userName: userName.trim() } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("general.language.title")} icon={<Languages />}>
        <SettingRow label={t("general.language.label")} description={t("general.language.description")}>
          <Segmented<AppLanguage>
            aria-label={t("general.language.label")}
            value={language}
            onChange={setLanguage}
            options={[
              { value: "system", label: t("common:language.system"), icon: <Laptop /> },
              { value: "en", label: t("common:language.en") },
              { value: "de", label: t("common:language.de") },
            ]}
          />
        </SettingRow>
        <SettingRow
          label={t("general.timeFormat.label")}
          description={t("general.timeFormat.description", { example: systemHour12 ? t("general.timeFormat.h12") : t("general.timeFormat.h24") })}
        >
          <Segmented<TimeFormat>
            aria-label={t("general.timeFormat.label")}
            value={timeFormat}
            onChange={setTimeFormat}
            options={[
              { value: "system", label: t("general.timeFormat.system"), icon: <Clock /> },
              { value: "24h", label: t("general.timeFormat.h24") },
              { value: "12h", label: t("general.timeFormat.h12") },
            ]}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("general.appearance.title")} icon={<Palette />}>
        <SettingRow label={t("general.appearance.mode")} description={t("general.appearance.modeDescription", { shortcut: THEME_SHORTCUT })}>
          <Segmented<Theme>
            aria-label={t("general.appearance.mode")}
            value={theme}
            onChange={setTheme}
            options={[
              { value: "light", label: t("general.appearance.light"), icon: <Sun /> },
              { value: "dark", label: t("general.appearance.dark"), icon: <Moon /> },
              { value: "system", label: t("common:language.system"), icon: <Laptop /> },
            ]}
          />
        </SettingRow>
        <SettingRow label={t("general.appearance.palette")} description={paletteBlurb(palette)} stacked>
          <PalettePicker value={palette} mode={resolved} onChange={setPalette} />
        </SettingRow>
        <SettingRow
          label={t("general.appearance.reduceAnimations")}
          htmlFor="reduce-animations"
          description={t("general.appearance.reduceAnimationsDescription")}
        >
          <Switch id="reduce-animations" checked={reduceAnimations} onCheckedChange={setReduceAnimations} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("general.chat.title")} icon={<MessagesSquare />} description={t("general.chat.description")}>
        <SettingRow label={t("general.chat.toolCalls")} description={t("general.chat.toolCallsDescription")}>
          <Segmented<ToolCallView>
            aria-label={t("general.chat.toolCalls")}
            value={toolCallView}
            onChange={setToolCallView}
            options={[
              { value: "cards", label: t("general.chat.cards") },
              { value: "compact", label: t("general.chat.compact") },
            ]}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("general.summaries.title")} icon={<Sparkles />} description={t("general.summaries.description")}>
        <SettingRow label={t("general.summaries.chatTitles")} htmlFor="ai-chat-titles" description={t("general.summaries.chatTitlesDescription")}>
          <Switch id="ai-chat-titles" checked={g.aiChatTitles} onCheckedChange={(aiChatTitles) => patch({ general: { aiChatTitles } })} />
        </SettingRow>
        <SettingRow
          label={t("general.summaries.notifications")}
          htmlFor="ai-notification-summaries"
          description={t("general.summaries.notificationsDescription")}
        >
          <Switch
            id="ai-notification-summaries"
            checked={g.aiNotificationSummaries}
            onCheckedChange={(aiNotificationSummaries) => patch({ general: { aiNotificationSummaries } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("general.desktop.title")} icon={<Monitor />} description={isTauri ? undefined : t("general.desktop.onlyDesktop")}>
        <SettingRow
          label={t("general.desktop.launchAtLogin")}
          htmlFor="launch-at-login"
          disabled={!isTauri}
          description={isTauri ? t("general.desktop.launchAtLoginDescription") : t("general.desktop.desktopOnly")}
        >
          <Switch
            id="launch-at-login"
            checked={isTauri ? (autostart ?? g.launchAtLogin) : false}
            disabled={!isTauri || autostartBusy || autostart === null}
            onCheckedChange={toggleAutostart}
          />
        </SettingRow>
        <SettingRow
          label={t("general.desktop.tray")}
          htmlFor="minimize-to-tray"
          disabled={!isTauri}
          description={t("general.desktop.trayDescription")}
        >
          <Switch
            id="minimize-to-tray"
            checked={g.minimizeToTray}
            disabled={!isTauri}
            onCheckedChange={(minimizeToTray) => patch({ general: { minimizeToTray } })}
          />
        </SettingRow>
      </SettingsGroup>

      <PowerGroup settings={settings} />

      <SettingsGroup title={t("general.notifications.title")} icon={<Bell />}>
        <SettingRow
          label={t("general.notifications.desktop")}
          htmlFor="desktop-notifications"
          description={t("general.notifications.desktopDescription")}
        >
          <Button
            variant="ghost"
            size="sm"
            disabled={!g.desktopNotifications}
            onClick={() => {
              void notifyDesktop("Godmode Bot", t("general.notifications.testBody"));
              toast.info(t("general.notifications.testSent"), { description: t("general.notifications.testHint") });
            }}
          >
            <Send /> {t("general.notifications.test")}
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
