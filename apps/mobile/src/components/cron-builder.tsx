import { DatePicker, Host } from "@expo/ui/swift-ui";
import { datePickerStyle, labelsHidden } from "@expo/ui/swift-ui/modifiers";
import { Cron } from "croner";
import { format } from "date-fns";
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  formatMinutes,
  MAX_START_WINDOW_MINUTES,
  ordinal,
  parseCron,
  scheduleToHuman,
  startWindowLimit,
  startWindowTooLong,
  validateCron,
  type CronDraft,
} from "@godmode/shared";
import { Group, PickerRow, StepperRow, SwitchRow } from "./form";
import { Icon } from "./icon";
import { T, tap } from "./ui";
import { currentLanguage, dateLocale, uses12Hour } from "@/lib/i18n";
import { fonts, radius, space, useColors, useIsDark } from "@/lib/theme";

type Kind = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

const KINDS: Kind[] = ["hourly", "daily", "weekdays", "weekly", "monthly", "custom"];

// Monday-first order reads more naturally in a picker
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => i + 1);

const CUSTOM_EXAMPLES = [
  { cron: "*/15 * * * *", labelKey: "cronBuilder.examples.every15Minutes" },
  { cron: "0 */2 * * *", labelKey: "cronBuilder.examples.every2Hours" },
  { cron: "0 9,17 * * 1-5", labelKey: "cronBuilder.examples.twiceOnWeekdays" },
  { cron: "0 8 1,15 * *", labelKey: "cronBuilder.examples.firstAndFifteenth" },
] as const;

export const START_WINDOW_PRESETS = [15, 30, 60, 90, 120, 180];

const pad = (n: number) => String(n).padStart(2, "0");
const clamp = (n: number, min: number, max: number) => (Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min);
const tidy = (cron: string) => cron.trim().replace(/\s+/g, " ");

/** The preset an expression reads as; a schedule the phone has no preset for ("several times a day") is edited as cron. */
function draftOf(cron: string): CronDraft {
  const d = parseCron(cron);
  return d.kind === "several" ? { ...d, kind: "custom", custom: tidy(cron) } : d;
}

/** The expression of a preset (desktop: buildCron). */
function buildCron(d: CronDraft): string {
  const m = clamp(d.minute, 0, 59);
  const h = clamp(d.hour, 0, 23);
  switch (d.kind) {
    case "hourly":
      return `${m} * * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${clamp(d.weekday, 0, 6)}`;
    case "monthly":
      return `${m} ${h} ${clamp(d.monthDay, 1, 31)} * *`;
    default:
      return tidy(d.custom);
  }
}

/** Longest random start window the schedule leaves room for (same rule as the core and the desktop). */
function maxStartWindow(cron: string, timezone: string): number {
  if (validateCron(cron)) return MAX_START_WINDOW_MINUTES;
  try {
    const job = new Cron(cron.trim(), { paused: true, timezone, mode: "5-or-6-parts" });
    return startWindowLimit((after) => job.nextRun(after), timezone);
  } catch {
    return MAX_START_WINDOW_MINUTES;
  }
}

/** A start window longer than the gap between runs, in the core's words; null when it fits. */
export function startWindowProblem(cron: string, timezone: string, minutes: number): string | null {
  const max = maxStartWindow(cron, timezone);
  return minutes > max ? startWindowTooLong(max, currentLanguage()) : null;
}

/** Day of week (0 = Sunday) in the app language: "Monday" / "Montag", short "Mon" / "Mo". */
function weekdayName(day: number, short = false): string {
  return format(new Date(2023, 0, 1 + day), short ? "EEE" : "EEEE", { locale: dateLocale() }).replace(/\.$/, "");
}

/**
 * Friendly schedule editor (desktop: cron-builder.tsx): presets with a time, or a cron expression, and the schedule in
 * words below. Emits the expression through `onChange`; the caller checks it with validateCron before saving.
 */
export function CronBuilder({
  value,
  onChange,
  startWindowMinutes = 0,
  runsPerWindow = 1,
  zone,
  problem,
}: {
  value: string;
  onChange: (cron: string) => void;
  startWindowMinutes?: number;
  runsPerWindow?: number;
  /** Shown after the schedule when it runs in another timezone than the phone's. */
  zone?: string | null;
  /** A problem the expression can't show (a start window that doesn't fit). */
  problem?: string | null;
}) {
  const c = useColors();
  const { t } = useTranslation("components");
  const [draft, setDraft] = useState<CronDraft>(() => draftOf(value));
  const cron = buildCron(draft);
  const lang = currentLanguage();
  const error = validateCron(cron, lang) ?? problem ?? null;
  const timed = draft.kind === "daily" || draft.kind === "weekdays" || draft.kind === "weekly" || draft.kind === "monthly";
  const ios = process.env.EXPO_OS === "ios";

  const update = (patch: Partial<CronDraft>) => {
    const next = { ...draft, ...patch };
    // Carry the current expression into the custom editor when switching to it
    if (patch.kind === "custom" && draft.kind !== "custom") next.custom = buildCron(draft);
    setDraft(next);
    onChange(buildCron(next));
  };

  return (
    <View style={{ gap: space.sm }}>
      <Group>
        <PickerRow title={t("cronBuilder.repeat")} value={draft.kind as Kind} options={KINDS.map((k) => ({ value: k, label: t(`cronBuilder.kinds.${k}`) }))} onChange={(kind) => update({ kind })} />
        {draft.kind === "hourly" ? (
          <StepperRow title={t("cronBuilder.atMinute")} value={draft.minute} min={0} max={59} steps={MINUTES} format={(m) => `:${pad(m)}`} onChange={(minute) => update({ minute })} />
        ) : null}
        {draft.kind === "weekly" ? <WeekdayRow value={draft.weekday} onChange={(weekday) => update({ weekday })} /> : null}
        {draft.kind === "monthly" ? (
          <StepperRow title={t("cronBuilder.onDay")} value={draft.monthDay} min={1} max={31} steps={DAYS_OF_MONTH} format={(n) => ordinal(n, lang)} onChange={(monthDay) => update({ monthDay })} />
        ) : null}
        {timed && ios ? <TimeRow hour={draft.hour} minute={draft.minute} onChange={(hour, minute) => update({ hour, minute })} /> : null}
        {timed && !ios ? (
          <StepperRow title={t("cronBuilder.hour")} value={draft.hour} min={0} max={23} format={pad} onChange={(hour) => update({ hour })} />
        ) : null}
        {timed && !ios ? <StepperRow title={t("cronBuilder.minute")} value={draft.minute} min={0} max={59} steps={MINUTES} format={pad} onChange={(minute) => update({ minute })} /> : null}
        {draft.kind === "custom" ? <CustomCronRow value={draft.custom} invalid={!!validateCron(cron)} onChange={(custom) => update({ custom })} /> : null}
      </Group>
      <View
        accessibilityLiveRegion="polite"
        style={[styles.summary, { backgroundColor: error ? c.dangerSoft : c.surfaceAlt, borderColor: error ? c.danger : c.border }]}
      >
        <Icon name={error ? "warning" : "clock"} size={14} color={error ? c.danger : c.textMuted} />
        <T variant="footnote" color={error ? c.danger : c.text} style={{ flex: 1 }}>
          {error ?? `${scheduleToHuman(cron, startWindowMinutes, runsPerWindow, lang, uses12Hour())}${zone ? ` (${zone})` : ""}`}
        </T>
        {!error ? (
          <T variant="caption" muted style={{ fontFamily: fonts.mono }}>
            {cron}
          </T>
        ) : null}
      </View>
    </View>
  );
}

function WeekdayRow({ value, onChange }: { value: number; onChange: (weekday: number) => void }) {
  const c = useColors();
  const { t } = useTranslation("components");
  return (
    <View style={styles.stackedRow}>
      <T variant="callout" style={{ fontWeight: "500" }}>
        {t("cronBuilder.on")}
      </T>
      <View style={{ flexDirection: "row", gap: 4 }}>
        {WEEK_ORDER.map((d) => {
          const active = d === value;
          return (
            <Pressable
              key={d}
              accessibilityRole="button"
              accessibilityLabel={weekdayName(d)}
              accessibilityState={{ selected: active }}
              onPress={() => {
                if (active) return;
                tap();
                onChange(d);
              }}
              style={[styles.day, { backgroundColor: active ? c.primary : c.sunken }]}
            >
              <T variant="footnote" color={active ? c.onPrimary : c.text} style={{ fontWeight: "600" }}>
                {weekdayName(d, true)}
              </T>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** "At" with the system's time picker. */
function TimeRow({ hour, minute, onChange }: { hour: number; minute: number; onChange: (hour: number, minute: number) => void }) {
  const dark = useIsDark();
  const { t } = useTranslation("components");
  return (
    <View style={styles.row}>
      <T variant="callout" style={{ flex: 1, fontWeight: "500" }}>
        {t("cronBuilder.at")}
      </T>
      <Host matchContents colorScheme={dark ? "dark" : "light"}>
        <DatePicker
          selection={new Date(2000, 0, 1, hour, minute)}
          displayedComponents={["hourAndMinute"]}
          onDateChange={(d) => onChange(d.getHours(), d.getMinutes())}
          modifiers={[labelsHidden(), datePickerStyle("compact")]}
        />
      </Host>
    </View>
  );
}

function CustomCronRow({ value, invalid, onChange }: { value: string; invalid: boolean; onChange: (cron: string) => void }) {
  const c = useColors();
  const { t } = useTranslation("components");
  return (
    <View style={styles.stackedRow}>
      <T variant="footnote" muted>
        {t("cronBuilder.cronHint")}
      </T>
      <TextInput
        accessibilityLabel={t("cronBuilder.cronLabel")}
        value={value}
        onChangeText={onChange}
        placeholder="0 9 * * 1-5"
        placeholderTextColor={c.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        style={[styles.cron, { color: c.text, backgroundColor: c.sunken, borderColor: invalid ? c.danger : "transparent" }]}
      />
      <View style={styles.examples}>
        {CUSTOM_EXAMPLES.map((ex) => (
          <Pressable
            key={ex.cron}
            accessibilityRole="button"
            onPress={() => {
              tap();
              onChange(ex.cron);
            }}
            style={({ pressed }) => [styles.example, { borderColor: c.border, backgroundColor: pressed ? c.sunken : c.surface }]}
          >
            <T variant="caption" muted>
              <T variant="caption" muted style={{ fontFamily: fonts.mono }}>
                {ex.cron}
              </T>
              {` · ${t(ex.labelKey)}`}
            </T>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** "Random start time": the run begins somewhere in a window after the scheduled time, 0 = on time (desktop: start-window-field.tsx). */
export function StartWindowField({ cron, timezone, value, onChange }: { cron: string; timezone: string; value: number; onChange: (minutes: number) => void }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const [initial] = useState(value);
  const [remembered, setRemembered] = useState(value || 60);
  const on = value > 0;
  const max = maxStartWindow(cron, timezone);
  const options = [...new Set([...START_WINDOW_PRESETS.filter((m) => m <= max), ...(initial ? [initial] : []), ...(on ? [value] : [])])].sort((a, b) => a - b);

  return (
    <Group>
      <SwitchRow
        title={t("cronBuilder.randomStart")}
        detail={t("cronBuilder.randomStartHint")}
        value={on}
        onChange={(v) => onChange(v ? Math.min(remembered, max) : 0)}
      />
      {on ? (
        <View style={styles.stackedRow}>
          <T variant="footnote" muted>
            {t("cronBuilder.startWithin")}
          </T>
          <View style={styles.examples}>
            {options.map((m) => {
              const active = m === value;
              return (
                <Pressable
                  key={m}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => {
                    if (active) return;
                    tap();
                    setRemembered(m);
                    onChange(m);
                  }}
                  style={[styles.chip, { backgroundColor: active ? c.primary : c.sunken }]}
                >
                  <T variant="footnote" color={active ? c.onPrimary : c.text} style={{ fontWeight: "600", fontVariant: ["tabular-nums"] }}>
                    {formatMinutes(m, currentLanguage())}
                  </T>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </Group>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: 8,
  },
  stackedRow: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  day: {
    flex: 1,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
  cron: {
    fontFamily: fonts.mono,
    fontSize: 15,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: 1,
  },
  examples: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  example: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.badge,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  chip: {
    height: 32,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: radius.pill,
  },
  summary: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
});
