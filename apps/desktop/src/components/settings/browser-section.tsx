import { Link } from "react-router";
import { AppWindow, ArrowRight, Eye, Globe, Wrench } from "lucide-react";
import type { Settings } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { CommitInput, NumberField, SectionHeading, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

export function BrowserSection({ settings }: { settings: Settings }) {
  const { patch } = useSettingsPatch();
  const b = settings.browser;

  return (
    <div className="space-y-5">
      <SectionHeading
        title="Browser"
        description="Agents browse the web in a Godmode-managed Chromium (via browser-use), logged in with sessions you import from Chrome."
      />

      <SettingsGroup
        title="Web browsing"
        icon={<Globe />}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/browser">
              Profiles & live view <ArrowRight />
            </Link>
          </Button>
        }
      >
        <SettingRow label="Enable browser for agents" htmlFor="browser-enabled" description="When off, agents can't open websites — API tools and integrations still work.">
          <Switch id="browser-enabled" checked={b.enabled} onCheckedChange={(enabled) => patch({ browser: { enabled } })} />
        </SettingRow>
        <SettingRow
          label="Run headless by default"
          htmlFor="headless"
          disabled={!b.enabled}
          description="No visible window. You can still watch and take over from the live view. Agents can override this."
        >
          <Switch id="headless" checked={b.headless} disabled={!b.enabled} onCheckedChange={(headless) => patch({ browser: { headless } })} />
        </SettingRow>
        <SettingRow
          label="Keep browser alive"
          htmlFor="keep-alive"
          disabled={!b.enabled}
          description="A browser only starts when an agent opens a website and closes after this many idle minutes (0 keeps it open). Sessions and cookies are kept either way."
        >
          <NumberField
            id="keep-alive"
            min={0}
            max={1440}
            suffix="min"
            disabled={!b.enabled}
            value={b.keepAliveMinutes}
            onCommit={(v) => v !== null && patch({ browser: { keepAliveMinutes: v } })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Live view" icon={<Eye />}>
        <SettingRow
          label="Stream live view"
          htmlFor="live-view"
          description="Watch what agents do in real time and take over to solve CAPTCHAs or log in manually. Frames are only sent while you're watching."
        >
          <Switch id="live-view" checked={b.liveView} onCheckedChange={(liveView) => patch({ browser: { liveView } })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Advanced" icon={<Wrench />} description="Leave empty unless auto-detection picks the wrong binary.">
        <SettingRow label="Chrome / Chromium path" htmlFor="chrome-path" description="Used for the managed browser and for importing your Chrome sessions.">
          <CommitInput
            id="chrome-path"
            className="w-72 font-mono text-[13px]"
            placeholder="Auto-detect"
            value={b.chromePath}
            onCommit={(chromePath) => patch({ browser: { chromePath: chromePath.trim() } })}
          />
        </SettingRow>
        <SettingRow
          label="browser-use MCP command"
          htmlFor="browser-use-cmd"
          description={
            <>
              Custom command for the browser tools server. Default: <code className="rounded-[4px] bg-secondary px-1 font-mono text-[11px]">uvx browser-use --mcp</code>
            </>
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
          <AppWindow className="size-3.5" /> Changes apply the next time a browser profile launches.
        </div>
      </SettingsGroup>
    </div>
  );
}
