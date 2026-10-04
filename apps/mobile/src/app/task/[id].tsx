import { isWaiting, reopenStatus, waitsForAnswer, type TaskBlockedKind } from "@godmode/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { Task, TaskStatus } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { Composer } from "@/components/composer";
import { Icon } from "@/components/icon";
import { Markdown } from "@/components/markdown";
import { openChat } from "@/components/rows";
import { STATUS_META, TaskStatusBadge, TYPE_META } from "@/components/task-row";
import { Avatar, Badge, Button, Card, Row, SectionTitle, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { encodeFiles, type PendingFile } from "@/lib/attachments";
import { activityText } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { agentsFor, useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

/** A task: what it's about, how far its agent got, and the buttons to move it along. */
export default function TaskScreen() {
  const c = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const task = useQuery({ queryKey: qk.task(id), queryFn: () => api.tasks.get(id) });
  const { data: agents, byId } = useAgents();
  const { workspaces } = useWorkspace();

  const onDone = (next: Task) => {
    queryClient.setQueryData(qk.task(id), next);
    void queryClient.invalidateQueries({ queryKey: [...qk.tasks, "list"] });
  };
  const update = useMutation({
    mutationFn: (patch: { status?: TaskStatus; agentId?: string | null; archived?: boolean }) => api.tasks.update(id, patch),
    onSuccess: onDone,
    onError: (err) => Alert.alert("Couldn't change the task", errorText(err)),
  });

  const t = task.data;
  if (!t) return <Stack.Title>{task.isError ? "Task not found" : "Task"}</Stack.Title>;

  const agent = t.agentId ? byId.get(t.agentId) : undefined;
  const workspace = workspaces.find((w) => w.id === t.workspaceId);
  // In progress isn't working: the ticket may wait for its follow-up, for an answer, or stand still.
  const working = t.status === "in_progress" && (t.runStatus === "running" || t.runStatus === "queued" || !!t.activity);
  const waiting = t.status === "in_progress" && (isWaiting(t) || waitsForAnswer(t) || !!t.pause);
  const canFollowUp =
    !!t.conversationId && !!t.agentId && !t.archivedAt && (t.status === "in_review" || t.status === "blocked" || t.status === "done" || isWaiting(t));
  const assignable = agentsFor(agents ?? [], t.workspaceId).filter((a) => a.enabled);

  const move = (status: TaskStatus) => {
    tap();
    if (!(working || waiting) || status === "in_progress") return update.mutate({ status });
    Alert.alert(
      "Stop the agent?",
      working
        ? `${agent?.name ?? "The agent"} is still working on it. Moving it to ${STATUS_META[status].label} stops the run.`
        : `It waits to go on. Moving it to ${STATUS_META[status].label} stops that.`,
      [
        { text: "Keep working", style: "cancel" },
        { text: "Stop", style: "destructive", onPress: () => update.mutate({ status }) },
      ],
    );
  };

  const archive = (archived: boolean) => {
    tap();
    if (!archived || !working) return update.mutate({ archived });
    Alert.alert("Stop the agent?", `${agent?.name ?? "The agent"} is still working on it. Archiving it stops the run.`, [
      { text: "Keep working", style: "cancel" },
      { text: "Stop and archive", style: "destructive", onPress: () => update.mutate({ archived }) },
    ]);
  };

  const followUp = async (content: string, files: PendingFile[]) => {
    try {
      onDone(await api.tasks.message(id, content, await encodeFiles(files)));
    } catch (err) {
      Alert.alert("Couldn't send it", errorText(err));
      throw err;
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Stack.Title>{`#${t.number}`}</Stack.Title>

      <View style={{ gap: space.sm }}>
        <T variant="title">{t.title}</T>
        <Row style={{ gap: 6, flexWrap: "wrap" }}>
          <TaskStatusBadge task={t} />
          {t.archivedAt ? <Badge label="Archived" /> : null}
          <Badge label={TYPE_META[t.type].label} />
          <Badge label={workspace ? `${workspace.icon || "🗂️"} ${workspace.name}` : "Global"} />
        </Row>
      </View>

      <Card style={styles.agent} onPress={agent ? () => router.push({ pathname: "/agent/[id]", params: { id: agent.id } }) : undefined}>
        {agent ? <CharacterAvatar agent={agent} size={40} running={working} /> : <Avatar emoji="📋" size={40} running={working} />}
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="headline" numberOfLines={1} style={{ fontSize: 16 }}>
            {agent?.name ?? "No agent yet"}
          </T>
          <T variant="footnote" muted numberOfLines={2}>
            {working
              ? t.activity
                ? activityText(t.activity)
                : t.runStatus === "queued"
                  ? "Queued — waiting for a free slot"
                  : "Working on it"
              : waitsForAnswer(t)
                ? "Waiting for your answer"
                : isWaiting(t)
                  ? "Waiting for its follow-up"
                  : t.pause
                    ? "Paused"
                    : t.status === "todo"
                      ? "About to start"
                      : agent
                        ? "Assigned"
                        : "Pick one below to start"}
          </T>
        </View>
        {agent && <Icon name="chevron" size={13} color={c.textFaint} />}
      </Card>

      {t.status === "blocked" && (t.blockedReason || t.blockedKind) ? (
        <Card style={[styles.notice, { backgroundColor: c.dangerSoft, borderColor: "transparent" }]}>
          <Icon name="warning" size={16} color={c.danger} />
          <View style={{ flex: 1, gap: 2 }}>
            {t.blockedKind && t.blockedKind !== "manual" ? (
              <T variant="subhead" style={{ fontWeight: "600" }}>
                {BLOCKED_TITLE[t.blockedKind]}
              </T>
            ) : null}
            {t.blockedReason ? <T variant="subhead">{t.blockedReason}</T> : null}
            {t.blockedKind === "publish" ? (
              <T variant="footnote" muted>
                Publishing failed — publish it again on your computer.
              </T>
            ) : null}
          </View>
        </Card>
      ) : null}
      {t.runCount > 0 ? (
        <T variant="footnote" muted style={{ paddingHorizontal: 4 }}>
          {agent?.name ?? "The agent"} worked {Math.max(1, Math.round(t.workMs / 60_000))}m in {t.runCount} run{t.runCount === 1 ? "" : "s"} · ${t.costUsd.toFixed(2)}
        </T>
      ) : null}

      <Actions
        task={t}
        busy={update.isPending}
        hasAgent={!!agent}
        onMove={move}
        onArchive={archive}
        onOpenChat={t.conversationId ? () => openChat(t.conversationId!) : undefined}
      />

      {!agent && (t.status === "backlog" || t.status === "todo") && assignable.length > 0 && (
        <View>
          <SectionTitle title="Hand it to" />
          <View style={styles.chips}>
            {assignable.map((a) => (
              <Pressable
                key={a.id}
                disabled={update.isPending}
                onPress={() => {
                  tap();
                  update.mutate({ agentId: a.id, status: "todo" });
                }}
                style={({ pressed }) => [styles.chip, { backgroundColor: c.sunken, opacity: pressed ? 0.7 : 1, paddingLeft: 8 }]}
              >
                <CharacterAvatar agent={a} size={24} />
                <T variant="subhead" style={{ fontWeight: "600" }}>
                  {a.name}
                </T>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {t.pullRequest && (
        <Card
          style={styles.pr}
          onPress={() => {
            tap();
            void Linking.openURL(t.pullRequest!.url);
          }}
        >
          <Icon name="branch" size={17} color={c.textMuted} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="headline" style={{ fontSize: 16 }}>
              {t.pullRequest.number ? `Pull request #${t.pullRequest.number}` : "Open the pull request"}
            </T>
            <T variant="footnote" muted numberOfLines={1}>
              {t.pullRequest.state ? `${t.pullRequest.state[0]!.toUpperCase()}${t.pullRequest.state.slice(1)}` : "Not opened yet"}
              {t.branch ? ` · ${t.branch}` : ""}
            </T>
          </View>
          <Icon name="external" size={14} color={c.textFaint} />
        </Card>
      )}

      {t.summary ? (
        <View>
          <SectionTitle title="Result" />
          <Card style={styles.text}>
            <Markdown text={t.summary} />
          </Card>
        </View>
      ) : null}

      {t.description ? (
        <View>
          <SectionTitle title="Details" />
          <Card style={styles.text}>
            <Markdown text={t.description} />
          </Card>
        </View>
      ) : null}

      {canFollowUp && (
        <View>
          <SectionTitle title={t.status === "blocked" ? "Help it along" : "Ask for changes"} />
          <Composer draftKey={`task:${id}`} onSend={followUp} attachments placeholder={`Tell ${agent?.name ?? "the agent"} what to change…`} />
        </View>
      )}
    </ScrollView>
  );
}

type Action = { title: string; icon: Parameters<typeof Button>[0]["icon"]; status?: TaskStatus; archived?: boolean; primary?: boolean; onPress?: () => void };

function Actions({
  task,
  busy,
  hasAgent,
  onMove,
  onArchive,
  onOpenChat,
}: {
  task: Task;
  busy: boolean;
  hasAgent: boolean;
  onMove: (status: TaskStatus) => void;
  onArchive: (archived: boolean) => void;
  onOpenChat?: () => void;
}) {
  const buttons: Action[] = [];
  if (task.archivedAt) {
    buttons.push({ title: "Back on the board", icon: "unarchive", archived: false, primary: true });
    if (onOpenChat) buttons.push({ title: "Open chat", icon: "chats", onPress: onOpenChat });
    return <ActionButtons buttons={buttons} busy={busy} onMove={onMove} onArchive={onArchive} />;
  }
  switch (task.status) {
    case "backlog":
      if (hasAgent) buttons.push({ title: "Start", icon: "play", status: "todo", primary: true });
      break;
    case "todo":
      buttons.push({ title: "Back to backlog", icon: "pause", status: "backlog" });
      break;
    case "in_progress":
      buttons.push({ title: "Stop", icon: "stop", status: "backlog" });
      break;
    case "in_review":
      buttons.push({ title: "Approve", icon: "check", status: "done", primary: true });
      break;
    case "blocked":
      // When the agent asked for something, the answer goes in the message box below.
      if (hasAgent && task.blockedKind !== "needs_input") {
        const title = task.blockedKind === "interrupted" ? "Continue" : task.blockedKind === "stopped" || task.blockedKind === "manual" || task.blockedKind === "publish" ? "Start again" : "Try again";
        buttons.push({ title, icon: "refresh", status: "todo", primary: true });
      }
      break;
    case "done":
    case "cancelled":
      buttons.push({ title: "Reopen", icon: "refresh", status: reopenStatus(task) });
      break;
  }
  if (onOpenChat) buttons.push({ title: "Open chat", icon: "chats", onPress: onOpenChat });
  buttons.push({ title: "Archive", icon: "archive", archived: true });
  if (task.status !== "done" && task.status !== "cancelled") buttons.push({ title: "Cancel task", icon: "close", status: "cancelled" });
  return <ActionButtons buttons={buttons} busy={busy} onMove={onMove} onArchive={onArchive} />;
}

const BLOCKED_TITLE: Record<TaskBlockedKind, string> = {
  needs_input: "It needs something from you",
  failed: "The run failed",
  stopped: "Stopped",
  interrupted: "Interrupted by a restart",
  publish: "Couldn't publish the work",
  setup: "Couldn't set it up",
  manual: "Blocked",
};

function ActionButtons({
  buttons,
  busy,
  onMove,
  onArchive,
}: {
  buttons: Action[];
  busy: boolean;
  onMove: (status: TaskStatus) => void;
  onArchive: (archived: boolean) => void;
}) {
  if (!buttons.length) return null;
  return (
    <View style={{ gap: space.sm }}>
      {buttons.map((b) => (
        <Button
          key={b.title}
          title={b.title}
          icon={b.icon}
          variant={b.primary ? "primary" : b.status === "cancelled" ? "danger" : "secondary"}
          disabled={busy && (!!b.status || b.archived !== undefined)}
          onPress={b.onPress ?? (() => (b.archived !== undefined ? onArchive(b.archived) : onMove(b.status!)))}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: 80,
    gap: space.lg,
  },
  agent: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
  },
  notice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    padding: space.lg,
  },
  pr: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
  },
  text: {
    padding: space.lg,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
});
