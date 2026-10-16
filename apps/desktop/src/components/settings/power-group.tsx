import { BatteryCharging, BatteryMedium, LaptopMinimalCheck } from "lucide-react";
import { POWER_MIN_BATTERY_OPTIONS, type Settings } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { lidModeLine, useLidMode } from "@/components/layout/lid-mode";
import { cn } from "@/lib/utils";
import { Callout, Segmented, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

const BATTERY_OPTIONS = POWER_MIN_BATTERY_OPTIONS.map((v) => ({ value: String(v), label: v ? `${v}%` : "Never" }));

/** Lid-closed mode (Settings → General). Only on a Mac with a lid. */
export function PowerGroup({ settings }: { settings: Settings }) {
  const { patch } = useSettingsPatch();
  const { status, visible, toggle, pending } = useLidMode();
  if (!visible || !status) return null;
  const p = settings.power;
  const on = status.enabled;
  const stuck = !on && status.state === "error";
  const tone = status.state === "error" ? "error" : !on ? "off" : status.state === "on" ? "on" : "paused";
  const battery = status.battery;

  return (
    <SettingsGroup
      title="Lid-closed mode"
      icon={<LaptopMinimalCheck />}
      description="Close your MacBook and Godmode keeps going: chats, automations and scheduled work run on while the lid is shut."
    >
      <SettingRow
        label="Keep working with the lid closed"
        htmlFor="lid-closed-awake"
        description={
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                tone === "on" && "bg-brand",
                tone === "paused" && "bg-muted-foreground/60",
                tone === "error" && "bg-warning",
                tone === "off" && "bg-border",
              )}
            />
            <span>{on || stuck ? lidModeLine(status) : "Also in the sidebar, next to Settings. macOS asks for your password the first time."}</span>
          </span>
        }
      >
        {battery && (
          <span className="inline-flex items-center gap-1.5 rounded-md border bg-paper-2 px-2 py-1 text-xs text-muted-foreground tabular-nums [&_svg]:size-3.5">
            {battery.charging ? <BatteryCharging /> : <BatteryMedium />}
            {battery.percent}%{battery.charging ? " · charging" : ""}
          </span>
        )}
        {stuck && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => toggle(false)}>
            Let the Mac sleep
          </Button>
        )}
        <Switch id="lid-closed-awake" checked={on} disabled={pending} onCheckedChange={(v) => toggle(v)} />
      </SettingRow>
      <SettingRow
        label="Only while agents work"
        htmlFor="lid-only-working"
        disabled={!on}
        description="The Mac may sleep a few minutes after the last run ends. Scheduled automations then wait until it wakes up."
      >
        <Switch id="lid-only-working" checked={p.onlyWhileWorking} disabled={!on} onCheckedChange={(onlyWhileWorking) => patch({ power: { onlyWhileWorking } })} />
      </SettingRow>
      <SettingRow label="Sleep on low battery" disabled={!on} description="On battery the Mac sleeps again at this charge, and keeps working once it's plugged in.">
        <Segmented
          aria-label="Sleep on low battery"
          value={String(p.minBattery)}
          disabled={!on}
          onChange={(v) => patch({ power: { minBattery: Number(v) } })}
          options={BATTERY_OPTIONS}
        />
      </SettingRow>
      <div className="py-4">
        <Callout tone="muted">
          Keep the Mac out of a closed bag while it works, it can get warm. When you quit Godmode the Mac sleeps with the lid closed again. Browser work
          carries on with the lid shut; controlling the screen works best with the lid open or an external display.
        </Callout>
      </div>
    </SettingsGroup>
  );
}
