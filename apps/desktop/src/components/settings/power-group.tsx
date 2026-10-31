import { BatteryCharging, BatteryMedium, LaptopMinimalCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { POWER_MIN_BATTERY_OPTIONS, type Settings } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { lidModeLine, useLidMode } from "@/components/layout/lid-mode";
import { cn } from "@/lib/utils";
import { Callout, Segmented, SettingRow, SettingsGroup, useSettingsPatch } from "./settings-kit";

/** Lid-closed mode (Settings → General). Only on a Mac with a lid. */
export function PowerGroup({ settings }: { settings: Settings }) {
  const { t } = useTranslation("settings");
  const { patch } = useSettingsPatch();
  const { status, visible, toggle, pending } = useLidMode();
  if (!visible || !status) return null;
  const p = settings.power;
  const on = status.enabled;
  const stuck = !on && status.state === "error";
  const tone = status.state === "error" ? "error" : !on ? "off" : status.state === "on" ? "on" : "paused";
  const battery = status.battery;
  const batteryOptions = POWER_MIN_BATTERY_OPTIONS.map((v) => ({ value: String(v), label: v ? t("power.battery", { percent: v }) : t("power.never") }));

  return (
    <SettingsGroup
      title={t("power.title")}
      icon={<LaptopMinimalCheck />}
      description={t("power.description")}
    >
      <SettingRow
        label={t("power.keepWorking")}
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
            <span>{on || stuck ? lidModeLine(status) : t("power.keepWorkingHint")}</span>
          </span>
        }
      >
        {battery && (
          <span className="inline-flex items-center gap-1.5 rounded-md border bg-paper-2 px-2 py-1 text-xs text-muted-foreground tabular-nums [&_svg]:size-3.5">
            {battery.charging ? <BatteryCharging /> : <BatteryMedium />}
            {battery.charging ? t("power.charging", { percent: battery.percent }) : t("power.battery", { percent: battery.percent })}
          </span>
        )}
        {stuck && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => toggle(false)}>
            {t("power.letSleep")}
          </Button>
        )}
        <Switch id="lid-closed-awake" checked={on} disabled={pending} onCheckedChange={(v) => toggle(v)} />
      </SettingRow>
      <SettingRow
        label={t("power.onlyWhileWorking")}
        htmlFor="lid-only-working"
        disabled={!on}
        description={t("power.onlyWhileWorkingDescription")}
      >
        <Switch id="lid-only-working" checked={p.onlyWhileWorking} disabled={!on} onCheckedChange={(onlyWhileWorking) => patch({ power: { onlyWhileWorking } })} />
      </SettingRow>
      <SettingRow label={t("power.lowBattery")} disabled={!on} description={t("power.lowBatteryDescription")}>
        <Segmented
          aria-label={t("power.lowBattery")}
          value={String(p.minBattery)}
          disabled={!on}
          onChange={(v) => patch({ power: { minBattery: Number(v) } })}
          options={batteryOptions}
        />
      </SettingRow>
      <div className="py-4">
        <Callout tone="muted">
          {t("power.note")}
        </Callout>
      </div>
    </SettingsGroup>
  );
}
