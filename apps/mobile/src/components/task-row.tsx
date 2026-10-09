import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import type { Agent, Task, TaskStatus, TaskType } from "@godmode/shared";
import { isOverdue, isWaiting, waitsForAnswer, waitsForSubtasks, waitsForTickets } from "@godmode/shared";
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
  // In progress isn't always live work: it may wait for the human's answer, stand still, or wait for its follow-up.
  if (waitsForAnswer(task)) return <Badge label="Needs your answer" tone="warning" />;
  if (task.status === "in_progress" && task.pause) return <Badge label="Paused" tone="neutral" />;
  if (isWaiting(task)) return <Badge label="Waiting" tone="neutral" />;
  const meta = STATUS_META[task.status];
  const live = task.status === "in_progress" && (task.runStatus === "queued" || task.runStatus === "running" || !!task.activity);
  return <Badge label={meta.label} tone={meta.tone} live={live} />;
}

export function TaskRow({ task, agent, workspaceName, projectName }: { task: Task; agent?: Agent; workspaceName?: string; projectName?: string }) {
  const c = useColors();
  const detail =
    task.status === "blocked"
      ? task.blockedReason
      : task.status === "in_progress"
        ? (task.activity ??
          (isWaiting(task) && task.followup
            ? `Continues ${shortTime(task.followup.dueAt)}`
            : waitsForSubtasks(task)
              ? `Waiting for ${task.subtasks!.open === 1 ? "1 part" : `${task.subtasks!.open} parts`}`
              : null))
        : null;
  const extra = [
    task.priority === "urgent" ? "Urgent" : task.priority === "high" ? "High" : null,
    task.dueDate ? (isOverdue(task) ? "overdue" : `due ${task.dueDate.slice(5)}`) : null,
    task.parentNumber ? `part of #${task.parentNumber}` : null,
    waitsForTickets(task) ? `waits for ${task.waitsFor.filter((w) => !w.finished).map((w) => `#${w.number}`).join(", ")}` : null,
    task.subtasks ? `${task.subtasks.total - task.subtasks.open}/${task.subtasks.total} parts` : null,
  ].filter(Boolean);
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
            {[`#${task.number}`, agent?.name ?? "No agent", workspaceName, projectName, ...extra].filter(Boolean).join(" · ")}
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
