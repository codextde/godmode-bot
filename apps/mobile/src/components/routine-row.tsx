import { formatDistanceToNowStrict } from "date-fns";
import { router } from "expo-router";
import { memo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Switch, View } from "react-native";
import type { Agent, Routine } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Icon } from "./icon";
import { T, tap } from "./ui";
import { api, errorText } from "@/lib/api";
import { whenText } from "@/lib/format";
import { useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

/** "gmail" → "Gmail", "google_calendar" → "Google Calendar". */
function appName(slug: string): string {
  return slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** What starts an automation, in one line: its next run or check, the app event, the condition or the webhook. */
export function triggerText(r: Routine): string {
  const next = r.enabled && r.nextRunAt ? whenText(r.nextRunAt) : null;
  switch (r.trigger.type) {
    case "schedule":
      return next ? `Next run ${next}` : "On a schedule";
    case "app":
      return `${r.trigger.triggerName} · ${appName(r.trigger.toolkit)}`;
    case "condition":
      return `When ${r.trigger.condition}${next ? ` · next check ${next}` : ""}`;
    case "webhook":
      return "When its webhook is called";
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
      Alert.alert("Couldn't change the automation", errorText(err));
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
    .catch((err) => Alert.alert("Couldn't run it", errorText(err)))
    .finally(refreshRoutines);
}

/** One automation in a list: whose it is, what starts it, a switch and Run now. Tapping it opens its agent. */
export const RoutineRow = memo(function RoutineRow({ routine, agent, working }: { routine: Routine; agent?: Agent; working?: boolean }) {
  const c = useColors();
  const [starting, setStarting] = useState(false);
  const failed = routine.lastStatus === "failed";
  const last = routine.lastRunAt ? `last run ${failed ? "failed " : ""}${formatDistanceToNowStrict(new Date(routine.lastRunAt), { addSuffix: true })}` : null;
  const broken = routine.enabled && routine.triggerStatus?.state === "error";
  const canRun = routine.enabled && !working && !starting;

  return (
    <Pressable
      onPress={() => {
        tap();
        router.push({ pathname: "/agent/[id]", params: { id: routine.agentId } });
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
              Running now
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
            {routine.triggerStatus.message ?? "The trigger isn't working."}
          </T>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Run ${routine.name} now`}
        accessibilityState={{ disabled: !canRun, busy: starting }}
        hitSlop={6}
        // Not `disabled`: a press on it must not fall through to the row and open the agent.
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
        accessibilityLabel={`${routine.enabled ? "Turn off" : "Turn on"} ${routine.name}`}
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
