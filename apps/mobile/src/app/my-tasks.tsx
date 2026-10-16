import { useMutation, useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, SectionList, StyleSheet, TextInput, View } from "react-native";
import { isHumanTaskActive, isHumanTaskWaiting, type HumanTask, type HumanTaskPriority } from "@godmode/shared";
import { Segmented } from "@/components/form";
import { HeaderActions } from "@/components/header-actions";
import { HumanTaskRow } from "@/components/human-task-row";
import { Icon } from "@/components/icon";
import { Button, Card, EmptyState, ErrorState, Hairline, Row, SectionTitle, SkeletonRows, T, tap } from "@/components/ui";
import { api, ApiError, errorText, UPDATE_DESKTOP_MESSAGE } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { usePullRefresh } from "@/lib/use-pull-refresh";
import { radius, space, useColors } from "@/lib/theme";

const DONE_SHOWN = 20;

const Separator = () => <Hairline inset={72} />;

const byPosition = (a: HumanTask, b: HumanTask) => a.position - b.position || a.number - b.number;

/** What agents need from the human — a passkey, a CAPTCHA, an answer, an OK — and the human's own tasks, in the desktop's columns. */
export default function MyTasks() {
  const list = useQuery({ queryKey: qk.humanTaskList("all"), queryFn: () => api.humanTasks.list({ status: "all" }) });
  const { byId } = useAgents();
  const pull = usePullRefresh(list.refetch);
  const [adding, setAdding] = useState(false);
  const all = useMemo(() => list.data ?? [], [list.data]);

  const sections = useMemo(() => {
    const closed = all.filter((t) => !isHumanTaskActive(t)).sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt));
    return [
      { title: "Backlog", data: all.filter((t) => t.status === "backlog").sort(byPosition) },
      { title: "To do", data: all.filter((t) => t.status === "open").sort(byPosition) },
      { title: "Doing", data: all.filter((t) => t.status === "doing").sort(byPosition) },
      { title: "Done", data: closed.slice(0, DONE_SHOWN) },
    ].filter((s) => s.data.length);
  }, [all]);

  const waiting = all.filter((t) => t.status === "open").length;
  const agentsWaiting = new Set(all.filter((t) => isHumanTaskWaiting(t) && t.agentId).map((t) => t.agentId)).size;
  const parked = all.filter((t) => t.status === "backlog").length;
  const summary = waiting
    ? `${waiting} waiting for you${agentsWaiting ? ` · ${agentsWaiting} agent${agentsWaiting === 1 ? "" : "s"} on hold until you're done` : ""}${parked ? ` · ${parked} in the backlog` : ""}. Close or answer one and its agent picks up where it left off.`
    : parked
      ? `Nothing waits for you right now · ${parked} in the backlog for later. Close or answer one and its agent picks up where it left off.`
      : null;

  return (
    <>
      <Stack.Title>My tasks</Stack.Title>
      <HeaderActions actions={[{ icon: "plus", label: "New task", onPress: () => setAdding(true) }]} />
      <SectionList<HumanTask>
        sections={sections}
        keyExtractor={(t) => t.id}
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
            <ErrorState title="Couldn't load your tasks" error={errorText(list.error)} onRetry={() => void list.refetch()} />
          ) : adding ? null : (
            <EmptyState
              icon="person"
              title="Nothing waits for you"
              body="When an agent can't go on without you — a passkey, a CAPTCHA, a question, a decision it left open — it lands here and you are told. Once you close or answer it, the agent continues by itself."
              action={<Button title="Add one of your own" icon="plus" variant="secondary" onPress={() => setAdding(true)} />}
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
    onError: (err) => Alert.alert("Couldn't add the task", err instanceof ApiError && err.code === "device_forbidden" ? UPDATE_DESKTOP_MESSAGE : errorText(err)),
  });
  const urgent = priority === "high";
  return (
    <Card style={styles.add}>
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="What do you need to do?"
        placeholderTextColor={c.textFaint}
        autoFocus
        returnKeyType="next"
        maxLength={200}
        style={[styles.title, { color: c.text }]}
      />
      <TextInput
        value={body}
        onChangeText={setBody}
        placeholder="Note (optional)"
        placeholderTextColor={c.textFaint}
        multiline
        style={[styles.body, { color: c.text, borderTopColor: c.border }]}
      />
      <Segmented
        options={[
          { value: "open", label: "To do" },
          { value: "backlog", label: "Backlog" },
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
          {urgent ? "Urgent" : "Mark urgent"}
        </T>
      </Pressable>
      <Row style={{ gap: space.sm }}>
        <Button title="Cancel" variant="secondary" onPress={onDone} style={{ flex: 1 }} />
        <Button title="Add task" icon="plus" loading={create.isPending} disabled={!title.trim()} onPress={() => create.mutate()} style={{ flex: 1 }} />
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
