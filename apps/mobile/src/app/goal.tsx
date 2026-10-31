import { DateTimePicker } from "@expo/ui/community/datetime-picker";
import { DatePicker, Host } from "@expo/ui/swift-ui";
import { datePickerStyle, tint } from "@expo/ui/swift-ui/modifiers";
import { useMutation, useQuery } from "@tanstack/react-query";
import { addDays, endOfMonth, endOfQuarter, format, parseISO } from "date-fns";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { MAX_GOAL_TITLE_LENGTH, MAX_GOAL_WHY_LENGTH, type Goal, type GoalStatus } from "@godmode/shared";
import { Group, SegmentRow } from "@/components/form";
import { Icon } from "@/components/icon";
import { Button, ErrorState, LoadingState, Row, T, tap } from "@/components/ui";
import { api, ApiError, errorText, updateDesktopMessage } from "@/lib/api";
import { dateLocale } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

interface Draft {
  title: string;
  why: string;
  targetDate: string | null;
  status: GoalStatus;
}

const STATUSES = ["active", "achieved", "dropped"] as const satisfies readonly GoalStatus[];

const day = (date: Date) => format(date, "yyyy-MM-dd");

const draftOf = (g?: Goal): Draft => ({ title: g?.title ?? "", why: g?.why ?? "", targetDate: g?.targetDate ?? null, status: g?.status ?? "active" });

const failure = (err: unknown) => (err instanceof ApiError && err.code === "device_forbidden" ? updateDesktopMessage() : errorText(err));

/** The goal as any goals list on the phone has it, so the sheet opens without waiting. */
function cachedGoal(id: string): Goal | undefined {
  for (const [, list] of queryClient.getQueriesData<Goal[]>({ queryKey: ["goals"] })) {
    const hit = list?.find((g) => g.id === id);
    if (hit) return hit;
  }
}

function refresh() {
  void queryClient.invalidateQueries({ queryKey: ["goals"] });
  void queryClient.invalidateQueries({ queryKey: qk.tasks });
}

/** Add or edit a goal: what it is, why it matters (the agents get that), when; once there, whether it's reached. */
export default function GoalSheet() {
  const c = useColors();
  const { t } = useTranslation(["settings", "common"]);
  const params = useLocalSearchParams<{ id?: string; workspaceId?: string }>();
  const id = params.id || null;
  const seed = useMemo(() => (id ? cachedGoal(id) : undefined), [id]);
  const list = useQuery({ queryKey: qk.goals(null), queryFn: () => api.goals.list(null), enabled: !!id, placeholderData: seed ? [seed] : undefined });
  const goal = id ? list.data?.find((g) => g.id === id) : undefined;
  const [draft, setDraft] = useState<Draft | null>(() => (id ? (seed ? draftOf(seed) : null) : draftOf()));
  // Opened before the goal was on the phone: fill the form once it is.
  if (!draft && goal) setDraft(draftOf(goal));

  const save = useMutation({
    mutationFn: (d: Draft) => {
      const input = { title: d.title.trim(), why: d.why.trim(), targetDate: d.targetDate };
      return id ? api.goals.update(id, { ...input, status: d.status }) : api.goals.create({ ...input, workspaceId: params.workspaceId || null });
    },
    onSuccess: () => {
      refresh();
      router.back();
    },
    onError: (err) => Alert.alert(t("goal.saveFailed"), failure(err)),
  });
  const remove = useMutation({
    mutationFn: (goalId: string) => api.goals.delete(goalId),
    onSuccess: () => {
      refresh();
      router.back();
    },
    onError: (err) => Alert.alert(t("goal.deleteFailed"), failure(err)),
  });

  if (!draft) {
    return (
      <View style={[styles.fill, { backgroundColor: c.background }]}>
        {list.isLoading ? (
          <LoadingState label={t("goal.loading")} />
        ) : list.isError ? (
          <ErrorState title={t("goal.loadFailed")} error={failure(list.error)} onRetry={() => void list.refetch()} />
        ) : (
          <ErrorState title={t("goal.gone.title")} error={t("goal.gone.body")} />
        )}
      </View>
    );
  }

  const busy = save.isPending || remove.isPending;
  const ready = !!draft.title.trim() && !busy;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const submit = () => {
    if (!ready) return;
    tap();
    save.mutate(draft);
  };
  const confirmDelete = (g: Goal) =>
    Alert.alert(
      t("goal.deleteDialog.title", { title: g.title }),
      g.tickets.total ? t("goal.deleteDialog.ticketsStay", { count: g.tickets.total }) : t("goal.deleteDialog.noTickets"),
      [
        { text: t("goal.deleteDialog.keep"), style: "cancel" },
        { text: t("common:actions.delete"), style: "destructive", onPress: () => remove.mutate(g.id) },
      ],
    );

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
    >
      <View style={{ gap: space.sm }}>
        <Row>
          <Pressable accessibilityRole="button" hitSlop={10} disabled={busy} onPress={() => router.back()} style={styles.headSide}>
            <T variant="callout" muted>
              {t("common:actions.cancel")}
            </T>
          </Pressable>
          <T variant="headline" numberOfLines={1} style={{ flex: 1, textAlign: "center" }}>
            {id ? t("goal.edit") : t("goal.new")}
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
              <T variant="callout" color={ready ? c.brandStrong : c.textFaint} style={{ fontWeight: "600" }}>
                {id ? t("common:actions.save") : t("goal.add")}
              </T>
            )}
          </Pressable>
        </Row>
        <T variant="footnote" muted style={{ textAlign: "center" }}>
          {t("goal.intro")}
        </T>
      </View>

      <View>
        <View style={[styles.fields, { backgroundColor: c.surface, borderColor: c.border }]}>
          <TextInput
            accessibilityLabel={t("goal.title")}
            value={draft.title}
            onChangeText={(title) => set({ title })}
            placeholder={t("goal.titlePlaceholder")}
            placeholderTextColor={c.textFaint}
            maxLength={MAX_GOAL_TITLE_LENGTH}
            autoFocus={!id}
            returnKeyType="done"
            submitBehavior="blurAndSubmit"
            style={[styles.title, { color: c.text }]}
          />
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />
          <TextInput
            accessibilityLabel={t("goal.why")}
            value={draft.why}
            onChangeText={(why) => set({ why })}
            placeholder={t("goal.whyPlaceholder")}
            placeholderTextColor={c.textFaint}
            maxLength={MAX_GOAL_WHY_LENGTH}
            multiline
            style={[styles.why, { color: c.text }]}
          />
        </View>
        <T variant="footnote" muted style={styles.note}>
          {t("goal.note")}
        </T>
      </View>

      <Group
        footer={
          goal
            ? goal.tickets.total
              ? t("goal.progress", { done: goal.tickets.done, count: goal.tickets.total })
              : t("goal.noTickets")
            : undefined
        }
      >
        <TargetDate value={draft.targetDate} onChange={(targetDate) => set({ targetDate })} />
        {id ? <SegmentRow title={t("goal.status.title")} options={STATUSES.map((s) => ({ value: s, label: t(`goal.status.${s}`) }))} value={draft.status} onChange={(status) => set({ status })} /> : null}
      </Group>

      {goal ? <Button title={t("goal.delete")} icon="trash" variant="danger" loading={remove.isPending} disabled={busy} onPress={() => confirmDelete(goal)} /> : null}
    </ScrollView>
  );
}

/** The day it should be reached by: the system's date picker, a few quick picks, or none. */
function TargetDate({ value, onChange }: { value: string | null; onChange: (day: string | null) => void }) {
  const c = useColors();
  const { t } = useTranslation(["settings", "common"]);
  const [asking, setAsking] = useState(false);
  const date = value ? parseISO(value) : null;
  const today = new Date();
  const quick = [
    { label: t("goal.quick.week"), day: day(addDays(today, 7)) },
    { label: t("goal.quick.month"), day: day(endOfMonth(today)) },
    { label: t("goal.quick.quarter"), day: day(endOfQuarter(today)) },
  ];
  const shown = date ? format(date, t("goal.datePattern"), { locale: dateLocale() }) : "";
  const ios = process.env.EXPO_OS === "ios";
  return (
    <View style={styles.dateRow}>
      <Row style={{ gap: space.md, minHeight: 34 }}>
        <T variant="callout" style={{ flex: 1, fontWeight: "500" }}>
          {t("goal.targetDate")}
        </T>
        {date && ios ? (
          <Host matchContents>
            <DatePicker selection={date} displayedComponents={["date"]} onDateChange={(d) => onChange(day(d))} modifiers={[datePickerStyle("compact"), tint(c.brand)]} />
          </Host>
        ) : !ios ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={date ? t("goal.changeDate", { date: shown }) : t("goal.pickTargetDate")}
            hitSlop={6}
            onPress={() => {
              tap();
              setAsking(true);
            }}
            style={[styles.dateButton, { backgroundColor: c.sunken }]}
          >
            <T variant="subhead" color={date ? c.text : c.textMuted}>
              {date ? shown : t("goal.pickDate")}
            </T>
          </Pressable>
        ) : (
          <T variant="subhead" muted>
            {t("common:status.none")}
          </T>
        )}
        {date ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("goal.removeDate")}
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
      <Row style={{ gap: 6, flexWrap: "wrap" }}>
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
              style={({ pressed }) => [styles.quick, { backgroundColor: on ? c.primary : c.sunken, opacity: pressed ? 0.7 : 1 }]}
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
          value={date ?? addDays(today, 7)}
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

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    justifyContent: "center",
  },
  content: {
    paddingTop: 20,
    paddingHorizontal: space.xl,
    paddingBottom: 40,
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
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  why: {
    fontSize: 15,
    lineHeight: 20,
    minHeight: 88,
    maxHeight: 200,
    paddingHorizontal: space.lg,
    paddingTop: 12,
    paddingBottom: 12,
    textAlignVertical: "top",
  },
  note: {
    marginTop: space.sm,
    paddingHorizontal: 4,
  },
  dateRow: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
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
});
