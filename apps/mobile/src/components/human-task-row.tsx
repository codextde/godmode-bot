import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { HUMAN_TASK_WORDS, humanTaskRef, type Agent, type HumanTask } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Icon } from "./icon";
import { Badge, Row, T, tap } from "./ui";
import { shortTime } from "@/lib/format";
import { radius, space, useColors } from "@/lib/theme";

/** `fromChat`: opened from that chat, so "Open the chat" goes back to it instead of opening it twice. */
export function openHumanTask(id: string, fromChat?: string | null) {
  tap();
  router.push({ pathname: "/human-task/[id]", params: fromChat ? { id, fromChat } : { id } });
}

/** Where a task stands, in the words of its kind: a decision is "Answered", an approval "Approved". */
export function humanStatus(task: Pick<HumanTask, "status" | "kind">): { label: string; tone: "neutral" | "brand" | "warning" | "danger" } {
  const words = HUMAN_TASK_WORDS[task.kind];
  switch (task.status) {
    case "open":
      return { label: task.kind === "decision" ? "Decision" : task.kind === "approval" ? "Needs your OK" : "To do", tone: "warning" };
    case "doing":
      return { label: "Doing", tone: "brand" };
    case "done":
      return { label: words.wasDone, tone: "neutral" };
    case "declined":
      return { label: words.wasDeclined, tone: "neutral" };
    default:
      return { label: "Taken back", tone: "neutral" };
  }
}

/** Something an agent needs from the human — a thing to do, an answer, an OK: what, who asked and for which ticket. */
export function HumanTaskRow({ task, agent }: { task: HumanTask; agent?: Agent }) {
  const c = useColors();
  const status = humanStatus(task);
  const from = task.agentName ?? agent?.name ?? (task.agentId ? "An agent" : "You");
  const meta = [humanTaskRef(task), from, task.taskNumber != null ? `ticket #${task.taskNumber}` : null].filter(Boolean).join(" · ");
  return (
    <Pressable onPress={() => openHumanTask(task.id)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}>
      {agent ? (
        <CharacterAvatar agent={agent} size={40} />
      ) : (
        <View style={[styles.tile, { backgroundColor: c.warningSoft }]}>
          <Icon name="person" size={18} color={c.warning} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Row style={{ gap: space.sm }}>
          <T variant="headline" numberOfLines={2} style={{ flex: 1, fontSize: 16 }}>
            {task.title}
          </T>
          <T variant="footnote" muted>
            {shortTime(task.closedAt ?? task.createdAt)}
          </T>
        </Row>
        <Row style={{ gap: space.sm }}>
          <Badge label={status.label} tone={status.tone} live={task.status === "doing"} />
          {task.priority === "high" && task.status !== "done" ? <Badge label="Urgent" tone="danger" /> : null}
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
  tile: {
    width: 40,
    height: 40,
    borderRadius: 13,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
