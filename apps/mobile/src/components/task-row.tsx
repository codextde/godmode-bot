import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import type { Agent, Task, TaskStatus, TaskType } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Avatar, Badge, Row, T, tap } from "./ui";
import { shortTime } from "@/lib/format";
import { radius, space, useColors } from "@/lib/theme";

type Tone = "neutral" | "brand" | "warning" | "danger";

export const STATUS_META: Record<TaskStatus, { label: string; tone: Tone }> = {
  backlog: { label: "Backlog", tone: "neutral" },
  todo: { label: "To do", tone: "neutral" },
  in_progress: { label: "In progress", tone: "brand" },
  in_review: { label: "In review", tone: "warning" },
  blocked: { label: "Blocked", tone: "danger" },
  done: { label: "Done", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const TYPE_META: Record<TaskType, { label: string; hint: string }> = {
  general: { label: "Task", hint: "Does it and reports back" },
  coding: { label: "Coding", hint: "Own branch, opens a pull request" },
  research: { label: "Research", hint: "Investigates, writes a report" },
};

export function openTask(id: string) {
  tap();
  router.push({ pathname: "/task/[id]", params: { id } });
}

export function TaskStatusBadge({ task }: { task: Task }) {
  const meta = STATUS_META[task.status];
  return <Badge label={meta.label} tone={meta.tone} live={task.status === "in_progress"} />;
}

export function TaskRow({ task, agent, workspaceName }: { task: Task; agent?: Agent; workspaceName?: string }) {
  const c = useColors();
  const detail = task.status === "blocked" ? task.blockedReason : task.status === "in_progress" ? task.activity : null;
  return (
    <Pressable onPress={() => openTask(task.id)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}>
      {agent ? (
        <CharacterAvatar agent={agent} size={40} running={task.status === "in_progress"} />
      ) : (
        <Avatar emoji="📋" size={40} running={task.status === "in_progress"} />
      )}
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Row style={{ gap: space.sm }}>
          <T variant="headline" numberOfLines={1} style={{ flex: 1, fontSize: 16 }}>
            {task.title}
          </T>
          <T variant="footnote" muted>
            {shortTime(task.updatedAt)}
          </T>
        </Row>
        <Row style={{ gap: space.sm }}>
          <TaskStatusBadge task={task} />
          <T variant="footnote" muted numberOfLines={1} style={{ flex: 1 }}>
            {[`#${task.number}`, agent?.name ?? "No agent", workspaceName].filter(Boolean).join(" · ")}
          </T>
        </Row>
        {detail ? (
          <T variant="footnote" color={task.status === "blocked" ? c.danger : c.textMuted} numberOfLines={2}>
            {detail}
          </T>
        ) : null}
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
});
