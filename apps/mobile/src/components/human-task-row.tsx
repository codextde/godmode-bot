import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { humanTaskRef, type Agent, type HumanTask } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Icon } from "./icon";
import { Badge, Row, T, tap, type Tone } from "./ui";
import { shortTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { radius, space, useColors } from "@/lib/theme";

/** `fromChat`: opened from that chat, so "Open the chat" goes back to it instead of opening it twice. */
export function openHumanTask(id: string, fromChat?: string | null) {
  tap();
  router.push({ pathname: "/human-task/[id]", params: fromChat ? { id, fromChat } : { id } });
}

/** Where a task stands, in the words of its kind and the desktop's tones: a decision is "Answered", an approval "Approved". */
export function humanStatus(task: Pick<HumanTask, "status" | "kind">): { label: string; tone: Tone } {
  switch (task.status) {
    case "backlog":
      return { label: t("components:humanTaskRow.status.backlog"), tone: "neutral" };
    case "open":
      return { label: t("components:humanTaskRow.status.open"), tone: "neutral" };
    case "doing":
      return { label: t("components:humanTaskRow.status.doing"), tone: "brand" };
    case "done":
      return { label: t(`components:humanTaskRow.wasDone.${task.kind}`), tone: "emerald" };
    case "declined":
      return { label: t(`components:humanTaskRow.wasDeclined.${task.kind}`), tone: task.kind === "decision" ? "neutral" : "rose" };
    default:
      return { label: t("components:humanTaskRow.status.takenBack"), tone: "neutral" };
  }
}

/** Something an agent needs from the human — a thing to do, an answer, an OK: what, who asked and for which ticket. */
export function HumanTaskRow({ task, agent }: { task: HumanTask; agent?: Agent }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const status = humanStatus(task);
  const from = task.agentName ?? agent?.name ?? (task.agentId ? t("humanTaskRow.anAgent") : t("humanTaskRow.you"));
  const meta = [humanTaskRef(task), task.kind !== "task" ? t(`humanTaskRow.kind.${task.kind}`) : null, from, task.taskNumber != null ? t("humanTaskRow.ticket", { number: task.taskNumber }) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable onPress={() => openHumanTask(task.id)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}>
      {agent ? (
        <CharacterAvatar agent={agent} size={40} />
      ) : (
        <View style={[styles.tile, { backgroundColor: c.surface, borderColor: c.border, boxShadow: c.shadowCard }]}>
          <Icon name="user" size={17} color={c.textMuted} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Row style={{ gap: space.sm }}>
          <T variant="callout" numberOfLines={2} style={styles.title}>
            {task.title}
          </T>
          <T variant="caption" color={c.textFaint} style={styles.time}>
            {shortTime(task.closedAt ?? task.createdAt)}
          </T>
        </Row>
        <Row style={{ gap: space.sm }}>
          <Badge label={status.label} tone={status.tone} live={task.status === "doing"} />
          {task.priority === "high" && task.status !== "done" ? <Badge label={t("humanTaskRow.urgent")} tone="rose" /> : null}
          <T variant="footnote" muted numberOfLines={1} style={{ flex: 1 }}>
            {meta}
          </T>
        </Row>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  title: {
    flex: 1,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "500",
    letterSpacing: -0.16,
  },
  time: {
    alignSelf: "flex-start",
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
  tile: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    borderWidth: 1,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
