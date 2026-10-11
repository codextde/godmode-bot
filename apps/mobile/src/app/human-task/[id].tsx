import { useMutation, useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { HUMAN_TASK_WORDS, humanTaskAnswer, humanTaskRef, isHumanTaskActive, type HumanTask } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { humanStatus } from "@/components/human-task-row";
import { Icon } from "@/components/icon";
import { Markdown } from "@/components/markdown";
import { openChat } from "@/components/rows";
import { openTask } from "@/components/task-row";
import { Badge, Button, Card, ErrorState, LoadingState, Row, T, tap } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { hostOf, shortTime } from "@/lib/format";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

/**
 * One task an agent gave the human: the steps, the link, and Done / Can't do it with a note for the agent. A decision is
 * answered (one of its options, or in words), an approval approved or declined.
 */
export default function HumanTaskSheet() {
  const c = useColors();
  const { id, fromChat } = useLocalSearchParams<{ id: string; fromChat?: string }>();
  const list = useQuery({ queryKey: qk.humanTaskList("all"), queryFn: () => api.humanTasks.list({ status: "all" }) });
  const task = list.data?.find((t) => t.id === id);
  const { byId } = useAgents();
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  const settle = (next: HumanTask) => {
    queryClient.setQueryData<HumanTask[]>(qk.humanTaskList("all"), (old) => old?.map((t) => (t.id === next.id ? next : t)));
    void queryClient.invalidateQueries({ queryKey: qk.humanTasks });
    void queryClient.invalidateQueries({ queryKey: qk.tasks });
  };
  const move = useMutation({
    mutationFn: (status: "open" | "doing") => api.humanTasks.move(id, status),
    onSuccess: settle,
    onError: (err) => Alert.alert("Couldn't move the task", errorText(err)),
  });
  const close = useMutation({
    mutationFn: (outcome: "done" | "declined") => api.humanTasks.close(id, outcome, note.trim() || undefined, outcome === "done" ? (picked ?? undefined) : undefined),
    onSuccess: (result) => {
      settle(result.task);
      if (result.notContinued) Alert.alert("Saved", result.notContinued);
      router.back();
    },
    onError: (err) => Alert.alert("Couldn't close the task", errorText(err)),
  });

  if (!task) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {list.isLoading ? (
          <LoadingState label="Loading the task…" />
        ) : list.isError ? (
          <ErrorState title="Couldn't load the task" error={errorText(list.error)} onRetry={() => void list.refetch()} />
        ) : (
          <ErrorState title="This task is gone" error="It was deleted or taken back on your computer." />
        )}
      </View>
    );
  }

  const agent = task.agentId ? byId.get(task.agentId) : undefined;
  const active = isHumanTaskActive(task);
  const status = humanStatus(task);
  const busy = move.isPending || close.isPending;
  const words = HUMAN_TASK_WORDS[task.kind];
  const decision = task.kind === "decision";
  const approval = task.kind === "approval";
  const who = task.agentName ?? agent?.name ?? "the agent";
  const ready = !decision || !!note.trim() || !!picked;
  const answered = humanTaskAnswer(task);
  const link = task.url && /^https?:\/\//i.test(task.url) ? task.url : null;

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <View style={{ gap: space.sm }}>
        <Row style={{ gap: 6 }}>
          <T variant="footnote" muted style={{ fontWeight: "600" }}>
            {humanTaskRef(task)}
          </T>
          <Badge label={status.label} tone={status.tone} live={task.status === "doing"} />
          {task.priority === "high" && active ? <Badge label="Urgent" tone="danger" /> : null}
        </Row>
        <T variant="title">{task.title}</T>
        <Row style={{ gap: space.sm }}>
          {agent ? <CharacterAvatar agent={agent} size={22} /> : <Icon name="person" size={15} color={c.textMuted} />}
          <T variant="footnote" muted numberOfLines={1} style={{ flex: 1 }}>
            {task.agentId ? `From ${task.agentName ?? agent?.name ?? "an agent"}` : "Your own task"} · {shortTime(task.createdAt)}
          </T>
        </Row>
      </View>

      {link ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => {
            tap();
            void Linking.openURL(link);
          }}
          style={({ pressed }) => [styles.link, { backgroundColor: c.surface, borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}
        >
          <View style={[styles.linkIcon, { backgroundColor: c.sunken }]}>
            <Icon name="globe" size={15} color={c.text} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="subhead" style={{ fontWeight: "600" }}>
              Open {hostOf(link) || "the link"}
            </T>
            <T variant="caption" muted numberOfLines={1}>
              {link}
            </T>
          </View>
          <Icon name="external" size={13} color={c.textMuted} />
        </Pressable>
      ) : null}

      {task.body.trim() ? (
        <Card style={{ padding: space.lg }}>
          <Markdown text={task.body} />
        </Card>
      ) : null}

      {(task.taskId || task.conversationId) && (
        <Row style={{ gap: space.sm, flexWrap: "wrap" }}>
          {task.taskId ? <LinkChip icon="tasks" label={task.taskNumber != null ? `Ticket #${task.taskNumber}` : "Ticket"} onPress={() => leaveFor(() => openTask(task.taskId!))} /> : null}
          {task.conversationId ? <LinkChip icon="chats" label={task.conversationTitle || "Open the chat"} onPress={() => (fromChat === task.conversationId ? router.back() : leaveFor(() => openChat(task.conversationId!)))} /> : null}
        </Row>
      )}

      {active ? (
        <View style={{ gap: space.md }}>
          {decision && task.options.length ? (
            <View style={{ gap: space.sm }} accessibilityRole="radiogroup">
              {task.options.map((o) => {
                const on = picked === o.id;
                return (
                  <Pressable
                    key={o.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on, disabled: busy }}
                    disabled={busy}
                    onPress={() => {
                      tap();
                      setPicked(on ? null : o.id);
                    }}
                    style={({ pressed }) => [styles.option, { backgroundColor: on ? c.sunken : c.surface, borderColor: on ? c.primary : c.border, opacity: pressed ? 0.75 : 1 }]}
                  >
                    <View style={[styles.optionMark, { borderColor: on ? c.primary : c.border, backgroundColor: on ? c.primary : "transparent" }]}>
                      {on ? <Icon name="check" size={12} color={c.onPrimary} /> : null}
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T variant="subhead" style={{ fontWeight: "600" }}>
                        {o.label}
                      </T>
                      {o.description ? (
                        <T variant="footnote" muted>
                          {o.description}
                        </T>
                      ) : null}
                    </View>
                    {o.recommended ? <Badge label="Recommended" tone="neutral" /> : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder={
              !task.agentId ? "Note (optional)" : decision ? (task.options.length ? "Or answer in your own words" : `Your answer for ${who}`) : `Note for ${who} (optional)`
            }
            placeholderTextColor={c.textFaint}
            multiline
            editable={!busy}
            style={[styles.note, { color: c.text, backgroundColor: c.surface, borderColor: c.border }]}
          />
          <Button title={words.done} icon="check" size="lg" loading={close.isPending && close.variables === "done"} disabled={busy || !ready} onPress={() => close.mutate("done")} />
          <Row style={{ gap: space.sm }}>
            <Button
              title={task.status === "doing" ? "Back to To do" : decision || approval ? "Thinking about it" : "I'm on it"}
              variant="secondary"
              loading={move.isPending}
              disabled={busy}
              onPress={() => move.mutate(task.status === "doing" ? "open" : "doing")}
              style={{ flex: 1 }}
            />
            {decision && task.questionId ? null : (
              <Button
                title={words.declined}
                variant="secondary"
                loading={close.isPending && close.variables === "declined"}
                disabled={busy}
                onPress={() => close.mutate("declined")}
                style={{ flex: 1 }}
              />
            )}
          </Row>
          {task.agentId ? (
            <T variant="footnote" muted style={{ textAlign: "center" }}>
              {task.questionId
                ? `${task.agentName ?? "The agent"} stands still until you ${approval ? "decide" : "answer"}.`
                : decision
                  ? `${task.agentName ?? "The agent"} goes on with your answer. Dismiss it when there is nothing to decide.`
                  : `${task.agentName ?? "The agent"} continues by itself once you close it.`}
            </T>
          ) : null}
        </View>
      ) : (
        <Card style={{ padding: space.lg, gap: 4 }}>
          <T variant="subhead" style={{ fontWeight: "600" }}>
            {status.label}
            {task.closedAt ? ` · ${shortTime(task.closedAt)}` : ""}
          </T>
          {answered ? (
            <T variant="subhead" muted selectable>
              {answered}
            </T>
          ) : task.closedReason ? (
            <T variant="subhead" muted>
              {task.closedReason}
            </T>
          ) : null}
        </Card>
      )}
    </ScrollView>
  );
}

/** The sheet goes first, so the screen opens in front instead of under it. */
function leaveFor(open: () => void) {
  router.dismiss();
  open();
}

function LinkChip({ icon, label, onPress }: { icon: "tasks" | "chats"; label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.chip, { backgroundColor: c.sunken, opacity: pressed ? 0.7 : 1 }]}>
      <Icon name={icon} size={13} color={c.textMuted} />
      <T variant="subhead" numberOfLines={1} style={{ fontWeight: "600", flexShrink: 1 }}>
        {label}
      </T>
      <Icon name="chevron" size={10} color={c.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    justifyContent: "center",
  },
  content: {
    paddingTop: 28,
    paddingHorizontal: space.xl,
    paddingBottom: 48,
    gap: space.lg,
  },
  link: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  linkIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 34,
    maxWidth: "100%",
    paddingHorizontal: 12,
    borderRadius: radius.pill,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  optionMark: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  note: {
    minHeight: 84,
    maxHeight: 180,
    fontSize: 15,
    lineHeight: 20,
    padding: space.md,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    textAlignVertical: "top",
  },
});
