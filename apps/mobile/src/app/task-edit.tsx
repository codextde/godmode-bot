import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { DatePicker, Host } from "@expo/ui/swift-ui";
import { datePickerStyle, tint } from "@expo/ui/swift-ui/modifiers";
import { useMutation, useQuery } from "@tanstack/react-query";
import { addDays, format, parseISO } from "date-fns";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  cleanTaskLabel,
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_TASK_LABELS,
  MAX_TASK_TITLE_LENGTH,
  TASK_PRIORITIES,
  type Task,
  type TaskPriority,
} from "@godmode/shared";
import { Group, PickerRow } from "@/components/form";
import { Icon } from "@/components/icon";
import { STATUS_META } from "@/components/task-row";
import { ErrorState, Hairline, LoadingState, Row, SectionTitle, T, tap } from "@/components/ui";
import { api, ApiError, errorText, updateDesktopMessage } from "@/lib/api";
import { dueLabel, isWorking, PRIORITY_LABEL } from "@/lib/desktop-parity";
import { useAgents } from "@/lib/hooks";
import { dateLocale } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

const MAX_WAITS = 10;
const NO_GOAL = "none";

interface Draft {
  title: string;
  description: string;
  priority: TaskPriority;
  dueDate: string | null;
  labels: string[];
  goalId: string | null;
  waitsFor: string[];
  blockedReason: string;
}

const day = (date: Date) => format(date, "yyyy-MM-dd");

const draftOf = (t: Task): Draft => ({
  title: t.title,
  description: t.description,
  priority: t.priority,
  dueDate: t.dueDate,
  labels: t.labels ?? [],
  goalId: t.goalId,
  waitsFor: (t.waitsFor ?? []).map((w) => w.id),
  blockedReason: t.blockedReason ?? "",
});

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const failure = (err: unknown) => (err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err));

/** Edit a ticket after it was filed: its words, priority, due day, labels, goal and what it waits for; `block`: put it on Blocked with a reason. */
export default function TaskEdit() {
  const c = useColors();
  const { t } = useTranslation(["tasks", "common"]);
  const params = useLocalSearchParams<{ id: string; block?: string }>();
  const id = params.id;
  const blocking = params.block === "1";
  // The ticket screen loaded the whole ticket (with its description); the board's copy has none.
  const task = useQuery({
    queryKey: qk.task(id),
    queryFn: () => api.tasks.get(id),
  });
  const whole = task.data && !task.isPlaceholderData ? task.data : undefined;
  const [draft, setDraft] = useState<Draft | null>(null);
  if (!draft && whole) setDraft(draftOf(whole));

  if (!draft || !whole) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {task.isError ? (
          task.error instanceof ApiError && task.error.status === 404 ? (
            <ErrorState title={t("edit.gone")} error={errorText(task.error)} />
          ) : (
            <ErrorState title={t("task.openFailed")} error={errorText(task.error)} onRetry={() => void task.refetch()} />
          )
        ) : (
          <LoadingState label={t("task.loadingTask")} />
        )}
      </View>
    );
  }
  return <Editor task={whole} draft={draft} setDraft={setDraft} blocking={blocking} />;
}

function Editor({ task, draft, setDraft, blocking }: { task: Task; draft: Draft; setDraft: (d: Draft) => void; blocking: boolean }) {
  const c = useColors();
  const { t } = useTranslation(["tasks", "common"]);
  const { byId } = useAgents();
  const goals = useQuery({
    queryKey: qk.goals(task.workspaceId),
    queryFn: () => api.goals.list(task.workspaceId),
  });
  const board = useQuery({
    queryKey: qk.taskList(task.workspaceId),
    queryFn: () => api.tasks.list({ workspaceId: task.workspaceId }),
  });
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const reasonShown = blocking || (task.status === "blocked" && task.blockedKind === "manual");

  const patch = useMemo(() => {
    const p: Parameters<typeof api.tasks.update>[1] = {};
    const base = draftOf(task);
    if (draft.title.trim() !== base.title) p.title = draft.title.trim();
    if (draft.description !== base.description) p.description = draft.description;
    if (draft.priority !== base.priority) p.priority = draft.priority;
    if (draft.dueDate !== base.dueDate) p.dueDate = draft.dueDate;
    if (!same(draft.labels, base.labels)) p.labels = draft.labels;
    if (draft.goalId !== base.goalId) p.goalId = draft.goalId;
    if (!same(draft.waitsFor, base.waitsFor)) p.waitsFor = draft.waitsFor;
    if (blocking) {
      p.status = "blocked";
      p.blockedReason = draft.blockedReason.trim();
    } else if (reasonShown && draft.blockedReason.trim() !== base.blockedReason) p.blockedReason = draft.blockedReason.trim();
    return p;
  }, [draft, task, blocking, reasonShown]);

  const save = useMutation({
    mutationFn: () => api.tasks.update(task.id, patch),
    onSuccess: (next) => {
      queryClient.setQueryData(qk.task(task.id), next);
      void queryClient.invalidateQueries({ queryKey: qk.tasks });
      void queryClient.invalidateQueries({ queryKey: ["goals"] });
      router.back();
    },
    onError: (err) => Alert.alert(t("edit.saveFailed"), failure(err)),
  });

  const changed = Object.keys(patch).length > 0;
  const ready = !!draft.title.trim() && changed && !save.isPending;
  const submit = () => {
    if (!ready) return;
    tap();
    if (!blocking || !isWorking(task)) return save.mutate();
    const agent = task.agentId ? byId.get(task.agentId)?.name : undefined;
    Alert.alert(t("task.stopAgentTitle"), t("edit.blockStops", { agent: agent ?? t("task.theAgent") }), [
      { text: t("task.keepWorking"), style: "cancel" },
      {
        text: t("edit.blockConfirm"),
        style: "destructive",
        onPress: () => save.mutate(),
      },
    ]);
  };

  const activeGoals = (goals.data ?? []).filter((g) => g.status === "active" || g.id === draft.goalId);
  const tickets = (board.data ?? [])
    .filter(
      (x) =>
        x.id !== task.id && x.parentId !== task.id && (draft.waitsFor.includes(x.id) || (x.status !== "done" && x.status !== "cancelled" && !x.archivedAt)),
    )
    .sort((a, b) => Number(draft.waitsFor.includes(b.id)) - Number(draft.waitsFor.includes(a.id)) || b.number - a.number);

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <Row>
        <Pressable accessibilityRole="button" hitSlop={10} disabled={save.isPending} onPress={() => router.back()} style={styles.headSide}>
          <T variant="callout" muted>
            {t("common:actions.cancel")}
          </T>
        </Pressable>
        <T variant="headline" numberOfLines={1} style={{ flex: 1, textAlign: "center" }}>
          {blocking ? t("edit.blockTitle") : t("edit.title")}
        </T>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready, busy: save.isPending }}
          hitSlop={10}
          disabled={!ready}
          onPress={submit}
          style={[styles.headSide, { alignItems: "flex-end" }]}
        >
          {save.isPending ? (
            <ActivityIndicator size="small" color={c.textMuted} />
          ) : (
            <T variant="callout" color={ready ? (blocking ? c.danger : c.brandStrong) : c.textFaint} style={{ fontWeight: "600" }}>
              {blocking ? t("edit.block") : t("common:actions.save")}
            </T>
          )}
        </Pressable>
      </Row>

      {reasonShown ? (
        <View>
          <SectionTitle title={t("edit.blockReason")} />
          <View style={[styles.fields, { backgroundColor: c.surface, borderColor: c.border }]}>
            <TextInput
              accessibilityLabel={t("edit.blockReason")}
              value={draft.blockedReason}
              onChangeText={(blockedReason) => set({ blockedReason })}
              placeholder={t("edit.blockReasonPlaceholder")}
              placeholderTextColor={c.textFaint}
              maxLength={2000}
              multiline
              autoFocus={blocking}
              style={[styles.description, { color: c.text, minHeight: 64 }]}
            />
          </View>
        </View>
      ) : null}

      {blocking ? null : (
        <>
          <View style={[styles.fields, { backgroundColor: c.surface, borderColor: c.border }]}>
            <TextInput
              accessibilityLabel={t("edit.titlePlaceholder")}
              value={draft.title}
              onChangeText={(title) => set({ title })}
              placeholder={t("edit.titlePlaceholder")}
              placeholderTextColor={c.textFaint}
              maxLength={MAX_TASK_TITLE_LENGTH}
              multiline
              submitBehavior="blurAndSubmit"
              returnKeyType="done"
              style={[styles.title, { color: c.text }]}
            />
            <View
              style={{
                height: StyleSheet.hairlineWidth,
                backgroundColor: c.border,
              }}
            />
            <TextInput
              accessibilityLabel={t("edit.descriptionPlaceholder")}
              value={draft.description}
              onChangeText={(description) => set({ description })}
              placeholder={t("edit.descriptionPlaceholder")}
              placeholderTextColor={c.textFaint}
              maxLength={MAX_TASK_DESCRIPTION_LENGTH}
              multiline
              style={[styles.description, { color: c.text }]}
            />
          </View>

          <Group>
            <PickerRow
              icon="flag"
              title={t("edit.priority")}
              value={draft.priority}
              options={TASK_PRIORITIES.map((p) => ({
                value: p,
                label: PRIORITY_LABEL[p],
              }))}
              onChange={(priority) => set({ priority })}
            />
            <DueDate value={draft.dueDate} status={task.status} onChange={(dueDate) => set({ dueDate })} />
            {activeGoals.length ? (
              <PickerRow
                icon="target"
                title={t("edit.goal")}
                value={draft.goalId ?? NO_GOAL}
                options={[{ value: NO_GOAL, label: t("edit.noGoal") }, ...activeGoals.map((g) => ({ value: g.id, label: g.title }))]}
                onChange={(v) => set({ goalId: v === NO_GOAL ? null : v })}
              />
            ) : null}
          </Group>

          <Labels value={draft.labels} onChange={(labels) => set({ labels })} />

          <WaitsFor tickets={tickets} loading={board.isLoading} value={draft.waitsFor} onChange={(waitsFor) => set({ waitsFor })} />
        </>
      )}
    </ScrollView>
  );
}

/** The day it should be done by: the system's date picker, a few quick picks, or none. */
function DueDate({ value, status, onChange }: { value: string | null; status: Task["status"]; onChange: (day: string | null) => void }) {
  const c = useColors();
  const { t } = useTranslation(["tasks", "common", "system"]);
  const [asking, setAsking] = useState(false);
  const date = value ? parseISO(value) : null;
  const today = new Date();
  const quick = [
    { label: t("common:words.today"), day: day(today) },
    { label: t("system:days.tomorrow"), day: day(addDays(today, 1)) },
    { label: t("edit.nextWeek"), day: day(addDays(today, 7)) },
  ];
  const shown = value ? dueLabel(value) : "";
  const overdue = !!value && value < day(today) && status !== "done" && status !== "cancelled";
  const ios = process.env.EXPO_OS === "ios";
  return (
    <View style={styles.dateRow}>
      <Row style={{ gap: space.md, minHeight: 34 }}>
        <View style={[styles.tile, { backgroundColor: c.sunken }]}>
          <Icon name="calendar" size={15} color={overdue ? c.danger : c.text} />
        </View>
        <T variant="callout" style={{ flex: 1, fontWeight: "500" }}>
          {t("edit.dueDate")}
        </T>
        {date && ios ? (
          <Host matchContents>
            <DatePicker
              selection={date}
              displayedComponents={["date"]}
              onDateChange={(d) => onChange(day(d))}
              modifiers={[datePickerStyle("compact"), tint(c.brand)]}
            />
          </Host>
        ) : !ios || !date ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={date ? t("edit.changeDate", { date: shown }) : t("edit.pickDate")}
            hitSlop={6}
            onPress={() => {
              tap();
              if (ios) onChange(day(addDays(today, 1)));
              else setAsking(true);
            }}
            style={[styles.dateButton, { backgroundColor: c.sunken }]}
          >
            <T variant="subhead" color={date ? (overdue ? c.danger : c.text) : c.textMuted}>
              {date
                ? format(date, t("system:formats.dueThisYear"), {
                    locale: dateLocale(),
                  })
                : t("edit.pickDate")}
            </T>
          </Pressable>
        ) : null}
        {date ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("edit.removeDate")}
            hitSlop={8}
            onPress={() => {
              tap();
              onChange(null);
            }}
          >
            <Icon name="closeCircle" size={18} color={c.textFaint} />
          </Pressable>
        ) : null}
      </Row>
      <Row style={{ gap: 6, flexWrap: "wrap", paddingLeft: 30 + space.md }}>
        {quick.map((q) => {
          const on = q.day === value;
          return (
            <Pressable
              key={q.label}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => {
                tap();
                onChange(q.day);
              }}
              style={({ pressed }) => [
                styles.quick,
                {
                  backgroundColor: on ? c.primary : c.sunken,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}
            >
              <T variant="footnote" color={on ? c.onPrimary : c.text} style={{ fontWeight: "600" }}>
                {q.label}
              </T>
            </Pressable>
          );
        })}
      </Row>
      {asking ? (
        <DateTimePicker
          value={date ?? addDays(today, 1)}
          mode="date"
          accentColor={c.brand}
          onValueChange={(_, d) => {
            setAsking(false);
            onChange(day(d));
          }}
          onDismiss={() => setAsking(false)}
        />
      ) : null}
    </View>
  );
}

function Labels({ value, onChange }: { value: string[]; onChange: (labels: string[]) => void }) {
  const c = useColors();
  const { t } = useTranslation("tasks");
  const [text, setText] = useState("");
  const add = () => {
    const label = cleanTaskLabel(text);
    setText("");
    if (!label || value.some((l) => l.toLowerCase() === label.toLowerCase())) return;
    onChange([...value, label]);
  };
  const full = value.length >= MAX_TASK_LABELS;
  return (
    <View>
      <SectionTitle title={t("edit.labels")} />
      <View style={[styles.labels, { backgroundColor: c.surface, borderColor: c.border }]}>
        {value.map((l) => (
          <Pressable
            key={l}
            accessibilityRole="button"
            accessibilityLabel={t("edit.removeLabel", { label: l })}
            onPress={() => {
              tap();
              onChange(value.filter((x) => x !== l));
            }}
            style={({ pressed }) => [styles.label, { backgroundColor: c.sunken, opacity: pressed ? 0.6 : 1 }]}
          >
            <T variant="footnote" style={{ fontWeight: "500" }}>
              {l}
            </T>
            <Icon name="close" size={9} color={c.textMuted} weight="bold" />
          </Pressable>
        ))}
        {full ? null : (
          <TextInput
            accessibilityLabel={t("edit.addLabel")}
            value={text}
            onChangeText={setText}
            onSubmitEditing={add}
            onBlur={add}
            placeholder={t("edit.addLabel")}
            placeholderTextColor={c.textFaint}
            autoCapitalize="none"
            returnKeyType="done"
            submitBehavior="submit"
            style={[styles.labelInput, { color: c.text }]}
          />
        )}
      </View>
    </View>
  );
}

/** The tickets of its board it waits for: it starts once each is delivered. */
function WaitsFor({ tickets, loading, value, onChange }: { tickets: Task[]; loading: boolean; value: string[]; onChange: (ids: string[]) => void }) {
  const c = useColors();
  const { t } = useTranslation("tasks");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = tickets.filter((x) => !q || `#${x.number} ${x.title}`.toLowerCase().includes(q)).slice(0, 40);
  const toggle = (id: string) => {
    tap();
    onChange(value.includes(id) ? value.filter((x) => x !== id) : value.length >= MAX_WAITS ? value : [...value, id]);
  };
  return (
    <View>
      <SectionTitle title={value.length ? `${t("edit.waitsFor")} · ${value.length}` : t("edit.waitsFor")} />
      <View style={[styles.fields, { backgroundColor: c.surface, borderColor: c.border }]}>
        {tickets.length > 8 ? (
          <>
            <Row style={{ gap: space.sm, paddingHorizontal: space.lg }}>
              <Icon name="search" size={14} color={c.textFaint} />
              <TextInput
                accessibilityLabel={t("edit.findTicket")}
                value={query}
                onChangeText={setQuery}
                placeholder={t("edit.findTicket")}
                placeholderTextColor={c.textFaint}
                style={[styles.search, { color: c.text }]}
              />
            </Row>
            <Hairline />
          </>
        ) : null}
        {loading ? (
          <View style={{ padding: space.lg }}>
            <ActivityIndicator color={c.textMuted} />
          </View>
        ) : !tickets.length ? (
          <T variant="subhead" muted style={{ padding: space.lg }}>
            {t("edit.noTickets")}
          </T>
        ) : (
          shown.map((x, i) => {
            const on = value.includes(x.id);
            return (
              <View key={x.id}>
                {i > 0 && <Hairline inset={space.lg} />}
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  onPress={() => toggle(x.id)}
                  style={({ pressed }) => [styles.ticket, pressed && { backgroundColor: c.sunken }]}
                >
                  <T variant="footnote" muted style={{ fontVariant: ["tabular-nums"], minWidth: 34 }}>
                    #{x.number}
                  </T>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T variant="subhead" numberOfLines={1}>
                      {x.title}
                    </T>
                    <T variant="caption" muted numberOfLines={1}>
                      {STATUS_META[x.status].label}
                    </T>
                  </View>
                  {on ? <Icon name="checkCircle" size={20} color={c.brandStrong} /> : <View style={[styles.ring, { borderColor: c.borderStrong }]} />}
                </Pressable>
              </View>
            );
          })
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    justifyContent: "center",
  },
  content: {
    paddingTop: 20,
    paddingHorizontal: space.xl,
    paddingBottom: 60,
    gap: space.xl,
  },
  headSide: {
    minWidth: 76,
    height: 32,
    justifyContent: "center",
  },
  fields: {
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  description: {
    fontSize: 15,
    lineHeight: 20,
    minHeight: 120,
    paddingHorizontal: space.lg,
    paddingTop: 12,
    paddingBottom: 12,
    textAlignVertical: "top",
  },
  dateRow: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  tile: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  dateButton: {
    height: 34,
    justifyContent: "center",
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
  },
  quick: {
    height: 30,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: radius.pill,
  },
  labels: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    padding: space.md,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  label: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
  },
  labelInput: {
    flexGrow: 1,
    minWidth: 120,
    height: 32,
    fontSize: 15,
    paddingHorizontal: 4,
  },
  search: {
    flex: 1,
    height: 44,
    fontSize: 15,
  },
  ticket: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  ring: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
  },
});
