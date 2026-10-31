import { Link } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { AppWindow, ArrowRight, Eye, Fingerprint, Globe, Wrench } from "lucide-react";
import type { Settings } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { BotCheck } from "./bot-check";
import { CaptchaSolving } from "./captcha-solving";
import { CommitInput, NumberField, SectionHeading, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

export function BrowserSection({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const { patch } = useSettingsPatch();
  const b = settings.browser;

  return (
    <div className="space-y-5">
      <SectionHeading title={t("browser.title")} description={t("browser.description")} />

      <SettingsGroup
        title={t("browser.web.title")}
        icon={<Globe />}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/browser">
              {t("browser.web.profiles")} <ArrowRight />
            </Link>
          </Button>
        }
      >
        <SettingRow label={t("browser.web.enabled")} htmlFor="browser-enabled" description={t("browser.web.enabledDescription")}>
          <Switch id="browser-enabled" checked={b.enabled} onCheckedChange={(enabled) => patch({ browser: { enabled } })} />
        </SettingRow>
        <SettingRow
          label={t("browser.web.headless")}
          htmlFor="headless"
          disabled={!b.enabled}
          description={t("browser.web.headlessDescription")}
        >
          <Switch id="headless" checked={b.headless} disabled={!b.enabled} onCheckedChange={(headless) => patch({ browser: { headless } })} />
        </SettingRow>
        <SettingRow
          label={t("browser.web.mute")}
          htmlFor="mute-audio"
          disabled={!b.enabled}
          description={t("browser.web.muteDescription")}
        >
          <Switch id="mute-audio" checked={b.muteAudio} disabled={!b.enabled} onCheckedChange={(muteAudio) => patch({ browser: { muteAudio } })} />
        </SettingRow>
        <SettingRow
          label={t("browser.web.passkeys")}
          htmlFor="passkeys"
          disabled={!b.enabled}
          description={
            <>
              {t("browser.web.passkeysDescription")}{" "}
              <Link to="/vault/passkeys" className="font-medium text-foreground underline-offset-4 hover:underline">
                {t("browser.web.savedPasskeys")}
              </Link>
            </>
          }
        >
          <Switch id="passkeys" checked={b.passkeys} disabled={!b.enabled} onCheckedChange={(passkeys) => patch({ browser: { passkeys } })} />
        </SettingRow>
        <SettingRow
          label={t("browser.web.keepAlive")}
          htmlFor="keep-alive"
          disabled={!b.enabled}
          description={t("browser.web.keepAliveDescription")}
        >
          <NumberField
            id="keep-alive"
            min={0}
            max={1440}
            suffix={t("ai.limits.minutes")}
            disabled={!b.enabled}
            value={b.keepAliveMinutes}
            onCommit={(v) => v !== null && patch({ browser: { keepAliveMinutes: v } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title={t("browser.bot.title")}
        icon={<Fingerprint />}
        description={t("browser.bot.description")}
      >
        <SettingRow
          label={t("browser.bot.stealth")}
          htmlFor="stealth"
          disabled={!b.enabled}
          description={t("browser.bot.stealthDescription")}
        >
          <Switch id="stealth" checked={b.stealth} disabled={!b.enabled} onCheckedChange={(stealth) => patch({ browser: { stealth } })} />
        </SettingRow>
        <BotCheck browser={b} />
      </SettingsGroup>

      <CaptchaSolving browser={b} />

      <SettingsGroup title={t("browser.live.title")} icon={<Eye />}>
        <SettingRow
          label={t("browser.live.stream")}
          htmlFor="live-view"
          description={t("browser.live.streamDescription")}
        >
          <Switch id="live-view" checked={b.liveView} onCheckedChange={(liveView) => patch({ browser: { liveView } })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t("browser.advanced.title")} icon={<Wrench />} description={t("browser.advanced.description")}>
        <SettingRow label={t("browser.advanced.chromePath")} htmlFor="chrome-path" description={t("browser.advanced.chromePathDescription")}>
          <CommitInput
            id="chrome-path"
            className="w-72 font-mono text-[13px]"
            placeholder={t("ai.cli.autoDetect")}
            value={b.chromePath}
            onCommit={(chromePath) => patch({ browser: { chromePath: chromePath.trim() } })}
          />
        </SettingRow>
        <SettingRow
          label={t("browser.advanced.command")}
          htmlFor="browser-use-cmd"
          description={
            <Trans t={t} i18nKey="browser.advanced.commandDescription" values={{ command: "uvx browser-use --mcp" }} components={{ code: <code className="rounded-[4px] bg-secondary px-1 font-mono text-[11px]" /> }} />
          }
        >
          <CommitInput
            id="browser-use-cmd"
            className="w-72 font-mono text-[13px]"
            placeholder="uvx browser-use --mcp"
            value={b.browserUseCommand}
            onCommit={(browserUseCommand) => patch({ browser: { browserUseCommand: browserUseCommand.trim() } })}
          />
        </SettingRow>
        <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <AppWindow className="size-3.5" /> {t("browser.advanced.applyNote")}
        </div>
      </SettingsGroup>
    </div>
  );
}
