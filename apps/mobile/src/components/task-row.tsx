import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Agent, Task, TaskBlockedKind, TaskStatus, TaskType } from "@godmode/shared";
import { isOverdue, isWaiting, waitsForAnswer, waitsForSubtasks, waitsForTickets } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Icon } from "./icon";
import { PriorityIcon, StatusIcon } from "./task-glyphs";
import { Badge, LiveDot, Row, T, tap, UnassignedAvatar, type Tone } from "./ui";
import { isWorking } from "@/lib/desktop-parity";
import { shortTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { radius, space, useColors } from "@/lib/theme";

/** The desktop's labels (packages/shared TASK_STATUS_LABELS) and tones (task-meta.tsx). */
export const STATUS_META: Record<TaskStatus, { label: string; tone: Tone }> = {
  backlog: { get label() { return t("components:taskRow.status.backlog"); }, tone: "neutral" },
  todo: { get label() { return t("components:taskRow.status.todo"); }, tone: "neutral" },
  in_progress: { get label() { return t("components:taskRow.status.in_progress"); }, tone: "amber" },
  in_review: { get label() { return t("components:taskRow.status.in_review"); }, tone: "emerald" },
  blocked: { get label() { return t("components:taskRow.status.blocked"); }, tone: "rose" },
  done: { get label() { return t("components:taskRow.status.done"); }, tone: "sky" },
  cancelled: { get label() { return t("components:taskRow.status.cancelled"); }, tone: "neutral" },
};

export const TYPE_META: Record<TaskType, { label: string; hint: string }> = {
  general: { get label() { return t("components:taskRow.type.general.label"); }, get hint() { return t("components:taskRow.type.general.hint"); } },
  coding: { get label() { return t("components:taskRow.type.coding.label"); }, get hint() { return t("components:taskRow.type.coding.hint"); } },
  research: { get label() { return t("components:taskRow.type.research.label"); }, get hint() { return t("components:taskRow.type.research.hint"); } },
};

/** What a blocked card leads with, like the desktop's BLOCKED_META. */
function blockedPrefix(kind: TaskBlockedKind): string {
  return kind === "manual" ? "" : t(`components:taskRow.blocked.${kind}`);
}

export function openTask(id: string) {
  tap();
  router.push({ pathname: "/task/[id]", params: { id } });
}

export function TaskStatusBadge({ task }: { task: Task }) {
  // In progress isn't always live work: it may wait for the human's answer, stand still, or wait for its follow-up.
  const { t } = useTranslation("components");
  if (waitsForAnswer(task)) return <Badge label={task.pause?.question?.kind === "approval" ? t("taskRow.needsOk") : t("taskRow.needsAnswer")} tone="warning" />;
  if (task.status === "in_progress" && task.pause) return <Badge label={t("taskRow.paused")} icon={<StatusIcon status="in_progress" size={12} />} />;
  if (isWaiting(task) || waitsForSubtasks(task)) return <Badge label={t("taskRow.waiting")} icon={<StatusIcon status="in_progress" size={12} />} />;
  const meta = STATUS_META[task.status];
  if (isWorking(task)) return <Badge label={meta.label} tone="amber" live />;
  return <Badge label={meta.label} tone={meta.tone} icon={<StatusIcon status={task.status} size={12} />} />;
}

export function TaskRow({ task, agent, workspaceName, projectName }: { task: Task; agent?: Agent; workspaceName?: string; projectName?: string }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const working = isWorking(task);
  const waiting =
    task.status !== "in_progress" || task.activity
      ? null
      : isWaiting(task) && task.followup
        ? t("taskRow.waitingContinues", { when: shortTime(task.followup.dueAt) })
        : waitsForSubtasks(task)
          ? task.subtasks!.blocked
            ? t("taskRow.waitingForPartsBlocked", { count: task.subtasks!.open, blocked: task.subtasks!.blocked })
            : t("taskRow.waitingForParts", { count: task.subtasks!.open })
          : null;
  const blocked =
    task.status === "blocked" && (task.blockedReason || task.blockedKind)
      ? [task.blockedKind ? blockedPrefix(task.blockedKind) : "", task.blockedReason ?? (task.blockedKind === "interrupted" ? t("taskRow.restartedMidRun") : "")].filter(Boolean).join(" ")
      : null;
  const extra = [
    task.dueDate ? (isOverdue(task) ? t("taskRow.overdue") : t("taskRow.due", { date: task.dueDate.slice(5) })) : null,
    task.parentNumber ? t("taskRow.partOf", { number: task.parentNumber }) : null,
    waitsForTickets(task) ? t("taskRow.waitsFor", { tickets: task.waitsFor.filter((w) => !w.finished).map((w) => `#${w.number}`).join(", ") }) : null,
    task.subtasks ? t("taskRow.partsDone", { done: task.subtasks.total - task.subtasks.open, total: task.subtasks.total }) : null,
  ].filter(Boolean);
  return (
    <Pressable onPress={() => openTask(task.id)} style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}>
      {agent ? <CharacterAvatar agent={agent} size={40} running={working} /> : <UnassignedAvatar size={40} />}
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Row style={{ gap: space.sm }}>
          <T variant="callout" numberOfLines={2} style={styles.title}>
            {task.title}
          </T>
          <T variant="caption" color={c.textFaint} style={styles.time}>
            {shortTime(task.updatedAt)}
          </T>
        </Row>
        <Row style={{ gap: 6 }}>
          <TaskStatusBadge task={task} />
          {task.priority !== "none" ? <PriorityIcon priority={task.priority} size={13} /> : null}
          <T variant="footnote" muted numberOfLines={1} style={{ flex: 1 }}>
            {[`#${task.number}`, agent?.name ?? t("taskRow.unassigned"), workspaceName, projectName, ...extra].filter(Boolean).join(" · ")}
          </T>
        </Row>
        {task.activity || working ? (
          <Row style={{ gap: space.sm }}>
            <LiveDot size={6} color={c.amberMark} />
            <T variant="footnote" color={c.amber} numberOfLines={1} style={{ flex: 1 }}>
              {task.activity ?? (task.runStatus === "queued" ? t("taskRow.queued") : t("taskRow.working"))}
            </T>
          </Row>
        ) : blocked ? (
          <Row style={{ gap: 6, alignItems: "flex-start" }}>
            <Icon name="octagon" size={13} color={c.rose} style={{ marginTop: 2 }} />
            <T variant="footnote" color={c.rose} numberOfLines={2} style={{ flex: 1 }}>
              {blocked}
            </T>
          </Row>
        ) : waiting ? (
          <Row style={{ gap: 6 }}>
            <Icon name="clock" size={12} color={c.brandStrong} />
            <T variant="footnote" muted numberOfLines={1} style={{ flex: 1 }}>
              {waiting}
            </T>
          </Row>
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
});
