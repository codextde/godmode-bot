import { DatePicker, Host } from "@expo/ui/swift-ui";
import { datePickerStyle, labelsHidden } from "@expo/ui/swift-ui/modifiers";
import { Cron } from "croner";
import { format } from "date-fns";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  formatMinutes,
  formatTime,
  MAX_START_WINDOW_MINUTES,
  MIN_MINUTES_PER_RUN,
  ordinal,
  parseCron,
  scheduleToHuman,
  startWindowLimit,
  startWindowTooLong,
  validateCron,
  type CronDraft,
  type SeveralMode,
} from "@godmode/shared";
import { Group, PickerRow, SegmentRow, StepperRow, SwitchRow } from "./form";
import { Icon } from "./icon";
import { T, tap } from "./ui";
import { buildCron, SEVERAL_EVERY, SEVERAL_TIMES, severalSpan, severalStarts, severalWindow } from "@/lib/cron-draft";
import { currentLanguage, dateLocale, t as translate, uses12Hour } from "@/lib/i18n";
import { alpha, fonts, radius, space, useColors, useIsDark } from "@/lib/theme";

type Kind = "hourly" | "several" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

const KINDS: Kind[] = ["hourly", "several", "daily", "weekdays", "weekly", "monthly", "custom"];

// Monday-first order reads more naturally in a picker
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => i + 1);
const DAY = 24 * 60;
/** Android has no time picker here: quarter hours, and the end of the day. */
const QUARTERS = [...Array.from({ length: 96 }, (_, i) => i * 15), DAY - 1];

const CUSTOM_EXAMPLES = [
  { cron: "*/15 * * * *", labelKey: "cronBuilder.examples.every15Minutes" },
  { cron: "0 */2 * * *", labelKey: "cronBuilder.examples.every2Hours" },
  { cron: "0 9,17 * * 1-5", labelKey: "cronBuilder.examples.twiceOnWeekdays" },
  { cron: "0 8 1,15 * *", labelKey: "cronBuilder.examples.firstAndFifteenth" },
] as const;

export const START_WINDOW_PRESETS = [15, 30, 60, 90, 120, 180];

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (minutes: number) => formatTime(Math.floor(minutes / 60) % 24, minutes % 60, currentLanguage(), uses12Hour());

/** What is wrong with a "several" draft, or null (desktop: severalProblem). */
function severalProblem(d: CronDraft): string | null {
  if (d.kind !== "several") return null;
  if (!d.days.length) return translate("components:cronBuilder.problems.pickDay");
  const span = severalSpan(d);
  if (span <= 0) return translate("components:cronBuilder.problems.endAfterStart");
  if (d.mode === "random" && span / d.times < MIN_MINUTES_PER_RUN) {
    return translate("components:cronBuilder.problems.tooManyRuns", { times: d.times, minutes: formatMinutes(d.times * MIN_MINUTES_PER_RUN, currentLanguage()) });
  }
  if (d.mode === "interval" && severalStarts(d).length < 2) return translate("components:cronBuilder.problems.onlyOneRun", { hours: d.every });
  return null;
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
 * With `onWindowChange` it also offers random runs spread over a time range: the builder then owns the start window and
 * the runs per window, and hides `children` (the start window field) while that mode is on.
 */
export function CronBuilder({
  value,
  onChange,
  startWindowMinutes = 0,
  runsPerWindow = 1,
  onWindowChange,
  onProblemChange,
  zone,
  problem,
  children,
}: {
  value: string;
  onChange: (cron: string) => void;
  startWindowMinutes?: number;
  runsPerWindow?: number;
  onWindowChange?: (window: { startWindowMinutes: number; runsPerWindow: number }) => void;
  /** Problems the cron can't show (an end before the start): the caller blocks saving while there is one. */
  onProblemChange?: (problem: string | null) => void;
  /** Shown after the schedule when it runs in another timezone than the phone's. */
  zone?: string | null;
  /** A problem the expression can't show (a start window that doesn't fit). */
  problem?: string | null;
  children?: ReactNode;
}) {
  const c = useColors();
  const { t } = useTranslation("components");
  const [draft, setDraft] = useState<CronDraft>(() => parseCron(value, startWindowMinutes, runsPerWindow));
  const cron = buildCron(draft);
  const lang = currentLanguage();
  const draftProblem = severalProblem(draft);
  const error = validateCron(cron, lang) ?? draftProblem ?? problem ?? null;
  const timed = draft.kind === "daily" || draft.kind === "weekdays" || draft.kind === "weekly" || draft.kind === "monthly";
  const several = draft.kind === "several";
  const randomRuns = several && draft.mode === "random";
  const ios = process.env.EXPO_OS === "ios";
  useEffect(() => onProblemChange?.(draftProblem), [draftProblem, onProblemChange]);

  const update = (patch: Partial<CronDraft>) => {
    const next = { ...draft, ...patch };
    if (!onWindowChange && next.kind === "several") next.mode = "interval";
    if (patch.kind === "several" && severalSpan(next) < 120) Object.assign(next, { hour: 9, minute: 0, untilHour: 21, untilMinute: 0 });
    // Carry the current expression into the custom editor when switching to it
    if (patch.kind === "custom" && draft.kind !== "custom") next.custom = buildCron(draft);
    setDraft(next);
    onChange(buildCron(next));
    const window = severalWindow(next);
    if (window) onWindowChange?.(window);
    else if (severalWindow(draft)) onWindowChange?.({ startWindowMinutes: 0, runsPerWindow: 1 });
  };

  const toggleDay = (day: number) => {
    const days = draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day].sort((a, b) => a - b);
    if (days.length) update({ days });
  };

  return (
    <View style={{ gap: space.sm }}>
      <Group>
        <PickerRow title={t("cronBuilder.repeat")} value={draft.kind as Kind} options={KINDS.map((k) => ({ value: k, label: t(`cronBuilder.kinds.${k}`) }))} onChange={(kind) => update({ kind })} />
        {draft.kind === "hourly" ? (
          <StepperRow title={t("cronBuilder.atMinute")} value={draft.minute} min={0} max={59} steps={MINUTES} format={(m) => `:${pad(m)}`} onChange={(minute) => update({ minute })} />
        ) : null}
        {several && onWindowChange ? (
          <SegmentRow<SeveralMode>
            title={t("cronBuilder.timing")}
            value={draft.mode}
            options={[
              { value: "random", label: t("cronBuilder.randomTimes") },
              { value: "interval", label: t("cronBuilder.fixedInterval") },
            ]}
            onChange={(mode) => update({ mode })}
          />
        ) : null}
        {randomRuns ? (
          <StepperRow
            title={t("cronBuilder.runsPerDay")}
            value={draft.times}
            min={SEVERAL_TIMES[0]!}
            max={SEVERAL_TIMES[SEVERAL_TIMES.length - 1]!}
            steps={SEVERAL_TIMES}
            format={(count) => t("cronBuilder.times", { count })}
            onChange={(times) => update({ times })}
          />
        ) : null}
        {several && !randomRuns ? (
          <StepperRow
            title={t("cronBuilder.every")}
            value={draft.every}
            min={SEVERAL_EVERY[0]!}
            max={SEVERAL_EVERY[SEVERAL_EVERY.length - 1]!}
            steps={SEVERAL_EVERY}
            format={(count) => t("cronBuilder.hours", { count })}
            onChange={(every) => update({ every })}
          />
        ) : null}
        {several && ios ? <TimeRow title={randomRuns ? t("cronBuilder.between") : t("cronBuilder.from")} hour={draft.hour} minute={draft.minute} onChange={(hour, minute) => update({ hour, minute })} /> : null}
        {several && ios ? <TimeRow title={randomRuns ? t("cronBuilder.and") : t("cronBuilder.until")} hour={draft.untilHour} minute={draft.untilMinute} onChange={(untilHour, untilMinute) => update({ untilHour, untilMinute })} /> : null}
        {several && !ios ? (
          <StepperRow
            title={randomRuns ? t("cronBuilder.between") : t("cronBuilder.from")}
            value={draft.hour * 60 + draft.minute}
            min={0}
            max={DAY - 1}
            steps={QUARTERS}
            format={clock}
            onChange={(m) => update({ hour: Math.floor(m / 60), minute: m % 60 })}
          />
        ) : null}
        {several && !ios ? (
          <StepperRow
            title={randomRuns ? t("cronBuilder.and") : t("cronBuilder.until")}
            value={draft.untilHour * 60 + draft.untilMinute}
            min={0}
            max={DAY - 1}
            steps={QUARTERS}
            format={clock}
            onChange={(m) => update({ untilHour: Math.floor(m / 60), untilMinute: m % 60 })}
          />
        ) : null}
        {several ? <WeekdayRow selected={draft.days} onPress={toggleDay} /> : null}
        {several ? <DayTimeline draft={draft} /> : null}
        {draft.kind === "weekly" ? <WeekdayRow selected={[draft.weekday]} onPress={(weekday) => update({ weekday })} /> : null}
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
      {randomRuns ? null : children}
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

function WeekdayRow({ selected, onPress }: { selected: number[]; onPress: (weekday: number) => void }) {
  const c = useColors();
  const { t } = useTranslation("components");
  return (
    <View style={styles.stackedRow}>
      <T variant="callout" style={{ fontWeight: "500" }}>
        {t("cronBuilder.on")}
      </T>
      <View style={{ flexDirection: "row", gap: 4 }}>
        {WEEK_ORDER.map((d) => {
          const active = selected.includes(d);
          return (
            <Pressable
              key={d}
              accessibilityRole="button"
              accessibilityLabel={weekdayName(d)}
              accessibilityState={{ selected: active }}
              onPress={() => {
                tap();
                onPress(d);
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

/** 24 h strip: the time range, and where the runs fall in it (random: one part per run, interval: a tick per run). */
function DayTimeline({ draft }: { draft: CronDraft }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const starts = severalStarts(draft);
  if (!starts.length) return null;
  const from = draft.hour * 60 + draft.minute;
  const span = severalSpan(draft);
  const part = span / Math.max(1, draft.times);
  const random = draft.mode === "random";
  const pct = (minutes: number) => `${(Math.min(Math.max(minutes, 0), DAY) / DAY) * 100}%` as const;
  return (
    <View style={styles.stackedRow}>
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ gap: 4 }}>
        <View style={[styles.strip, { backgroundColor: c.sunken }]}>
          {[6, 12, 18].map((h) => (
            <View key={h} style={[styles.stripMark, { left: pct(h * 60), backgroundColor: c.border }]} />
          ))}
          <View style={[styles.stripRange, { left: pct(from), width: pct(span), backgroundColor: alpha(c.primary, 0.12) }]} />
          {starts.map((s) => (
            <View
              key={s}
              style={random ? [styles.stripPart, { left: pct(s), width: pct(part), backgroundColor: alpha(c.primary, 0.3), borderColor: c.surface }] : [styles.stripTick, { left: pct(s), backgroundColor: c.primary }]}
            />
          ))}
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          {[0, 6, 12, 18, 24].map((h) => (
            <T key={h} variant="caption" muted style={{ fontSize: 10, fontVariant: ["tabular-nums"] }}>
              {clock(h * 60)}
            </T>
          ))}
        </View>
      </View>
      <T variant="footnote" muted>
        {random
          ? t("cronBuilder.timeline.random", { count: draft.times })
          : t(starts.length > 8 ? "cronBuilder.timeline.intervalMore" : "cronBuilder.timeline.interval", { count: starts.length, times: starts.slice(0, 8).map(clock).join(", "), more: starts.length - 8 })}
      </T>
    </View>
  );
}

/** A time with the system's picker; "At" unless it says otherwise. */
function TimeRow({ title, hour, minute, onChange }: { title?: string; hour: number; minute: number; onChange: (hour: number, minute: number) => void }) {
  const dark = useIsDark();
  const { t } = useTranslation("components");
  return (
    <View style={styles.row}>
      <T variant="callout" style={{ flex: 1, fontWeight: "500" }}>
        {title ?? t("cronBuilder.at")}
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
  strip: {
    height: 26,
    borderRadius: radius.sm,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  stripMark: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
  },
  stripRange: {
    position: "absolute",
    top: 3,
    bottom: 3,
    borderRadius: 4,
  },
  stripPart: {
    position: "absolute",
    top: 6,
    bottom: 6,
    borderRadius: 3,
    borderLeftWidth: 1,
  },
  stripTick: {
    position: "absolute",
    top: 3,
    bottom: 3,
    width: 2,
    borderRadius: 1,
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
