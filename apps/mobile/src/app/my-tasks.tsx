import { useMutation, useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, SectionList, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { isHumanTaskActive, isHumanTaskWaiting, type HumanTask, type HumanTaskPriority } from "@godmode/shared";
import { Segmented } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { HumanTaskRow } from "@/components/human-task-row";
import { Icon } from "@/components/icon";
import { Button, Card, EmptyState, ErrorState, Hairline, Row, SectionTitle, SkeletonRows, T, tap } from "@/components/ui";
import { api, ApiError, errorText, updateDesktopMessage } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { radius, space, useColors } from "@/lib/theme";

const DONE_SHOWN = 20;

const Separator = () => <Hairline inset={72} />;

const byPosition = (a: HumanTask, b: HumanTask) => a.position - b.position || a.number - b.number;

/** What agents need from the human — a passkey, a CAPTCHA, an answer, an OK — and the human's own tasks, in the desktop's columns. */
export default function MyTasks() {
  const { t } = useTranslation(["humanTasks", "common"]);
  const list = useQuery({ queryKey: qk.humanTaskList("all"), queryFn: () => api.humanTasks.list({ status: "all" }) });
  const { byId } = useAgents();
  const pull = usePullRefresh(list.refetch);
  const [adding, setAdding] = useState(false);
  const all = useMemo(() => list.data ?? [], [list.data]);

  const sections = useMemo(() => {
    const closed = all.filter((h) => !isHumanTaskActive(h)).sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt));
    return [
      { title: t("myTasks.lanes.backlog"), data: all.filter((h) => h.status === "backlog").sort(byPosition) },
      { title: t("myTasks.lanes.open"), data: all.filter((h) => h.status === "open").sort(byPosition) },
      { title: t("myTasks.lanes.doing"), data: all.filter((h) => h.status === "doing").sort(byPosition) },
      { title: t("myTasks.lanes.done"), data: closed.slice(0, DONE_SHOWN) },
    ].filter((s) => s.data.length);
  }, [all, t]);

  const waiting = all.filter((h) => h.status === "open").length;
  const agentsWaiting = new Set(all.filter((h) => isHumanTaskWaiting(h) && h.agentId).map((h) => h.agentId)).size;
  const parked = all.filter((h) => h.status === "backlog").length;
  const summary = waiting
    ? t("myTasks.summary", {
        parts: [
          t("myTasks.waiting", { count: waiting }),
          agentsWaiting ? t("myTasks.agentsOnHold", { count: agentsWaiting }) : null,
          parked ? t("myTasks.inBacklog", { count: parked }) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      })
    : parked
      ? t("myTasks.summaryNothing", { count: parked })
      : null;

  return (
    <>
      <Stack.Title>{t("myTasks.title")}</Stack.Title>
      <HeaderActions actions={[{ icon: "plus", label: t("myTasks.newTask"), onPress: () => setAdding(true) }]} />
      <SectionList<HumanTask>
        sections={sections}
        keyExtractor={(h) => h.id}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: 80 }}
        refreshControl={<RefreshControl {...pull} />}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          adding || (summary && sections.length) ? (
            <View style={{ paddingHorizontal: space.sm, paddingTop: space.sm, gap: space.md }}>
              {summary && sections.length ? (
                <T variant="footnote" muted style={{ paddingHorizontal: 4 }}>
                  {summary}
                </T>
              ) : null}
              {adding ? <AddTask onDone={() => setAdding(false)} /> : null}
            </View>
          ) : null
        }
        renderSectionHeader={({ section }) => (
          <View style={{ paddingHorizontal: space.sm, paddingTop: space.lg }}>
            <SectionTitle title={`${section.title} · ${section.data.length}`} />
          </View>
        )}
        ItemSeparatorComponent={Separator}
        renderItem={({ item }) => <HumanTaskRow task={item} agent={item.agentId ? byId.get(item.agentId) : undefined} />}
        ListEmptyComponent={
          list.isLoading ? (
            <View style={{ paddingTop: space.lg }}>
              <SkeletonRows count={5} avatar={40} />
            </View>
          ) : list.isError ? (
            <ErrorState title={t("myTasks.loadFailed")} error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : adding ? null : (
            <EmptyState
              icon="person"
              title={t("myTasks.emptyTitle")}
              body={t("myTasks.emptyBody")}
              action={<Button title={t("myTasks.addOwn")} icon="plus" variant="secondary" onPress={() => setAdding(true)} />}
            />
          )
        }
      />
    </>
  );
}

/** One of the human's own: what, an optional note, how urgent, now or later. */
function AddTask({ onDone }: { onDone: () => void }) {
  const c = useColors();
  const { t } = useTranslation(["humanTasks", "common"]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<HumanTaskPriority>("normal");
  const [status, setStatus] = useState<"open" | "backlog">("open");
  const create = useMutation({
    mutationFn: () => api.humanTasks.create({ title: title.trim(), ...(body.trim() ? { body: body.trim() } : {}), priority, status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.humanTasks });
      onDone();
    },
    onError: (err) => Alert.alert(t("myTasks.addFailed"), err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err)),
  });
  const urgent = priority === "high";
  return (
    <Card style={styles.add}>
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder={t("myTasks.titlePlaceholder")}
        placeholderTextColor={c.textFaint}
        autoFocus
        returnKeyType="next"
        maxLength={200}
        style={[styles.title, { color: c.text }]}
      />
      <TextInput
        value={body}
        onChangeText={setBody}
        placeholder={t("myTasks.noteOptional")}
        placeholderTextColor={c.textFaint}
        multiline
        style={[styles.body, { color: c.text, borderTopColor: c.border }]}
      />
      <Segmented
        options={[
          { value: "open", label: t("myTasks.lanes.open") },
          { value: "backlog", label: t("myTasks.lanes.backlog") },
        ]}
        value={status}
        onChange={setStatus}
      />
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: urgent }}
        onPress={() => {
          tap();
          setPriority(urgent ? "normal" : "high");
        }}
        style={({ pressed }) => [styles.urgent, { backgroundColor: urgent ? c.dangerSoft : c.sunken, opacity: pressed ? 0.7 : 1 }]}
      >
        <Icon name="warning" size={13} color={urgent ? c.danger : c.textMuted} />
        <T variant="subhead" color={urgent ? c.danger : c.text} style={{ fontWeight: "600" }}>
          {urgent ? t("myTasks.urgent") : t("myTasks.markUrgent")}
        </T>
      </Pressable>
      <Row style={{ gap: space.sm }}>
        <Button title={t("common:actions.cancel")} variant="secondary" onPress={onDone} style={{ flex: 1 }} />
        <Button title={t("myTasks.addTask")} icon="plus" loading={create.isPending} disabled={!title.trim()} onPress={() => create.mutate()} style={{ flex: 1 }} />
      </Row>
    </Card>
  );
}

const styles = StyleSheet.create({
  add: {
    padding: space.lg,
    gap: space.md,
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
    paddingVertical: 2,
  },
  body: {
    minHeight: 56,
    maxHeight: 140,
    fontSize: 15,
    lineHeight: 20,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    textAlignVertical: "top",
  },
  urgent: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
  },
});
