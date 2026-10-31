import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AutomationEvent, AutomationEventSource, AutomationEventStatus, Routine, RoutineNotify } from "@godmode/shared";
import { CharacterAvatar } from "@/components/character";
import { Group, SwitchRow } from "@/components/form";
import { HeaderActions, type HeaderMenuItem } from "@/components/header-actions";
import { Icon, type IconName } from "@/components/icon";
import { appName, runLabel, runRoutine, setRoutineEnabled, triggerText, TRIGGER_TITLES } from "@/components/routine-row";
import { openChat } from "@/components/rows";
import { runStatusLabel } from "@/components/run-row";
import { Badge, Button, Card, EmptyState, ErrorState, Hairline, LoadingState, Row, SectionTitle, SkeletonRows, T, tap, type Tone } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { isFailingRoutine } from "@/lib/desktop-parity";
import { whenText } from "@/lib/format";
import { dateLocale } from "@/lib/i18n";
import { useAgents, useNow } from "@/lib/hooks";
import { useLive } from "@/lib/live";
import { qk, queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

const EVENT_LIMIT = 50;

const EVENT_SOURCES = {
  schedule: { label: "automation.source.schedule", icon: "clock" },
  app: { label: "automation.source.app", icon: "layers" },
  webhook: { label: "automation.source.webhook", icon: "link" },
  condition: { label: "automation.source.condition", icon: "eye" },
  manual: { label: "automation.source.manual", icon: "hand" },
} as const satisfies Record<AutomationEventSource, { label: string; icon: IconName }>;

const EVENT_STATUS = {
  pending: { label: "automation.eventStatus.pending", tone: "warning" },
  running: { label: "automation.eventStatus.running", tone: "brand" },
  done: { label: "automation.eventStatus.done", tone: "success" },
  failed: { label: "automation.eventStatus.failed", tone: "danger" },
  skipped: { label: "automation.eventStatus.skipped", tone: "neutral" },
} as const satisfies Record<AutomationEventStatus, { label: string; tone: Tone }>;

const NOTIFY_LABELS = {
  failures: "notify.failures",
  always: "notify.always",
  never: "notify.never",
} as const satisfies Record<RoutineNotify, string>;

const ago = (iso: string) => formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: dateLocale() });

/** One automation, like the desktop's row and events sheet together: what starts it, when, what it does, and what happened lately. */
export default function AutomationScreen() {
  const { t } = useTranslation(["automations", "common"]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = useQuery({ queryKey: qk.allRoutines, queryFn: () => api.routines.list() });
  const routine = list.data?.find((r) => r.id === id);

  if (!routine) {
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <Stack.Title>{t("automation.title")}</Stack.Title>
        {list.isLoading ? (
          <LoadingState label={t("automation.loading")} />
        ) : (
          <ErrorState
            title={list.isError ? t("automation.loadFailed") : t("automation.notFound")}
            error={list.isError ? errorText(list.error) : t("automation.maybeDeleted")}
            onRetry={list.isError ? () => void list.refetch() : undefined}
          />
        )}
      </View>
    );
  }
  return <AutomationView routine={routine} refetchList={list.refetch} />;
}

function AutomationView({ routine, refetchList }: { routine: Routine; refetchList: () => Promise<unknown> }) {
  const c = useColors();
  const { t } = useTranslation(["automations", "common"]);
  const id = routine.id;
  const { byId } = useAgents();
  const agent = byId.get(routine.agentId);
  const working = useLive((s) => Object.values(s.runs).some(({ run }) => run.routineId === id));
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  useNow(30_000);
  const events = useQuery({
    queryKey: qk.routineEvents(id),
    queryFn: () => api.routines.events(id, EVENT_LIMIT),
    // Live-ish while something is still waiting or running.
    refetchInterval: (q) => (q.state.data?.some((e) => e.status === "pending" || e.status === "running") ? 5000 : false),
  });

  const refetchEvents = events.refetch;
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) {
        void refetchList();
        void refetchEvents();
      }
      shown.current = true;
    }, [refetchList, refetchEvents]),
  );

  const trigger = routine.trigger;
  const status = routine.triggerStatus;
  const keepsChat = routine.reuseConversation && !!routine.conversationId;
  const editable = trigger.type === "schedule" || trigger.type === "condition";
  const edit = () => router.push({ pathname: "/automation-edit", params: { id } });

  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([refetchList(), refetchEvents()]);
    } finally {
      setRefreshing(false);
    }
  };

  const run = () => {
    setStarting(true);
    void runRoutine(routine).finally(() => setStarting(false));
  };

  const remove = () =>
    Alert.alert(
      t("automation.deleteTitle", { name: routine.name }),
      trigger.type === "app"
        ? t("automation.deleteMessageApp", { trigger: trigger.triggerName, app: appName(trigger.toolkit) })
        : trigger.type === "webhook"
          ? t("automation.deleteMessageWebhook")
          : t("automation.deleteMessage"),
      [
        { text: t("common:actions.cancel"), style: "cancel" },
        {
          text: t("automation.delete"),
          style: "destructive",
          onPress: () =>
            void api.routines
              .delete(id)
              .then(() => {
                router.back();
                void queryClient.invalidateQueries({ queryKey: qk.routines });
              })
              .catch((err) => Alert.alert(t("automation.deleteFailed"), errorText(err))),
        },
      ],
    );

  const openEvent = (e: AutomationEvent) => {
    if (!e.runId) return;
    if (keepsChat) return openChat(routine.conversationId!);
    const runId = e.runId;
    queryClient
      .fetchQuery({ queryKey: qk.run(runId), queryFn: () => api.runs.get(runId) })
      .then((r) => openChat(r.conversationId))
      .catch((err) => Alert.alert(t("automation.openChatFailed"), errorText(err)));
  };

  const menu: HeaderMenuItem[] = [
    ...(routine.conversationId ? [{ icon: "chats" as IconName, title: t("automation.openChat"), onPress: () => openChat(routine.conversationId!) }] : []),
    { icon: "trash", title: t("common:actions.delete"), destructive: true, onPress: remove },
  ];

  const next = routine.enabled && routine.nextRunAt ? `${whenText(routine.nextRunAt)} · ${ago(routine.nextRunAt)}` : routine.enabled ? "—" : t("status.paused");
  const last = routine.lastRunAt ? `${routine.lastStatus ? `${runStatusLabel(routine.lastStatus)} · ` : ""}${ago(routine.lastRunAt)}` : t("common:words.never");
  const lastCheck = trigger.type === "condition" && (status.observation || status.lastCheckAt);
  const shownEvents = events.data ?? [];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      <Stack.Title>{routine.name}</Stack.Title>
      <HeaderActions actions={[{ icon: "pencil", label: t("common:actions.edit"), onPress: edit }]} menu={menu} />

      <View style={styles.hero}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={agent ? t("automation.openAgent", { name: agent.name }) : undefined}
          disabled={!agent}
          onPress={() => {
            tap();
            router.push({ pathname: "/agent/[id]", params: { id: routine.agentId } });
          }}
        >
          <CharacterAvatar agent={agent} size={64} running={working} />
        </Pressable>
        <T variant="title" style={{ textAlign: "center" }}>
          {routine.name}
        </T>
        <Row style={{ gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
          {working ? (
            <Badge label={t("automation.runningNow")} tone="brand" live />
          ) : routine.enabled ? (
            <Badge label={isFailingRoutine(routine) ? t("status.failing") : t("status.active")} tone={isFailingRoutine(routine) ? "danger" : "success"} />
          ) : (
            <Badge label={t("status.paused")} />
          )}
          {routine.fillOnly ? <Badge label={t("automation.fillOnly")} dot={false} /> : null}
        </Row>
        {agent ? (
          <T variant="subhead" muted style={{ textAlign: "center" }}>
            {agent.name}
          </T>
        ) : null}
        <Row style={{ gap: space.sm, alignSelf: "stretch", marginTop: space.sm }}>
          <Button
            title={runLabel(trigger.type)}
            icon="play"
            variant="secondary"
            loading={starting}
            disabled={!routine.enabled || working}
            onPress={run}
            style={{ flex: 1 }}
          />
          {keepsChat ? (
            <Button title={t("automation.openChat")} icon="chats" onPress={() => openChat(routine.conversationId!)} style={{ flex: 1 }} />
          ) : (
            <Button title={t("common:actions.edit")} icon="pencil" onPress={edit} style={{ flex: 1 }} />
          )}
        </Row>
      </View>

      {routine.enabled && (status.state === "error" || status.state === "pending") ? (
        <View style={[styles.notice, { backgroundColor: status.state === "error" ? c.dangerSoft : c.surface, borderColor: status.state === "error" ? c.danger : c.border }]}>
          <Icon name={status.state === "error" ? "warning" : "clock"} size={14} color={status.state === "error" ? c.danger : c.textMuted} />
          <T variant="footnote" color={status.state === "error" ? c.danger : c.textMuted} style={{ flex: 1 }}>
            {status.message ?? (status.state === "error" ? t("automation.triggerBroken") : t("automation.triggerSettingUp"))}
          </T>
        </View>
      ) : null}

      <Group title={t("automation.trigger")} footer={editable ? undefined : t("automation.changeTriggerOnComputer")}>
        <Info label={TRIGGER_TITLES[trigger.type]} value={triggerText(routine, false)} />
        {trigger.type === "schedule" || trigger.type === "condition" ? <Info label={trigger.type === "condition" ? t("automation.nextCheck") : t("automation.nextRun")} value={next} /> : null}
        <Info label={t("automation.lastRun")} value={last} tone={routine.lastStatus === "failed" ? "danger" : undefined} />
        {routine.filter ? <Info label={t("automation.onlyWhen")} value={routine.filter} /> : null}
      </Group>

      {trigger.type === "condition" ? (
        <View>
          <SectionTitle title={t("automation.condition")} />
          <Card style={styles.text}>
            <T variant="callout">{t("automation.when", { condition: trigger.condition })}</T>
            {lastCheck ? (
              <View style={{ gap: 2, marginTop: space.sm }}>
                <T variant="eyebrow" muted>
                  {status.lastCheckAt ? t("automation.lastCheckAgo", { ago: ago(status.lastCheckAt) }) : t("automation.lastCheck")}
                </T>
                <T variant="footnote" muted>
                  {status.observation ?? t("automation.nothingNoted")}
                </T>
              </View>
            ) : null}
          </Card>
        </View>
      ) : null}

      <View>
        <SectionTitle title={t("automation.whatItDoes")} />
        <Card style={styles.text}>
          <T variant="callout">{routine.prompt}</T>
        </Card>
      </View>

      <Group title={t("common:words.settings")}>
        <SwitchRow
          title={t("automation.enabled")}
          detail={editable ? t("automation.enabledHint") : t("automation.enabledHintEvents")}
          value={routine.enabled}
          onChange={(enabled) => setRoutineEnabled(routine, enabled)}
        />
        <Info label={t("automation.tellMe")} value={t(NOTIFY_LABELS[routine.notify])} />
        <Info label={t("automation.keepOneChat")} value={routine.reuseConversation ? t("common:status.on") : t("common:status.off")} />
        <Info label={t("automation.logins")} value={routine.fillOnly ? t("automation.loginsFillOnly") : t("automation.loginsLikeAgent")} />
      </Group>

      <View>
        <SectionTitle title={shownEvents.length ? t("automation.recentEventsCount", { n: shownEvents.length }) : t("automation.recentEvents")} />
        {events.isLoading ? (
          <Card>
            <SkeletonRows count={3} avatar={28} />
          </Card>
        ) : events.isError ? (
          <ErrorState title={t("automation.eventsFailed")} error={errorText(events.error)} onRetry={() => void refetchEvents()} />
        ) : shownEvents.length === 0 ? (
          <EmptyEvents routine={routine} />
        ) : (
          <Card style={{ overflow: "hidden" }}>
            {shownEvents.map((e, i) => (
              <View key={e.id}>
                {i > 0 && <Hairline inset={space.lg + 28 + space.md} />}
                <EventRow event={e} onPress={e.runId ? () => openEvent(e) : undefined} />
              </View>
            ))}
          </Card>
        )}
        {shownEvents.length >= EVENT_LIMIT ? (
          <T variant="footnote" muted style={{ textAlign: "center", marginTop: space.sm }}>
            {t("automation.latestEvents", { count: EVENT_LIMIT })}
          </T>
        ) : null}
      </View>

      <Button title={t("automation.delete")} icon="trash" variant="danger" onPress={remove} />
    </ScrollView>
  );
}

function Info({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  const c = useColors();
  return (
    <View style={styles.info}>
      <T variant="footnote" muted>
        {label}
      </T>
      <T variant="callout" color={tone === "danger" ? c.danger : c.text}>
        {value}
      </T>
    </View>
  );
}

function EventRow({ event, onPress }: { event: AutomationEvent; onPress?: () => void }) {
  const c = useColors();
  const { t } = useTranslation("automations");
  const source = EVENT_SOURCES[event.source] ?? EVENT_SOURCES.manual;
  const status = EVENT_STATUS[event.status] ?? EVENT_STATUS.pending;
  return (
    <Pressable
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityHint={onPress ? t("automation.openRunChat") : undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.event, pressed && { backgroundColor: c.sunken }]}
    >
      <View style={[styles.eventIcon, { backgroundColor: c.sunken }]}>
        <Icon name={source.icon} size={13} color={c.textMuted} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <T variant="subhead" style={{ fontWeight: "500" }} numberOfLines={2}>
          {event.title || t(source.label)}
        </T>
        <Row style={{ gap: space.sm, flexWrap: "wrap" }}>
          <Badge label={t(status.label)} tone={status.tone} live={event.status === "running"} />
          <T variant="caption" muted>
            {t(source.label)} · {ago(event.createdAt)}
          </T>
        </Row>
        {event.note ? (
          <T variant="footnote" color={event.status === "failed" ? c.danger : c.textMuted}>
            {event.note}
          </T>
        ) : null}
      </View>
      {onPress ? <Icon name="chevron" size={11} color={c.textFaint} style={{ marginTop: 4 }} /> : null}
    </Pressable>
  );
}

function EmptyEvents({ routine }: { routine: Routine }) {
  const { t } = useTranslation("automations");
  const trigger = routine.trigger;
  const next = routine.enabled && routine.nextRunAt ? ago(routine.nextRunAt) : null;
  const copy =
    trigger.type === "schedule"
      ? { title: t("automation.empty.scheduleTitle"), body: next ? t("automation.empty.scheduleNext", { when: next }) : t("automation.empty.scheduleBody") }
      : trigger.type === "app"
        ? { title: t("automation.empty.appTitle"), body: t("automation.empty.appBody", { trigger: trigger.triggerName, app: appName(trigger.toolkit) }) }
        : trigger.type === "condition"
          ? { title: t("automation.empty.conditionTitle"), body: next ? t("automation.empty.conditionNext", { when: next }) : t("automation.empty.conditionBody") }
          : { title: t("automation.empty.webhookTitle"), body: t("automation.empty.webhookBody") };
  return <EmptyState icon="inbox" title={copy.title} body={copy.body} style={{ marginHorizontal: 0 }} />;
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  hero: {
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.md,
  },
  notice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  info: {
    gap: 2,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  text: {
    padding: space.lg,
  },
  event: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  eventIcon: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
