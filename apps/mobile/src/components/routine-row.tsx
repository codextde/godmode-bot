import { formatDistanceToNowStrict } from "date-fns";
import { Link, router } from "expo-router";
import { memo, useState } from "react";
import { Alert, StyleSheet, Switch, View } from "react-native";
import { useTranslation } from "react-i18next";
import { cronToHuman, scheduleToHuman, type Agent, type Routine, type RoutineTriggerType } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { useMenuSheet, type HeaderMenuItem } from "./header-actions";
import { sfSymbol } from "./icon";
import { T, tap } from "./ui";
import { RowPressable } from "./row-pressable";
import { api, errorText } from "@/lib/api";
import { whenText } from "@/lib/format";
import { currentLanguage, dateLocale, t, uses12Hour } from "@/lib/i18n";
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
      const schedule = `${scheduleToHuman(r.cron, trigger.startWindowMinutes, trigger.runsPerWindow, currentLanguage(), uses12Hour())}${zone}`;
      return next ? t("components:routineRow.withNextRun", { schedule, when: next }) : schedule;
    }
    case "app": {
      const more = trigger.moreEvents?.length;
      return `${trigger.triggerName} · ${appName(trigger.toolkit)}${more ? ` ${t("components:routineRow.moreEvents", { count: more })}` : ""}`;
    }
    case "condition": {
      const often = cronToHuman(r.cron, currentLanguage(), uses12Hour());
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

/**
 * One automation in a list: its name, one line (what starts it, or what needs a look) and its switch. Tapping it opens
 * the automation; Run now is in its long-press menu and on its page.
 */
export const RoutineRow = memo(function RoutineRow({ routine, agent, working }: { routine: Routine; agent?: Agent; working?: boolean }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const menu = useMenuSheet();
  const [starting, setStarting] = useState(false);
  const failed = routine.lastStatus === "failed";
  const broken = routine.enabled && routine.triggerStatus?.state === "error";
  const runnable = routine.enabled && !working && !starting;
  const ago = routine.lastRunAt ? formatDistanceToNowStrict(new Date(routine.lastRunAt), { addSuffix: true, locale: dateLocale() }) : null;
  const [line, tone] =
    working || starting
      ? [t("routineRow.runningNow"), c.brandStrong]
      : broken
        ? [routine.triggerStatus.message ?? t("routineRow.triggerBroken"), c.danger]
        : failed && ago
          ? [t("routineRow.failedLine", { ago }), c.danger]
          : [[routine.pendingEvents > 0 ? t("routineRow.waiting", { count: routine.pendingEvents }) : null, triggerText(routine, false)].filter(Boolean).join(" · "), undefined];
  const href = { pathname: "/automation/[id]" as const, params: { id: routine.id } };
  const run = () => {
    if (!runnable) return;
    setStarting(true);
    void runRoutine(routine).finally(() => setStarting(false));
  };
  const actions: HeaderMenuItem[] = runnable ? [{ icon: "play", title: runLabel(routine.trigger.type), onPress: run }] : [];
  const label = [routine.name, agent?.name, line].filter(Boolean).join(", ");

  const main = (
    <>
      <CharacterAvatar agent={agent} size={40} running={working} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="headline" numberOfLines={1} style={{ fontSize: 16 }}>
          {routine.name}
        </T>
        <T variant="footnote" muted={!tone} color={tone} numberOfLines={1}>
          {line}
        </T>
      </View>
    </>
  );
  const toggle = (
    <Switch
      accessibilityLabel={routine.enabled ? t("routineRow.turnOff", { name: routine.name }) : t("routineRow.turnOn", { name: routine.name })}
      value={routine.enabled}
      onValueChange={(enabled) => setRoutineEnabled(routine, enabled)}
      trackColor={{ true: c.brand, false: c.sunken }}
      style={{ alignSelf: "center" }}
    />
  );

  const row = (onLongPress?: () => void, withSwitch = true) => (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        tap();
        router.push(href);
      }}
      onLongPress={onLongPress}
      style={[styles.row, !withSwitch && styles.lead]}
    >
      {main}
      {withSwitch ? toggle : null}
    </RowPressable>
  );
  if (!actions.length) return row();
  if (process.env.EXPO_OS !== "ios") {
    return (
      <>
        {row(() => {
          tap();
          menu.show(actions, routine.name);
        })}
        {menu.sheet}
      </>
    );
  }
  // The system's menu on a long press; the switch stays outside it, so a tap on it only flips it.
  return (
    <View style={styles.split}>
      <Link href={href} asChild>
        <Link.Trigger>
          <View style={{ flex: 1 }}>{row(undefined, false)}</View>
        </Link.Trigger>
        <Link.Menu>
          {actions.map((a) => (
            <Link.MenuAction key={a.title} title={a.title} icon={sfSymbol(a.icon)} onPress={a.onPress} />
          ))}
        </Link.Menu>
      </Link>
      {toggle}
    </View>
  );
});

const styles = StyleSheet.create({
  split: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: space.lg,
  },
  lead: {
    paddingRight: space.md,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
});
