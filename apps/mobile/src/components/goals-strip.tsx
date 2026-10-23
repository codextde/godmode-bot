import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { formatUsd, type Goal } from "@godmode/shared";
import { Icon } from "./icon";
import { Row, T, tap } from "./ui";
import { api } from "@/lib/api";
import { daysUntil, dueLabel } from "@/lib/desktop-parity";
import { qk } from "@/lib/query";
import { useSpendTracking } from "@/lib/setup";
import { radius, space, useColors } from "@/lib/theme";

/**
 * The goals the work serves, above the board: how far each is (tickets done of all, what it cost); a tap opens one.
 * Achieved and dropped goals fold away behind a count. `bleed`: how far the row reaches past its parent's padding.
 */
export function GoalsStrip({ workspaceId, bleed = 0 }: { workspaceId: string | null; bleed?: number }) {
  const c = useColors();
  const goals = useQuery({ queryKey: qk.goals(workspaceId), queryFn: () => api.goals.list(workspaceId) });
  const spendTracking = useSpendTracking();
  const [showDone, setShowDone] = useState(false);
  if (!goals.data) return null;
  const active = goals.data.filter((g) => g.status === "active");
  const done = goals.data.length - active.length;
  const shown = showDone ? goals.data : active;
  const add = () => {
    tap();
    router.push(workspaceId ? { pathname: "/goal", params: { workspaceId } } : "/goal");
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel="Goals"
      style={{ marginHorizontal: -bleed }}
      contentContainerStyle={[styles.row, { paddingHorizontal: bleed }]}
    >
      {shown.map((g) => (
        <GoalCard key={g.id} goal={g} spendTracking={spendTracking} />
      ))}
      <View style={styles.side}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={goals.data.length ? "New goal" : "Add a goal"}
          accessibilityHint={goals.data.length ? undefined : "Goals say what the work is for — tickets that serve one tell their agent why, and you see how far it is."}
          hitSlop={4}
          onPress={add}
          style={({ pressed }) => [styles.add, { borderColor: c.borderStrong, opacity: pressed ? 0.6 : 1 }]}
        >
          <Icon name="plus" size={12} color={c.textMuted} weight="semibold" />
          <T variant="footnote" muted style={{ fontWeight: "600" }}>
            {goals.data.length ? "Goal" : "Add a goal"}
          </T>
        </Pressable>
        {done > 0 && (
          <Pressable
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => {
              tap();
              setShowDone((v) => !v);
            }}
          >
            <T variant="caption" muted style={{ paddingHorizontal: 4 }}>
              {showDone ? "Hide finished" : `${done} finished`}
            </T>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

function GoalCard({ goal: g, spendTracking }: { goal: Goal; spendTracking: boolean }) {
  const c = useColors();
  const share = g.tickets.total ? Math.round((g.tickets.done / g.tickets.total) * 100) : 0;
  const overdue = g.status === "active" && !!g.targetDate && daysUntil(g.targetDate) < 0;
  const progress = g.tickets.total ? `${g.tickets.done} of ${g.tickets.total} done` : "No tickets yet";
  const cost = spendTracking && g.costUsd > 0 ? formatUsd(g.costUsd) : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[g.title, g.status === "active" ? null : g.status === "achieved" ? "Achieved" : "Dropped", progress, cost, g.targetDate ? dueLabel(g.targetDate) : null].filter(Boolean).join(", ")}
      accessibilityHint={g.why || undefined}
      onPress={() => {
        tap();
        router.push({ pathname: "/goal", params: { id: g.id } });
      }}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: c.surface, borderColor: c.border, boxShadow: c.shadowCard },
        { opacity: (g.status === "active" ? 1 : 0.7) * (pressed ? 0.72 : 1) },
      ]}
    >
      <Row style={{ gap: 6 }}>
        {g.status === "achieved" ? (
          <Icon name="checkCircle" size={13} color={c.emeraldMark} weight="semibold" />
        ) : g.status === "dropped" ? (
          <Icon name="closeCircle" size={13} color={c.textMuted} weight="semibold" />
        ) : (
          <Icon name="dot" size={13} color={c.brandStrong} weight="semibold" />
        )}
        <T variant="footnote" numberOfLines={1} style={{ flex: 1, fontWeight: "600" }}>
          {g.title}
        </T>
      </Row>
      <View style={[styles.track, { backgroundColor: c.sunken }]}>
        <View style={[styles.fill, { width: `${share}%`, backgroundColor: c.emeraldMark }]} />
      </View>
      <Row style={{ gap: 6 }}>
        <T variant="caption" muted numberOfLines={1} style={[styles.num, { flexShrink: 1 }]}>
          {cost ? `${progress} · ${cost}` : progress}
        </T>
        {g.targetDate ? (
          <T variant="caption" color={overdue ? c.warning : c.textMuted} numberOfLines={1} style={[styles.num, { marginLeft: "auto", fontWeight: overdue ? "600" : "400" }]}>
            {dueLabel(g.targetDate)}
          </T>
        ) : null}
      </Row>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: space.sm,
    alignItems: "stretch",
  },
  card: {
    width: 216,
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  track: {
    height: 5,
    borderRadius: 3,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: 3,
  },
  side: {
    justifyContent: "center",
    alignItems: "flex-start",
    gap: 6,
  },
  add: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: 30,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderStyle: "dashed",
  },
  num: {
    fontVariant: ["tabular-nums"],
  },
});
