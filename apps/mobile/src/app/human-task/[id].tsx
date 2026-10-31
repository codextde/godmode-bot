import { useMutation, useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { humanTaskAnswer, humanTaskRef, isHumanTaskActive, type HumanTask, type HumanTaskLane, type HumanTaskPriority } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { MenuSheet, type HeaderMenuItem } from "@/components/header-actions";
import { humanStatus } from "@/components/human-task-row";
import { Icon } from "@/components/icon";
import { Markdown } from "@/components/markdown";
import { openChat } from "@/components/rows";
import { openTask } from "@/components/task-row";
import { Badge, Button, Card, ErrorState, LoadingState, Row, T, tap } from "@/components/ui";
import { api, ApiError, errorText, updateDesktopMessage } from "@/lib/api";
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
  const { t } = useTranslation(["humanTasks", "common"]);
  const { id, fromChat } = useLocalSearchParams<{ id: string; fromChat?: string }>();
  const [settled, setSettled] = useState<HumanTask>();
  // Whichever list brought the human here already has the task: the sheet opens from that copy while every task loads.
  const seed = useMemo(() => {
    const hit = settled?.id === id ? settled : cachedHumanTask(id);
    return hit ? [hit] : undefined;
  }, [id, settled]);
  const list = useQuery({ queryKey: qk.humanTaskList("all"), queryFn: () => api.humanTasks.list({ status: "all" }), placeholderData: seed });
  const task = (list.data ?? seed)?.find((t) => t.id === id);
  const { byId } = useAgents();
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState<{ title: string; body: string } | null>(null);

  const settle = (next: HumanTask) => {
    setSettled(next);
    queryClient.setQueryData<HumanTask[]>(qk.humanTaskList("all"), (old) => old?.map((t) => (t.id === next.id ? next : t)));
    void queryClient.invalidateQueries({ queryKey: qk.humanTasks });
    void queryClient.invalidateQueries({ queryKey: qk.tasks });
  };
  const move = useMutation({
    mutationFn: (status: HumanTaskLane) => api.humanTasks.move(id, status),
    onSuccess: settle,
    onError: (err) => Alert.alert(t("detail.moveFailed"), err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err)),
  });
  const update = useMutation({
    mutationFn: (patch: { priority?: HumanTaskPriority; title?: string; body?: string }) => api.humanTasks.update(id, patch),
    onSuccess: (next) => {
      settle(next);
      setEditing(null);
    },
    onError: (err) => Alert.alert(t("detail.updateFailed"), err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err)),
  });
  const remove = useMutation({
    mutationFn: () => api.humanTasks.remove(id),
    onSuccess: () => {
      queryClient.setQueriesData<HumanTask[]>({ queryKey: qk.humanTasks }, (old) => (Array.isArray(old) ? old.filter((t) => t.id !== id) : old));
      void queryClient.invalidateQueries({ queryKey: qk.humanTasks });
      router.back();
    },
    onError: (err) => Alert.alert(t("detail.deleteFailed"), err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err)),
  });
  const close = useMutation({
    mutationFn: (outcome: "done" | "declined") => api.humanTasks.close(id, outcome, note.trim() || undefined, outcome === "done" ? (picked ?? undefined) : undefined),
    onSuccess: (result) => {
      settle(result.task);
      if (result.notContinued) Alert.alert(t("common:status.saved"), result.notContinued);
      router.back();
    },
    onError: (err) => Alert.alert(t("detail.closeFailed"), errorText(err)),
  });

  if (!task) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {list.isLoading ? (
          <LoadingState label={t("detail.loading")} />
        ) : list.isError ? (
          <ErrorState title={t("detail.loadFailed")} error={errorText(list.error)} onRetry={() => void list.refetch()} />
        ) : (
          <ErrorState title={t("detail.goneTitle")} error={t("detail.goneBody")} />
        )}
      </View>
    );
  }

  const agent = task.agentId ? byId.get(task.agentId) : undefined;
  const active = isHumanTaskActive(task);
  const status = humanStatus(task);
  const busy = move.isPending || close.isPending || update.isPending || remove.isPending;
  // The human's own task: its words are theirs to change, and it can go. A closed one can go too.
  const own = !task.agentId && !task.runId;
  const actions: HeaderMenuItem[] = [
    ...(active ? [{ icon: "warning" as const, title: task.priority === "high" ? t("detail.notUrgent") : t("detail.markUrgent"), onPress: () => update.mutate({ priority: task.priority === "high" ? "normal" : "high" }) }] : []),
    ...(own && active ? [{ icon: "pencil" as const, title: t("common:actions.edit"), onPress: () => setEditing({ title: task.title, body: task.body }) }] : []),
    ...(own || !active
      ? [
          {
            icon: "trash" as const,
            title: t("common:actions.delete"),
            destructive: true,
            onPress: () =>
              Alert.alert(t("detail.deleteTitle", { ref: humanTaskRef(task) }), t("detail.deleteBody"), [
                { text: t("common:actions.cancel"), style: "cancel" },
                { text: t("common:actions.delete"), style: "destructive", onPress: () => remove.mutate() },
              ]),
          },
        ]
      : []),
  ];
  const decision = task.kind === "decision";
  const approval = task.kind === "approval";
  const who = task.agentName ?? agent?.name;
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
          {task.priority === "high" && active ? <Badge label={t("detail.urgent")} tone="danger" /> : null}
          {actions.length ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("detail.more")}
              hitSlop={10}
              disabled={busy}
              onPress={() => {
                tap();
                setMenu(true);
              }}
              style={({ pressed }) => [styles.more, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}
            >
              <Icon name="more" size={15} color={c.text} />
            </Pressable>
          ) : null}
        </Row>
        {editing ? (
          <TextInput
            value={editing.title}
            onChangeText={(title) => setEditing({ ...editing, title })}
            placeholder={t("detail.titlePlaceholder")}
            placeholderTextColor={c.textFaint}
            autoFocus
            maxLength={200}
            style={[styles.editTitle, { color: c.text, backgroundColor: c.surface, borderColor: c.border }]}
          />
        ) : (
          <T variant="title">{task.title}</T>
        )}
        <Row style={{ gap: space.sm }}>
          {agent ? <CharacterAvatar agent={agent} size={22} /> : <Icon name="person" size={15} color={c.textMuted} />}
          <T variant="footnote" muted numberOfLines={1} style={{ flex: 1 }}>
            {task.agentId ? (who ? t("detail.from", { name: who }) : t("detail.fromAgent")) : t("detail.ownTask")} · {shortTime(task.createdAt)}
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
              {hostOf(link) ? t("detail.openHost", { host: hostOf(link) }) : t("detail.openLink")}
            </T>
            <T variant="caption" muted numberOfLines={1}>
              {link}
            </T>
          </View>
          <Icon name="external" size={13} color={c.textMuted} />
        </Pressable>
      ) : null}

      {editing ? (
        <View style={{ gap: space.sm }}>
          <TextInput
            value={editing.body}
            onChangeText={(body) => setEditing({ ...editing, body })}
            placeholder={t("detail.noteOptional")}
            placeholderTextColor={c.textFaint}
            multiline
            style={[styles.note, { color: c.text, backgroundColor: c.surface, borderColor: c.border }]}
          />
          <Row style={{ gap: space.sm }}>
            <Button title={t("common:actions.cancel")} variant="secondary" disabled={update.isPending} onPress={() => setEditing(null)} style={{ flex: 1 }} />
            <Button
              title={t("common:actions.save")}
              icon="check"
              loading={update.isPending}
              disabled={!editing.title.trim()}
              onPress={() => update.mutate({ title: editing.title.trim(), body: editing.body.trim() })}
              style={{ flex: 1 }}
            />
          </Row>
        </View>
      ) : task.body.trim() ? (
        <Card style={{ padding: space.lg }}>
          <Markdown text={task.body} />
        </Card>
      ) : null}

      {(task.taskId || task.conversationId) && (
        <Row style={{ gap: space.sm, flexWrap: "wrap" }}>
          {task.taskId ? <LinkChip icon="tasks" label={task.taskNumber != null ? t("detail.ticketNumber", { number: task.taskNumber }) : t("detail.ticket")} onPress={() => leaveFor(() => openTask(task.taskId!))} /> : null}
          {task.conversationId ? <LinkChip icon="chats" label={task.conversationTitle || t("detail.openChat")} onPress={() => (fromChat === task.conversationId ? router.back() : leaveFor(() => openChat(task.conversationId!)))} /> : null}
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
                    {o.recommended ? <Badge label={t("detail.recommended")} tone="neutral" /> : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder={
              !task.agentId
                ? t("detail.noteOptional")
                : decision
                  ? task.options.length
                    ? t("detail.ownWords")
                    : who
                      ? t("detail.answerFor", { name: who })
                      : t("detail.answerForAgent")
                  : who
                    ? t("detail.noteFor", { name: who })
                    : t("detail.noteForAgent")
            }
            placeholderTextColor={c.textFaint}
            multiline
            editable={!busy}
            style={[styles.note, { color: c.text, backgroundColor: c.surface, borderColor: c.border }]}
          />
          <Button title={t(`detail.words.${task.kind}.done`)} icon="check" size="lg" loading={close.isPending && close.variables === "done"} disabled={busy || !ready} onPress={() => close.mutate("done")} />
          <Row style={{ gap: space.sm }}>
            <Button
              title={task.status === "open" ? (decision || approval ? t("detail.thinking") : t("detail.onIt")) : t("detail.backToTodo")}
              variant="secondary"
              loading={move.isPending && move.variables !== "backlog"}
              disabled={busy}
              onPress={() => move.mutate(task.status === "open" ? "doing" : "open")}
              style={{ flex: 1 }}
            />
            <Button
              title={t(`detail.words.${task.kind}.declined`)}
              variant="secondary"
              loading={close.isPending && close.variables === "declined"}
              disabled={busy}
              onPress={() => close.mutate("declined")}
              style={{ flex: 1 }}
            />
          </Row>
          {task.status !== "backlog" && (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                tap();
                move.mutate("backlog");
              }}
              style={({ pressed }) => [{ alignSelf: "center", paddingVertical: space.xs, paddingHorizontal: space.md }, pressed && { opacity: 0.5 }]}
            >
              <T variant="subhead" muted>
                {move.isPending && move.variables === "backlog" ? t("detail.moving") : t("detail.later")}
              </T>
            </Pressable>
          )}
          {task.agentId ? (
            <T variant="footnote" muted style={{ textAlign: "center" }}>
              {task.questionId
                ? approval
                  ? t("detail.waitsDecide", { name: task.agentName ?? t("detail.theAgent") })
                  : t("detail.waitsAnswer", { name: task.agentName ?? t("detail.theAgent") })
                : decision
                  ? t("detail.goesOn", { name: task.agentName ?? t("detail.theAgent") })
                  : t("detail.continues", { name: task.agentName ?? t("detail.theAgent") })}
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
      <MenuSheet items={actions} open={menu} onClose={() => setMenu(false)} />
    </ScrollView>
  );
}

/** A human task from any list that is cached (the open ones, a chat's, all of them). */
function cachedHumanTask(id: string): HumanTask | undefined {
  for (const [, list] of queryClient.getQueriesData<HumanTask[]>({ queryKey: qk.humanTasks })) {
    const hit = Array.isArray(list) ? list.find((t) => t.id === id) : undefined;
    if (hit) return hit;
  }
  return undefined;
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
  more: {
    width: 30,
    height: 30,
    borderRadius: 15,
    marginLeft: "auto",
    alignItems: "center",
    justifyContent: "center",
  },
  editTitle: {
    fontSize: 20,
    fontWeight: "600",
    padding: space.md,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
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
