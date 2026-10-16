import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { HUMAN_TASK_WORDS, humanTaskRef, type Agent, type HumanTask } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Icon } from "./icon";
import { Badge, Row, T, tap, type Tone } from "./ui";
import { shortTime } from "@/lib/format";
import { radius, space, useColors } from "@/lib/theme";

/** `fromChat`: opened from that chat, so "Open the chat" goes back to it instead of opening it twice. */
export function openHumanTask(id: string, fromChat?: string | null) {
  tap();
  router.push({ pathname: "/human-task/[id]", params: fromChat ? { id, fromChat } : { id } });
}

/** Where a task stands, in the words of its kind and the desktop's tones: a decision is "Answered", an approval "Approved". */
export function humanStatus(task: Pick<HumanTask, "status" | "kind">): { label: string; tone: Tone } {
  const words = HUMAN_TASK_WORDS[task.kind];
  switch (task.status) {
    case "backlog":
      return { label: "Backlog", tone: "neutral" };
    case "open":
      return { label: "To do", tone: "neutral" };
    case "doing":
      return { label: "Doing", tone: "brand" };
    case "done":
      return { label: words.wasDone, tone: "emerald" };
    case "declined":
      return { label: words.wasDeclined, tone: task.kind === "decision" ? "neutral" : "rose" };
    default:
      return { label: "Taken back", tone: "neutral" };
  }
}

/** Something an agent needs from the human — a thing to do, an answer, an OK: what, who asked and for which ticket. */
export function HumanTaskRow({ task, agent }: { task: HumanTask; agent?: Agent }) {
  const c = useColors();
  const status = humanStatus(task);
  const from = task.agentName ?? agent?.name ?? (task.agentId ? "An agent" : "You");
  const meta = [humanTaskRef(task), task.kind !== "task" ? HUMAN_TASK_WORDS[task.kind].label : null, from, task.taskNumber != null ? `ticket #${task.taskNumber}` : null]
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
          {task.priority === "high" && task.status !== "done" ? <Badge label="Urgent" tone="rose" /> : null}
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
