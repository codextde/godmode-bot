import { formatDistanceToNowStrict } from "date-fns";
import { router } from "expo-router";
import { memo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Switch, View } from "react-native";
import { useTranslation } from "react-i18next";
import { cronToHuman, scheduleToHuman, type Agent, type Routine, type RoutineTriggerType } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Icon } from "./icon";
import { T, tap } from "./ui";
import { api, errorText } from "@/lib/api";
import { whenText } from "@/lib/format";
import { currentLanguage, dateLocale, t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

/** "gmail" → "Gmail", "google_calendar" → "Google Calendar". */
export function appName(slug: string): string {
  return slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** This phone's timezone, e.g. "Europe/Berlin"; null when the system doesn't say. */
export function phoneTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** What starts an automation, in the desktop's words (trigger-meta.ts). */
export const TRIGGER_TITLES: Record<RoutineTriggerType, string> = {
  get schedule() { return t("components:routineRow.triggers.schedule"); },
  get app() { return t("components:routineRow.triggers.app"); },
  get condition() { return t("components:routineRow.triggers.condition"); },
  get webhook() { return t("components:routineRow.triggers.webhook"); },
};

/** Schedule: run now · condition: check now · app/webhook: run with a test event. */
export function runLabel(type: RoutineTriggerType): string {
  return type === "condition" ? t("components:routineRow.checkNow") : type === "schedule" ? t("components:routineRow.runNow") : t("components:routineRow.sendTestEvent");
}

/** What starts an automation, in one line: its schedule and next run (`withNext`), the app event, the condition or the webhook. */
export function triggerText(r: Routine, withNext = true): string {
  const next = withNext && r.enabled && r.nextRunAt ? whenText(r.nextRunAt) : null;
  const trigger = r.trigger;
  switch (trigger.type) {
    case "schedule": {
      const zone = r.timezone && r.timezone !== phoneTimezone() ? ` (${r.timezone.replace(/_/g, " ")})` : "";
      const schedule = `${scheduleToHuman(r.cron, trigger.startWindowMinutes, trigger.runsPerWindow, currentLanguage())}${zone}`;
      return next ? t("components:routineRow.withNextRun", { schedule, when: next }) : schedule;
    }
    case "app":
      return `${trigger.triggerName} · ${appName(trigger.toolkit)}`;
    case "condition": {
      const often = cronToHuman(r.cron, currentLanguage());
      return t("components:routineRow.conditionChecked", { condition: trigger.condition, often: `${often.charAt(0).toLowerCase()}${often.slice(1)}` });
    }
    case "webhook":
      return t("components:routineRow.webhookCalled");
  }
}

function patchRoutine(id: string, patch: Partial<Routine>) {
  queryClient.setQueriesData<Routine[]>({ queryKey: qk.routines }, (list) => (Array.isArray(list) ? list.map((r) => (r.id === id ? { ...r, ...patch } : r)) : list));
}

const refreshRoutines = () => void queryClient.invalidateQueries({ queryKey: qk.routines });

/** Flips the switch in every cached list right away and takes it back if the computer refuses. */
export function setRoutineEnabled(routine: Routine, enabled: boolean) {
  void queryClient.cancelQueries({ queryKey: qk.routines });
  patchRoutine(routine.id, { enabled });
  api.routines
    .setEnabled(routine.id, enabled)
    .catch((err) => {
      patchRoutine(routine.id, { enabled: !enabled });
      Alert.alert(t("components:routineRow.toggleFailed"), errorText(err));
    })
    .finally(refreshRoutines);
}

export function runRoutine(routine: Routine): Promise<void> {
  return api.routines
    .run(routine.id)
    .then((run) => {
      useLive.getState().runStarted(run);
      tap();
    })
    .catch((err) => Alert.alert(t("components:routineRow.runFailed"), errorText(err)))
    .finally(refreshRoutines);
}

/** One automation in a list: whose it is, what starts it, a switch and Run now. Tapping it opens the automation. */
export const RoutineRow = memo(function RoutineRow({ routine, agent, working }: { routine: Routine; agent?: Agent; working?: boolean }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const [starting, setStarting] = useState(false);
  const failed = routine.lastStatus === "failed";
  const ago = routine.lastRunAt ? formatDistanceToNowStrict(new Date(routine.lastRunAt), { addSuffix: true, locale: dateLocale() }) : null;
  const last = ago ? (failed ? t("routineRow.lastRunFailed", { ago }) : t("routineRow.lastRun", { ago })) : null;
  const broken = routine.enabled && routine.triggerStatus?.state === "error";
  const canRun = routine.enabled && !working && !starting;

  return (
    <Pressable
      onPress={() => {
        tap();
        router.push({ pathname: "/automation/[id]", params: { id: routine.id } });
      }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
    >
      <CharacterAvatar agent={agent} size={40} running={working} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="headline" numberOfLines={1} style={{ fontSize: 16 }}>
          {routine.name}
        </T>
        <T variant="footnote" muted numberOfLines={2}>
          {agent ? `${agent.name} · ` : ""}
          {working ? (
            <T variant="footnote" color={c.brandStrong} style={{ fontWeight: "600" }}>
              {t("routineRow.runningNow")}
            </T>
          ) : (
            triggerText(routine)
          )}
          {last ? " · " : ""}
          {last && failed ? (
            <T variant="footnote" color={c.danger}>
              {last}
            </T>
          ) : (
            last
          )}
        </T>
        {broken ? (
          <T variant="footnote" color={c.danger} numberOfLines={2}>
            {routine.triggerStatus.message ?? t("routineRow.triggerBroken")}
          </T>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("routineRow.runNamedNow", { name: routine.name })}
        accessibilityState={{ disabled: !canRun, busy: starting }}
        hitSlop={6}
        // Not `disabled`: a press on it must not fall through to the row and open the automation.
        onPress={() => {
          if (!canRun) return;
          setStarting(true);
          void runRoutine(routine).finally(() => setStarting(false));
        }}
        style={({ pressed }) => [styles.runNow, { backgroundColor: c.sunken, opacity: starting ? 1 : !canRun ? 0.4 : pressed ? 0.6 : 1 }]}
      >
        {starting ? <ActivityIndicator size="small" color={c.textMuted} /> : <Icon name="play" size={12} color={c.text} />}
      </Pressable>
      <Switch
        accessibilityLabel={routine.enabled ? t("routineRow.turnOff", { name: routine.name }) : t("routineRow.turnOn", { name: routine.name })}
        value={routine.enabled}
        onValueChange={(enabled) => setRoutineEnabled(routine, enabled)}
        trackColor={{ true: c.brand, false: c.sunken }}
      />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  runNow: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
});
